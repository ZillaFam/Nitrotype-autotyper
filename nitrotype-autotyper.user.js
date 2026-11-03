// ==UserScript==
// @name         Nitro Type Autotyper
// @namespace    https://github.com/ZillaFam/Nitrotype-autotyper
// @version      3.0.1
// @description  Types Nitro Type races for you: WPM and accuracy ranges, human-like rhythm and typos, nitros on the longest words, multi-race sessions with breaks, stats with Nitro Type's own results, and notifications.
// @homepageURL  https://github.com/ZillaFam/Nitrotype-autotyper
// @supportURL   https://github.com/ZillaFam/Nitrotype-autotyper/issues
// @updateURL    https://raw.githubusercontent.com/ZillaFam/Nitrotype-autotyper/HEAD/nitrotype-autotyper.user.js
// @downloadURL  https://raw.githubusercontent.com/ZillaFam/Nitrotype-autotyper/HEAD/nitrotype-autotyper.user.js
// @match        https://www.nitrotype.com/*
// @match        https://nitrotype.com/*
// @match        https://*.nitrotype.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * 1. Nitro Type ignores events that scripts create (event.isTrusted is
 *    false). Before any Nitro Type code runs (@run-at document-start) we wrap
 *    addEventListener and the on<event> properties so that, for events *this
 *    script* dispatched, listeners see isTrusted: true. Real events from you
 *    and the page's own events pass through untouched.
 * 2. The race text comes from the .dash-letter spans, the position from
 *    their classes (is-waiting / is-correct / is-typed).
 * 3. Each letter is keydown -> keypress -> (input) -> keyup, like a real key.
 *    Nitro Type stays on a letter after a wrong key, so a typo is a wrong
 *    key, a pause, then the right key. A nitro is Enter at the start of a word.
 * 4. A session runs N races: after each one it clicks "Race Again" (or
 *    reloads the race page if there's no button) and goes again.
 *
 * Frames: if the race is inside an iframe the script runs there too. The
 * panel and the session live in the top page; typing happens in whichever
 * frame has the race. They talk with postMessage.
 */

(() => {
  "use strict";
  if (window.__NT_AUTOTYPER__) return;
  window.__NT_AUTOTYPER__ = true;

  const VERSION = "3.0.1";
  const IS_TOP = window === window.top;
  // The trusted-key trick only covers listeners added after this script
  // runs. If the page had already loaded, Nitro Type's are in place.
  const LOADED_LATE = document.readyState !== "loading";
  const TAG = "nt-autotyper";
  const LOG = (...args) => console.debug("[NT Autotyper]", ...args);

  // =========================================================================
  // 1. Trusted-event shim. Must run before Nitro Type registers listeners.
  // =========================================================================

  const SPOOFED_TYPES = [
    "keydown", "keypress", "keyup", "beforeinput", "input", "textInput",
    "pointerdown", "mousedown", "pointerup", "mouseup", "click",
  ];
  const SPOOFED = new Set(SPOOFED_TYPES);
  const ourEvents = new WeakSet();
  const trustedViews = new WeakMap();
  const wrappedListeners = new WeakMap();

  function trustedView(event) {
    let view = trustedViews.get(event);
    if (!view) {
      view = new Proxy(event, {
        get(target, prop) {
          if (prop === "isTrusted") return true;
          const value = Reflect.get(target, prop, target);
          // Methods like preventDefault must run on the real event.
          return typeof value === "function" && prop !== "constructor" ? value.bind(target) : value;
        },
      });
      trustedViews.set(event, view);
    }
    return view;
  }

  function wrapListener(listener) {
    let wrapped = wrappedListeners.get(listener);
    if (!wrapped) {
      wrapped = function (event) {
        const ev = ourEvents.has(event) ? trustedView(event) : event;
        return typeof listener === "function" ? listener.call(this, ev) : listener.handleEvent(ev);
      };
      wrappedListeners.set(listener, wrapped);
    }
    return wrapped;
  }

  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (listener && SPOOFED.has(type)) listener = wrapListener(listener);
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (listener && SPOOFED.has(type)) listener = wrappedListeners.get(listener) ?? listener;
    return nativeRemove.call(this, type, listener, options);
  };

  // Same for handlers assigned as properties, e.g. document.onkeypress = fn.
  for (const proto of [HTMLElement.prototype, Document.prototype, window]) {
    for (const type of SPOOFED_TYPES) {
      const desc = Object.getOwnPropertyDescriptor(proto, `on${type}`);
      if (!desc?.set || !desc.configurable) continue;
      const originals = new WeakMap();
      Object.defineProperty(proto, `on${type}`, {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          return originals.has(this) ? originals.get(this) : desc.get.call(this);
        },
        set(fn) {
          originals.set(this, fn);
          desc.set.call(this, typeof fn === "function" ? wrapListener(fn) : fn);
        },
      });
    }
  }

  // Our own listeners use the native method so they see the real isTrusted.
  const listen = (target, type, fn, opts) => nativeAdd.call(target, type, fn, opts);

  // =========================================================================
  // 1b. Timers that keep full speed in a background tab
  // =========================================================================
  //
  // Chrome slows setTimeout in tabs you're not looking at (to about once a
  // second, and once a minute after a while), which would wreck the WPM and
  // stall sessions. Timers inside a Web Worker aren't throttled like that, so
  // all of the script's timing runs through one. If the page blocks workers,
  // it falls back to normal timers (then keep the tab visible).

  const timers = (() => {
    const pending = new Map(); // id -> { fn, due, native }
    let nextId = 1;
    let worker = null;

    const fire = (id) => {
      const t = pending.get(id);
      if (!t) return;
      pending.delete(id);
      t.fn();
    };
    const useNativeTimers = () => {
      if (!worker) return;
      worker = null;
      LOG("worker timers unavailable; background tabs will be throttled");
      for (const [id, t] of pending) {
        if (!t.native) t.native = window.setTimeout(() => fire(id), t.due - performance.now());
      }
    };

    try {
      const src = `const t = new Map();
        onmessage = (e) => {
          const [op, id, ms] = e.data;
          if (op === "set") t.set(id, setTimeout(() => { t.delete(id); postMessage(id); }, ms));
          else { clearTimeout(t.get(id)); t.delete(id); }
        };`;
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      worker.onmessage = (e) => fire(e.data);
      worker.onerror = useNativeTimers;
    } catch {
      worker = null;
    }

    return {
      get usingWorker() {
        return worker !== null;
      },
      set(fn, ms = 0) {
        const id = nextId++;
        const t = { fn, due: performance.now() + ms, native: 0 };
        pending.set(id, t);
        if (worker) worker.postMessage(["set", id, Math.max(0, ms)]);
        else t.native = window.setTimeout(() => fire(id), ms);
        return id;
      },
      clear(id) {
        const t = pending.get(id);
        if (!t) return;
        pending.delete(id);
        if (t.native) window.clearTimeout(t.native);
        else worker?.postMessage(["clear", id]);
      },
      every(fn, ms) {
        const loop = () => {
          timers.set(loop, ms);
          fn();
        };
        timers.set(loop, ms);
      },
    };
  })();

  // =========================================================================
  // 2. Keyboard knowledge (US QWERTY)
  // =========================================================================

  const SHIFTED = {
    "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
    "&": "7", "*": "8", "(": "9", ")": "0", _: "-", "+": "=", "{": "[",
    "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
  };
  // physical key code and legacy keyCode for each unshifted punctuation key
  const PUNCT = {
    "`": ["Backquote", 192], "-": ["Minus", 189], "=": ["Equal", 187],
    "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220],
    ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188],
    ".": ["Period", 190], "/": ["Slash", 191],
  };
  const ROWS = ["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"];
  const ROW_OFFSET = [0, 0.5, 0.75, 1.25];
  const LEFT_HAND = new Set("`12345qwertasdfgzxcvb");

  const KEY_POS = new Map();
  ROWS.forEach((row, r) => [...row].forEach((ch, c) => KEY_POS.set(ch, { r, x: c + ROW_OFFSET[r] })));

  function neighbours(base) {
    const p = KEY_POS.get(base);
    if (!p) return [];
    const out = [];
    for (const [ch, q] of KEY_POS) {
      if (ch !== base && Math.abs(q.r - p.r) <= 1 && Math.abs(q.x - p.x) <= 1.1) out.push(ch);
    }
    return out;
  }

  const baseKey = (ch) => SHIFTED[ch] ?? ch.toLowerCase();

  /** { key, code, keyCode, shift } for the key that types `ch`. */
  function keyFor(ch) {
    if (ch === " ") return { key: " ", code: "Space", keyCode: 32, shift: false };
    if (ch === "\n") return { key: "Enter", code: "Enter", keyCode: 13, shift: false };
    const lower = ch.toLowerCase();
    if (lower.length === 1 && lower >= "a" && lower <= "z") {
      const upper = lower.toUpperCase();
      return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), shift: ch !== lower };
    }
    if (ch >= "0" && ch <= "9") return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), shift: false };
    if (PUNCT[ch]) return { key: ch, code: PUNCT[ch][0], keyCode: PUNCT[ch][1], shift: false };
    const base = SHIFTED[ch];
    if (base !== undefined) {
      if (base >= "0" && base <= "9") return { key: ch, code: `Digit${base}`, keyCode: base.charCodeAt(0), shift: true };
      return { key: ch, code: PUNCT[base][0], keyCode: PUNCT[base][1], shift: true };
    }
    return { key: ch, code: "", keyCode: 0, shift: ch !== ch.toLowerCase() };
  }

  /** A neighbouring-key typo for `ch`, or null. */
  function neighbourTypo(ch) {
    if (ch === " " || ch === "\n") return null;
    const base = baseKey(ch);
    const near = neighbours(base);
    if (!near.length) return null;
    const letters = near.filter((c) => c >= "a" && c <= "z");
    const pool = base >= "a" && base <= "z" && letters.length ? letters : near;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return ch !== ch.toLowerCase() ? pick.toUpperCase() : pick;
  }

  /**
   * The wrong key a person might hit instead of text[i]: the next letter
   * too early (fingers out of order), the previous key again (double tap),
   * or most often a neighbouring key.
   */
  function makeTypo(text, i) {
    const ch = text[i];
    const prev = text[i - 1];
    const next = text[i + 1];
    const r = Math.random();
    if (r < 0.25 && next && next !== " " && next !== ch) return next;
    if (r < 0.4 && prev && prev !== " " && prev !== ch) return prev;
    return neighbourTypo(ch);
  }

  // =========================================================================
  // 3. Synthesising input
  // =========================================================================

  function fire(target, event) {
    ourEvents.add(event);
    return target.dispatchEvent(event);
  }

  function withLegacyCodes(event, keyCode, charCode) {
    // keyCode/which/charCode can't be set through the constructor.
    for (const [prop, value] of [["keyCode", keyCode], ["which", keyCode || charCode], ["charCode", charCode]]) {
      Object.defineProperty(event, prop, { get: () => value });
    }
    return event;
  }

  function fireKey(target, type, k, keyCode, charCode) {
    const init = { key: k.key, code: k.code, shiftKey: k.shift, bubbles: true, cancelable: true, composed: true, view: window };
    return fire(target, withLegacyCodes(new KeyboardEvent(type, init), keyCode, charCode));
  }

  function insertText(target, ch) {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const init = { inputType: "insertText", data: ch, bubbles: true, composed: true };
    if (!fire(target, new InputEvent("beforeinput", { ...init, cancelable: true }))) return;
    // Use the native setter so React-controlled inputs notice the change.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set;
    if (setter) setter.call(target, target.value + ch);
    else target.value += ch;
    fire(target, new InputEvent("input", init));
  }

  let panelHost = null; // set in the top page once the panel is built

  function typingTarget() {
    const active = document.activeElement;
    if (active && active !== panelHost && active !== document.body && active !== document.documentElement) {
      return active;
    }
    return document.querySelector(".dash-copy-input, .dash input, input.race-input") ?? document.body;
  }

  // Take focus off the control panel so keys go to the race.
  function focusRace() {
    if (panelHost && document.activeElement === panelHost) panelHost.shadowRoot.activeElement?.blur();
    const target = typingTarget();
    if (target !== document.body) target.focus?.({ preventScroll: true });
  }

  function pressKey(ch, holdMs) {
    const target = typingTarget();
    const k = keyFor(ch);
    const shiftKey = { key: "Shift", code: LEFT_HAND.has(baseKey(ch)) ? "ShiftRight" : "ShiftLeft", shift: true };
    if (k.shift) fireKey(target, "keydown", shiftKey, 16, 0);
    if (fireKey(target, "keydown", k, k.keyCode, 0)) {
      const charCode = ch === "\n" ? 13 : ch.charCodeAt(0);
      if (fireKey(target, "keypress", k, charCode, charCode) && ch !== "\n") insertText(target, ch);
    }
    timers.set(() => {
      fireKey(target, "keyup", k, k.keyCode, 0);
      if (k.shift) fireKey(target, "keyup", { ...shiftKey, shift: false }, 16, 0);
    }, holdMs);
  }

  function clickElement(el) {
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width * (0.3 + Math.random() * 0.4),
      clientY: r.top + r.height * (0.3 + Math.random() * 0.4),
    };
    fire(el, new PointerEvent("pointerdown", { ...init, pointerType: "mouse", isPrimary: true }));
    fire(el, new MouseEvent("mousedown", init));
    fire(el, new PointerEvent("pointerup", { ...init, pointerType: "mouse", isPrimary: true }));
    fire(el, new MouseEvent("mouseup", init));
    fire(el, new MouseEvent("click", init));
  }

  // =========================================================================
  // 4. Reading the race
  // =========================================================================

  /** { text, pos, id, firstClass } or null. pos is null when the classes give no clue. */
  function readRace() {
    const spans = document.querySelectorAll(".dash-letter");
    if (!spans.length) return null;
    let text = "";
    let waiting = -1;
    let typed = 0;
    for (const span of spans) {
      const ch = span.textContent.replace(/ /g, " ");
      if (ch.length !== 1) continue; // skips the finish-flag emoji and empties
      const cls = typeof span.className === "string" ? span.className : "";
      if (waiting < 0 && /\bis-(waiting|current|active)\b/.test(cls)) waiting = text.length;
      if (/\bis-(correct|typed)\b/.test(cls)) typed++;
      text += ch;
    }
    if (!text) return null;
    const pos = waiting >= 0 ? waiting : typed > 0 ? typed : null;
    return { text, pos, id: spans[0], firstClass: spans[0].className };
  }

  // Same race = same text. (Not the same <span> elements: Nitro Type may
  // redraw the letters mid-race, and that must not look like a new race.)
  const sameRace = (a, b) => Boolean(a && b && a.text === b.text);
  const isDone = (race) => Boolean(race && race.pos !== null && race.pos >= race.text.length);
  // How long the race may be missing or different before we believe it's gone.
  const GONE_MS = 2500;

  /** Word start indexes of the `count` longest words (ties: earlier first). */
  function nitroWordStarts(text, count) {
    if (count <= 0) return new Set();
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) words.push({ start: m.index, len: m[0].length });
    words.sort((a, b) => b.len - a.len || a.start - b.start);
    return new Set(words.slice(0, count).map((w) => w.start));
  }

  function findRaceAgainButton() {
    // Score each visible button: on the results screen, and labelled exactly
    // "Race Again", beats a vaguer label elsewhere. Site menus (nav, header,
    // footer) are never used: a "New Race" menu link would leave mid-race.
    const results = document.querySelector(".race-results, .raceResults");
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll("button, a, [role=button]")) {
      if (el.closest("nav, header, footer") || !el.getClientRects().length) continue;
      const label = (el.textContent || el.getAttribute("aria-label") || "").trim();
      if (!/race again|next race|play again|new race/i.test(label)) continue;
      const score = 1 + (/race again/i.test(label) ? 2 : 0) + (results?.contains(el) ? 4 : 0);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  // Visible text of an element, with spaces between separate bits of text.
  function textOf(el) {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode.nodeValue.trim();
      if (t) parts.push(t);
    }
    return parts.join(" ").replace(/\s+/g, " ");
  }

  /** Small blocks of text that mention both WPM and accuracy, smallest first. */
  function resultCandidates() {
    const out = [];
    for (const el of document.querySelectorAll("div, section, table, ul, dl")) {
      if (el.closest(".dash-copy") || el === panelHost) continue;
      const raw = el.textContent;
      if (raw.length > 800 || !/wpm/i.test(raw) || !/acc/i.test(raw)) continue;
      out.push({ el, text: textOf(el) });
    }
    return out.sort((a, b) => a.text.length - b.text.length);
  }

  const toNumber = (str) => (str === undefined ? undefined : Number(str.replace(/,/g, "")));

  /** { wpm, accuracy, place, money, xp } from a results text; missing ones undefined. */
  function parseResults(text) {
    const pick = (...res) => {
      for (const re of res) {
        const m = text.match(re);
        if (m) return m[1];
      }
      return undefined;
    };
    const wpm = toNumber(pick(/(\d{1,3}(?:\.\d+)?)\s*WPM/i, /WPM\s*:?\s*(\d{1,3}(?:\.\d+)?)/i));
    const accuracy = toNumber(pick(/(\d{1,3}(?:\.\d+)?)\s*%\s*acc/i, /acc(?:uracy)?\s*:?\s*(\d{1,3}(?:\.\d+)?)\s*%/i));
    return {
      wpm: wpm > 0 && wpm < 500 ? wpm : undefined,
      accuracy: accuracy > 0 && accuracy <= 100 ? accuracy : undefined,
      // "2nd", or "2 nd" when the suffix is a separate <sup>.
      place: toNumber(pick(/\b(\d{1,2})\s?(?:st|nd|rd|th)\b/i)),
      money: toNumber(pick(/\$\s*([\d,]+)/)),
      xp: toNumber(pick(/\+?([\d,]+)\s*XP\b/i, /\bXP\s*:?\s*\+?([\d,]+)/i)),
    };
  }

  /**
   * Nitro Type's "Currently in a Race" popup: you left a race before it ended
   * and have to wait until it disqualifies you. Returns its "Try Again"
   * button (or null if the popup has none), or undefined when there's no popup.
   */
  let stuckCheck = { at: 0, seen: false };
  function findStuckPopup() {
    // Visible text only (innerText skips <script> contents, which can contain
    // the same words), and at most once a second since it's not cheap.
    const now = Date.now();
    if (now - stuckCheck.at > 1000) {
      stuckCheck = { at: now, seen: Boolean(document.body && /currently in a race/i.test(document.body.innerText)) };
    }
    if (!stuckCheck.seen) return undefined;
    const buttons = [...document.querySelectorAll("button, a, [role=button]")];
    return buttons.find((b) => /try again/i.test(b.textContent) && b.getClientRects().length) ?? null;
  }

  // =========================================================================
  // 5. Human rhythm
  // =========================================================================

  const COMMON_BIGRAMS = new Set(
    "th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur".split(" "),
  );

  /** How long letter i takes relative to the average (before normalising). */
  function rhythmFactor(text, i) {
    const ch = text[i];
    const prev = text[i - 1] ?? " ";
    const progress = i / text.length;
    let f = 1;
    if (ch === " ") f *= 0.85;
    else if (prev === " ") f *= 1.2; // starting a new word
    if (ch !== ch.toLowerCase()) f *= 1.45; // reach for Shift
    else if (ch >= "0" && ch <= "9") f *= 1.5;
    else if (/[^a-z ]/.test(ch)) f *= 1.35; // punctuation
    if (prev === ch) f *= 0.8; // double letters roll
    else if (COMMON_BIGRAMS.has((prev + ch).toLowerCase())) f *= 0.8;
    if (progress < 0.05) f *= 1.4 - (progress / 0.05) * 0.4; // warming up
    else if (progress > 0.9) f *= 0.9; // final push
    return f;
  }

  function rhythmFor(text) {
    const factors = [...text].map((_, i) => rhythmFactor(text, i));
    const mean = factors.reduce((a, b) => a + b, 0) / factors.length;
    return factors.map((f) => f / mean);
  }

  // =========================================================================
  // 6. Typing engine (runs in every frame; types the race in its own frame)
  // =========================================================================

  const REACTION_MS = [140, 320]; // pause after a typo before the right key
  const HESITATE_CHANCE = 0.04; // chance of a short "thinking" pause before a word
  const HESITATE_MS = [150, 450];
  const PROBE_MS = 120; // how often to try the first key while waiting for GO
  const MAX_WAIT_MS = 90000; // give up waiting for GO after this long
  const RETRY_MS = 250; // re-send a key Nitro Type didn't take after this long
  const NITRO_WAIT_MS = 350; // how long to wait for a nitro to kick in
  const STALL_MS = 5000;
  const PACE_GAIN = 0.3;

  const sleep = (ms) => new Promise((r) => timers.set(r, Math.max(0, ms)));
  const rand = (a, b) => a + Math.random() * (b - a);
  function gaussian() {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }

  // Typo chance per letter. Accuracy = right keys / all keys; spaces (about
  // 1 key in 6) never get typos here, hence the 1.2.
  const typoChance = (acc) => (acc >= 100 ? 0 : Math.min(0.5, (100 / acc - 1) * 1.2));

  const engine = {
    settings: null,
    armed: false, // part of an active session: type every new race
    running: false,
    runId: 0,
    lastRace: null, // the race we last typed (or were stopped in)
    lastRaceFinished: false, // ...and whether we crossed the finish line in it
    stuckTimer: 0, // pending "Try Again" click on the "Currently in a Race" popup
    lastLiveAt: 0,

    status(message, extra = {}) {
      toTop({ kind: "status", status: { running: this.running, message, hasRace: Boolean(readRace()), ...extra } });
    },

    setArmed(armed) {
      if (armed === this.armed) return;
      this.armed = armed;
      if (armed) {
        // A fresh start resumes an unfinished race, but skips a finished one.
        const race = readRace();
        this.lastRaceFinished = isDone(race);
        this.lastRace = this.lastRaceFinished ? race : null;
      } else if (this.running) {
        this.abort("Stopped");
      }
    },

    abort(message) {
      this.runId++;
      this.running = false;
      const race = readRace();
      if (race) {
        this.lastRace = race;
        this.lastRaceFinished = isDone(race);
      }
      this.status(message);
    },

    tick() {
      if (!this.armed || this.running || !this.settings) return;
      const stuck = findStuckPopup();
      if (stuck !== undefined) return this.handleStuck(stuck);
      const race = readRace();
      if (!race) return;
      // A new race: different text, or the same text again after we finished.
      const fresh = !sameRace(race, this.lastRace) || (this.lastRaceFinished && !isDone(race));
      if (!fresh) return;
      if (isDone(race)) {
        // Joined on a results screen: move on to the next race.
        this.lastRace = race;
        this.lastRaceFinished = true;
        toTop({ kind: "needNext" });
        return;
      }
      this.run(race).catch((err) => {
        console.error("[NT Autotyper]", err);
        this.running = false;
        this.status(`Error: ${err.message}`);
      });
    },

    // Wait out the "Currently in a Race" popup, then press its Try Again.
    handleStuck(tryAgain) {
      if (this.stuckTimer) return;
      const wait = rand(20000, 30000);
      toTop({ kind: "say", message: `Nitro Type says you're still in your last race. Trying again in ${Math.round(wait / 1000)}s…` });
      toTop({ kind: "raceSeen" }); // nothing to reload: just wait
      this.stuckTimer = timers.set(() => {
        this.stuckTimer = 0;
        const button = findStuckPopup();
        if (button) {
          LOG("clicking Try Again");
          clickElement(button);
        } else if (button === null && tryAgain === null) {
          toTop({ kind: "say", message: "Nitro Type says you're still in your last race. Waiting…" });
        }
      }, wait);
    },

    async run(startRace) {
      const id = ++this.runId;
      const alive = () => id === this.runId;
      this.running = true;
      this.lastRace = startRace;
      this.lastRaceFinished = false;
      toTop({ kind: "raceSeen" }); // a race is on screen: no reload needed
      // The race can blink out (Nitro Type redrawing it). Only after it's been
      // gone or different for GONE_MS do we give up on it.
      let goneSince = 0;
      const stillHere = (r) => {
        if (sameRace(r, startRace)) {
          goneSince = 0;
          return true;
        }
        goneSince ||= performance.now();
        return performance.now() - goneSince < GONE_MS;
      };

      const s = this.settings;
      const text = startRace.text;
      const lo = Math.min(s.wpmMin, s.wpmMax);
      const hi = Math.max(s.wpmMin, s.wpmMax);
      const target = Math.min(hi, Math.floor(rand(lo, hi + 1)));
      // Accuracy for this race, somewhere in the range (to 0.1%).
      const accTarget = Math.round(rand(Math.min(s.accMin, s.accMax), Math.max(s.accMin, s.accMax)) * 10) / 10;
      const rhythm = rhythmFor(text);
      const nitroAt = nitroWordStarts(text, s.nitros);
      LOG("race text:", text);
      LOG("letter classes:", [...document.querySelectorAll(".dash-letter")].slice(0, 3).map((el) => el.className));
      LOG("target WPM:", target, "accuracy:", accTarget, "nitro words at:", [...nitroAt]);
      this.dbg = { sent: 0, typos: 0, nitrosTried: 0, nitrosUsed: 0, target, accTarget };
      this.watchResults.snapshot(); // what's on screen before the race
      focusRace();

      // Wait for GO: keep trying the first key until Nitro Type takes it.
      this.status("Waiting for the race to start…", { target });
      const waitStart = performance.now();
      let race = startRace;
      while (alive()) {
        const seen = readRace();
        if (!stillHere(seen)) return this.finishRun(id, "Race closed");
        if (!sameRace(seen, startRace)) {
          await sleep(50);
          continue;
        }
        race = seen;
        if (race.pos !== null && race.pos > 0) break;
        if (race.pos === null && race.firstClass !== startRace.firstClass) {
          // Something changed, but not in a way we understand: don't keep
          // hammering the first key into a running race.
          return this.finishRun(id, "Can't read the race progress (Nitro Type changed its page?)");
        }
        if (performance.now() - waitStart > MAX_WAIT_MS) return this.finishRun(id, "Race didn't start");
        pressKey(text[0], rand(40, 90));
        await sleep(PROBE_MS);
      }
      if (!alive()) return;
      toTop({ kind: "raceStart" });

      const startedAt = performance.now() - PROBE_MS / 2;
      let correct = race.pos; // the probe that got through
      let wrong = 0;
      let nitrosUsed = 0;
      let skipped = 0; // letters skipped by nitros (not counted for pacing)
      let pendingNitro = -1;
      const triedNitro = new Set();
      let pace = null;
      let lastPos = -1;
      let lastPressAt = 0;
      let lastPressPos = -1;
      let lastProgressAt = performance.now();
      let lastTypoPos = -1;
      let nextAt = performance.now();

      while (alive()) {
        await sleep(nextAt - performance.now());
        if (!alive()) return;
        const seen = readRace();
        if (!stillHere(seen)) return this.finishRun(id, "Race closed");
        if (!sameRace(seen, startRace)) {
          nextAt = performance.now() + 50; // blinked out: look again shortly
          continue;
        }
        race = seen;
        const now = performance.now();
        const pos = race.pos;

        if (pos === null || pos >= text.length) {
          const minutes = (now - startedAt) / 60000;
          return this.finishRun(id, "Race finished", {
            wpm: text.length / 5 / minutes,
            accuracy: (100 * correct) / Math.max(1, correct + wrong),
            nitros: nitrosUsed,
            target,
            accTarget,
            chars: text.length,
            at: Date.now(),
          });
        }

        if (pendingNitro >= 0) {
          if (pos > pendingNitro) {
            nitrosUsed++;
            this.dbg.nitrosUsed++;
            skipped += pos - pendingNitro;
          } else if (now - lastPressAt < NITRO_WAIT_MS) {
            nextAt = now + 15;
            continue;
          }
          pendingNitro = -1; // didn't work (none left?): type the word instead
        }

        if (pos !== lastPos) {
          lastPos = pos;
          lastProgressAt = now;
        } else if (now - lastProgressAt > STALL_MS) {
          return this.finishRun(id, "Stopped: Nitro Type isn't accepting keys");
        } else if (pos === lastPressPos && now - lastPressAt < RETRY_MS) {
          nextAt = now + 10; // last key not registered yet
          continue;
        }

        if (now - this.lastLiveAt > 250) {
          this.lastLiveAt = now;
          const liveWpm = (pos - skipped) / 5 / ((now - startedAt) / 60000);
          this.status("Typing…", { target, pos, len: text.length, wpm: liveWpm, nitros: nitrosUsed });
        }

        // Nitro at the start of one of the longest words.
        if (nitroAt.has(pos) && !triedNitro.has(pos)) {
          triedNitro.add(pos);
          this.dbg.nitrosTried++;
          pressKey("\n", rand(40, 90));
          pendingNitro = pos;
          lastPressAt = now;
          nextAt = now + 30;
          continue;
        }

        const { variance } = this.settings;
        const pTypo = typoChance(accTarget);
        const perChar = 12000 / target; // 60 s / (wpm * 5 chars)
        const interval = Math.max(5, (perChar - (pTypo * (REACTION_MS[0] + REACTION_MS[1])) / 2) / (1 + pTypo));

        // Sometimes hit the wrong key first, then (after a beat) the right one.
        if (lastTypoPos !== pos && Math.random() < pTypo) {
          lastTypoPos = pos;
          const typo = makeTypo(text, pos);
          if (typo) {
            pressKey(typo, rand(40, 100));
            wrong++;
            this.dbg.typos++;
            this.dbg.sent++;
            nextAt = now + rand(REACTION_MS[0], REACTION_MS[1]);
            continue;
          }
        }

        pressKey(text[pos], rand(40, 100));
        correct++;
        this.dbg.sent++;
        lastPressAt = now;
        lastPressPos = pos;

        // Steer toward the target WPM from real progress (nitros excluded).
        const typedSoFar = pos - skipped;
        if (!pace) pace = { at: now, typed: typedSoFar };
        const behindMs = now - pace.at - (typedSoFar - pace.typed) * perChar;
        const correction = Math.min(1.5 * interval, Math.max(-0.6 * interval, -behindMs * PACE_GAIN));
        const jitter = Math.min(2.5, Math.max(0.35, 1 + gaussian() * (variance / 100)));
        let gap = interval * (rhythm[pos + 1] ?? 1) * jitter + correction;
        if (text[pos] === " " && Math.random() < HESITATE_CHANCE) gap += rand(HESITATE_MS[0], HESITATE_MS[1]);
        nextAt = Math.max(nextAt, now - interval) + Math.max(2, gap);
      }
    },

    finishRun(id, message, result) {
      if (id !== this.runId) return;
      this.running = false;
      this.status(message, result ? { target: result.target, wpm: result.wpm, done: true } : {});
      if (result) {
        this.lastRaceFinished = true;
        toTop({ kind: "raceDone", result });
        this.watchResults.start(result.at);
      } else {
        toTop({ kind: "raceFailed", message });
      }
    },

    // ---- Nitro Type's own results ------------------------------------------
    //
    // After the finish line Nitro Type shows its official WPM, accuracy,
    // place, money and XP. We don't know its exact markup, so we look for a
    // small block of text that mentions both "WPM" and accuracy and wasn't
    // on screen before the race (so a "your average WPM" widget doesn't count).
    watchResults: {
      before: new Set(),
      found: null,
      snapshot() {
        this.before = new Set(resultCandidates().map((c) => c.text));
        this.found = null;
      },
      start(raceAt) {
        const startedAt = Date.now();
        const poll = () => {
          const fresh = resultCandidates().filter((c) => !this.before.has(c.text));
          const official = fresh.map((c) => ({ ...parseResults(c.text), text: c.text })).find((r) => r.wpm);
          if (official) {
            this.found = official;
            LOG("Nitro Type results:", official);
            toTop({ kind: "raceResult", at: raceAt, official });
          } else if (Date.now() - startedAt < 10000) {
            timers.set(poll, 400);
          } else {
            this.found = { notFound: true };
          }
        };
        timers.set(poll, 300);
      },
    },

    // What the debug view shows for this frame.
    debugInfo() {
      const race = readRace();
      const spans = document.querySelectorAll(".dash-letter");
      const d = this.dbg ?? {};
      const target = typingTarget();
      const found = this.watchResults.found;
      return {
        frame: IS_TOP ? "top page" : `iframe ${location.host}${location.pathname}`,
        race: race ? `${race.text.length} letters, at ${race.pos ?? "?"}` : "no .dash-letter spans",
        text: race ? `${race.text.slice(0, 48)}…` : "",
        classes: [...spans].slice(0, 3).map((el) => el.className).join(" | ") || "-",
        current: document.querySelector(".dash-letter.is-waiting")?.className ?? "-",
        keys: d.sent === undefined ? "-" : `${d.sent} sent, ${d.typos} typos (target ${d.target} WPM, ${d.accTarget}%)`,
        nitros: d.sent === undefined ? "-" : `${d.nitrosUsed} used / ${d.nitrosTried} tried`,
        typingInto: `${target.tagName.toLowerCase()}${target.className && typeof target.className === "string" ? "." + target.className.trim().split(/\s+/).join(".") : ""}`,
        raceAgain: findRaceAgainButton()?.textContent.trim() || "no button found",
        results: !found ? "-" : found.notFound ? "not found on screen" : `${found.wpm} WPM, ${found.accuracy ?? "?"}%, place ${found.place ?? "?"}, $${found.money ?? "?"}, ${found.xp ?? "?"} XP`,
        timers: timers.usingWorker ? "worker (full speed in background)" : "page timers (slowed in background)",
      };
    },

    // Only ever leave a race we finished and that's still showing its
    // results. Never in the middle of a race, a lobby or a countdown.
    onResultsScreen() {
      const race = readRace();
      return !this.running && this.lastRaceFinished && isDone(race) && sameRace(race, this.lastRace);
    },

    nextRace() {
      if (!this.onResultsScreen()) return;
      const button = findRaceAgainButton();
      if (button) {
        LOG("clicking", button.textContent.trim());
        clickElement(button);
      }
    },

    reloadRace() {
      if (!this.onResultsScreen()) return;
      LOG("no new race after Race Again: reloading the race page");
      location.reload();
    },
  };

  timers.every(() => engine.tick(), 250);
  timers.every(() => {
    if (engine.settings?.debug && (IS_TOP || readRace())) toTop({ kind: "debug", info: engine.debugInfo() });
  }, 1000);

  // Safety stop and shortcut, in every frame.
  const isShortcut = (e) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyA";
  listen(
    window,
    "keydown",
    (e) => {
      if (!e.isTrusted) return;
      if (isShortcut(e)) {
        e.preventDefault();
        toTop({ kind: "toggle" });
        return;
      }
      if (!engine.running) return;
      const path = e.composedPath();
      if (panelHost && path.includes(panelHost) && path[0].tagName === "INPUT") return; // editing a setting
      if (e.altKey || e.ctrlKey || e.metaKey || ["Shift", "Alt", "Control", "Meta", "CapsLock"].includes(e.key)) return;
      engine.abort("Stopped: you pressed a key");
      toTop({ kind: "stop", message: "Stopped: you pressed a key" });
    },
    true,
  );

  // =========================================================================
  // 7. Messaging between frames
  // =========================================================================

  // down: top page -> every engine. up: any engine -> top page.
  function toFrames(msg, win = window) {
    for (let i = 0; i < win.frames.length; i++) {
      try {
        win.frames[i].postMessage({ tag: TAG, dir: "down", ...msg }, "*");
      } catch {
        /* frame went away */
      }
    }
  }

  function toEngines(msg) {
    engineHandle(msg);
    toFrames(msg);
  }

  function toTop(msg) {
    if (IS_TOP) topHandle(msg, window);
    else window.top.postMessage({ tag: TAG, dir: "up", ...msg }, "*");
  }

  function engineHandle(msg) {
    if (msg.settings) engine.settings = msg.settings;
    if (typeof msg.armed === "boolean") engine.setArmed(msg.armed);
    if (msg.cmd === "next") engine.nextRace();
    if (msg.cmd === "reload") engine.reloadRace();
  }

  listen(window, "message", (e) => {
    const data = e.data;
    if (!data || data.tag !== TAG) return;
    if (data.dir === "down") {
      engineHandle(data);
      toFrames(data); // pass it on to nested frames
    } else if (data.dir === "up" && IS_TOP) {
      topHandle(data, e.source);
    }
  });

  // =========================================================================
  // 8. Settings, session and stats (top page)
  // =========================================================================

  const DEFAULTS = {
    wpmMin: 80, wpmMax: 95, accMin: 96, accMax: 98, variance: 25, nitros: 1, races: 5,
    breakEvery: 0, breakLenMin: 1, breakLenMax: 3, // long break every ~N races (0 = off), minutes
    notify: false, debug: false,
  };
  const LIMITS = {
    wpmMin: [10, 300], wpmMax: [10, 300], accMin: [80, 100], accMax: [80, 100], variance: [0, 60],
    nitros: [0, 10], races: [1, 500], breakEvery: [0, 100], breakLenMin: [0.1, 30], breakLenMax: [0.1, 30],
  };
  // Settings that come as a min/max pair.
  const PAIRS = { wpmMin: "wpmMax", accMin: "accMax", breakLenMin: "breakLenMax" };
  const KEYS = { settings: "nt-autotyper-settings", stats: "nt-autotyper-stats", ui: "nt-autotyper-ui", session: "nt-autotyper-session" };

  function readJSON(storage, key, fallback) {
    try {
      return JSON.parse(storage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function writeJSON(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage blocked: keep it in memory only */
    }
  }

  function normalize(raw) {
    raw = { ...raw };
    // Older versions had a single accuracy value.
    if (raw.accuracy !== undefined && raw.accMin === undefined) raw.accMin = raw.accMax = raw.accuracy;
    delete raw.accuracy;
    const s = { ...DEFAULTS, ...raw };
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const n = Number(s[key]);
      s[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULTS[key];
    }
    for (const key of ["wpmMin", "wpmMax", "nitros", "races", "variance", "breakEvery"]) s[key] = Math.round(s[key]);
    for (const key of ["accMin", "accMax"]) s[key] = Math.round(s[key] * 2) / 2;
    for (const key of ["breakLenMin", "breakLenMax"]) s[key] = Math.round(s[key] * 10) / 10;
    s.notify = Boolean(s.notify);
    s.debug = Boolean(s.debug);
    return s;
  }

  const loadSettings = () => normalize(readJSON(localStorage, KEYS.settings, {}));
  engine.settings = loadSettings(); // same-origin frames share localStorage

  // The session lives in sessionStorage so it survives a reload of this tab
  // (used to get a fresh race) but never restarts by itself in a new tab.
  const session = {
    // sinceBreak/breakAfter: races since the last long break, and how many to
    // run before the next one. breakUntil: end of the current break (ms).
    state: { active: false, total: 0, done: 0, sinceBreak: 0, breakAfter: 0, breakUntil: 0 },
    debug: new Map(), // frame window -> latest debug snapshot
    stats: [], // finished races, newest last
    fallbackTimer: 0,
    nextTimer: 0,
    message: "Idle",
    messageAt: 0,

    say(message) {
      this.message = message;
      this.messageAt = Date.now();
      panel.render();
      updateTitle();
    },
    init() {
      if (LOADED_LATE) {
        this.message = 'Loaded late, so it may not type. In Tampermonkey settings set Content Script API to "UserScripts API Dynamic", then reload.';
      }
      this.state = { ...this.state, ...readJSON(sessionStorage, KEYS.session, {}) };
      this.stats = readJSON(localStorage, KEYS.stats, []);
    },
    save() {
      writeJSON(sessionStorage, KEYS.session, this.state);
    },
    onBreak() {
      return this.state.active && Date.now() < this.state.breakUntil;
    },
    sync() {
      // Engines stay disarmed during a break, even if a race shows up.
      toEngines({ settings: loadSettings(), armed: this.state.active && !this.onBreak() });
    },
    pickBreakAfter(s) {
      if (!s.breakEvery) return 0;
      // Roughly every N races, +/- 20%, so breaks don't land like clockwork.
      return Math.max(1, Math.round(s.breakEvery * rand(0.8, 1.2)));
    },
    start() {
      const s = loadSettings();
      this.state = { active: true, total: s.races, done: 0, sinceBreak: 0, breakAfter: this.pickBreakAfter(s), breakUntil: 0 };
      this.save();
      this.sync();
      this.say("Waiting for a race…");
    },
    stop(message) {
      timers.clear(this.fallbackTimer);
      timers.clear(this.nextTimer);
      this.state.active = false;
      this.save();
      this.sync();
      this.state.breakUntil = 0;
      // Leave a mark in the tab title (and maybe a notification) if you
      // weren't watching.
      const away = document.hidden || !document.hasFocus();
      if (document.hidden) titleFlash = message.startsWith("Done") ? `✓ ${message}` : `■ ${message}`;
      if (away && !message.includes("you pressed")) notify(message);
      this.say(message);
    },
    toggle() {
      if (this.state.active) this.stop("Stopped");
      else this.start();
    },
    raceStarted() {
      timers.clear(this.fallbackTimer);
    },
    raceDone(result) {
      this.stats.push(result);
      if (this.stats.length > 300) this.stats.splice(0, this.stats.length - 300);
      writeJSON(localStorage, KEYS.stats, this.stats);
      if (!this.state.active) return panel.render();
      this.state.done++;
      this.state.sinceBreak++;
      this.save();
      if (this.state.done >= this.state.total) {
        this.stop(`Done: ${this.state.total} race${this.state.total === 1 ? "" : "s"}`);
        return;
      }
      const s = loadSettings();
      if (this.state.breakAfter && this.state.sinceBreak >= this.state.breakAfter) {
        const ms = rand(Math.min(s.breakLenMin, s.breakLenMax), Math.max(s.breakLenMin, s.breakLenMax)) * 60000;
        this.state.breakUntil = Date.now() + ms;
        this.state.sinceBreak = 0;
        this.state.breakAfter = this.pickBreakAfter(s);
        this.save();
        this.sync();
        this.tickBreak();
        this.scheduleNext(ms);
      } else {
        this.say("Next race soon…");
        this.scheduleNext(rand(2500, 6000));
      }
    },
    tickBreak() {
      if (!this.onBreak()) return;
      const left = Math.ceil((this.state.breakUntil - Date.now()) / 1000);
      this.say(`On a break · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`);
    },
    raceFailed(message) {
      if (!this.state.active) return;
      // Problems that won't fix themselves end the session (and notify you).
      if (/^(Stopped|Can't|Race didn't)/.test(message)) this.stop(message);
      // The race went away mid-race: just wait for the next one to show up.
      // (Never reload here: leaving a race early gets you the "Currently in a
      // Race" lock-out.)
      else this.say("Race closed. Waiting for the next race…");
    },
    attachOfficial(at, official) {
      const race = this.stats.find((r) => r.at === at);
      if (!race) return;
      race.official = { wpm: official.wpm, accuracy: official.accuracy, place: official.place, money: official.money, xp: official.xp };
      writeJSON(localStorage, KEYS.stats, this.stats);
      panel.render();
    },
    scheduleNext(delay) {
      timers.clear(this.nextTimer);
      this.nextTimer = timers.set(() => {
        if (!this.state.active) return;
        if (this.state.breakUntil) {
          this.state.breakUntil = 0;
          this.save();
          this.sync();
          this.say("Back from the break…");
        }
        toEngines({ cmd: "next" });
        // Still on the results screen 15 s later (no button found?): reload.
        // Engines only do that if the finished race is still on screen, never
        // once a new race (or its lobby) has appeared.
        timers.clear(this.fallbackTimer);
        this.fallbackTimer = timers.set(() => this.state.active && toEngines({ cmd: "reload" }), 15000);
      }, delay);
    },
    resetStats() {
      this.stats = [];
      writeJSON(localStorage, KEYS.stats, this.stats);
      panel.render();
    },
  };

  // Progress in the tab title, so you can follow a background tab:
  // "▶ 2/5 · Nitro Type", then "✓ Done: 5 races · …" until you look at it.
  const TITLE_PREFIX = /^(?:[▶✓■]|❚❚) [^·]* · /;
  let titleFlash = "";
  function updateTitle() {
    if (!IS_TOP) return;
    const base = document.title.replace(TITLE_PREFIX, "");
    let prefix = "";
    if (session.onBreak()) prefix = `❚❚ ${session.state.done}/${session.state.total} · `;
    else if (session.state.active) prefix = `▶ ${session.state.done}/${session.state.total} · `;
    else if (titleFlash) prefix = `${titleFlash} · `;
    if (document.title !== prefix + base) document.title = prefix + base;
  }
  listen(document, "visibilitychange", () => {
    if (!document.hidden && titleFlash) {
      titleFlash = "";
      updateTitle();
    }
  });

  // Desktop notification (only if you turned it on and allowed it).
  function notify(message) {
    if (!loadSettings().notify || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification("NT Autotyper", { body: message, tag: "nt-autotyper" });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }

  function topHandle(msg, source) {
    switch (msg.kind) {
      case "status":
        panel.statuses.set(source, { ...msg.status, at: Date.now() });
        panel.render();
        break;
      case "raceStart":
      case "raceSeen":
        session.raceStarted();
        break;
      case "raceDone":
        session.raceDone(msg.result);
        break;
      case "raceFailed":
        session.raceFailed(msg.message);
        break;
      case "raceResult":
        session.attachOfficial(msg.at, msg.official);
        break;
      case "debug":
        session.debug.set(source, { ...msg.info, at: Date.now() });
        panel.renderDebug?.();
        break;
      case "say":
        if (session.state.active) session.say(msg.message);
        break;
      case "needNext":
        if (session.state.active) session.scheduleNext(800);
        break;
      case "stop":
        session.stop(msg.message);
        break;
      case "toggle":
        session.toggle();
        break;
    }
  }

  // =========================================================================
  // 9. Control panel (top page)
  // =========================================================================

  const panel = {
    statuses: new Map(), // frame window -> latest engine status
    render() {},
  };

  if (IS_TOP) {
    session.init();
    // Frames load at different times; keep them in step.
    timers.every(() => {
      session.sync();
      updateTitle(); // the page may have changed its title
    }, 1500);
    timers.every(() => session.tickBreak(), 1000);
    // Reloaded in the middle of a break: finish the break, then carry on.
    if (session.onBreak()) session.scheduleNext(session.state.breakUntil - Date.now());
    listen(window, "load", () => session.sync());
    session.sync();
  }

  // Pages that enforce Trusted Types reject plain strings for innerHTML.
  let htmlPolicy = null;
  try {
    htmlPolicy = window.trustedTypes?.createPolicy?.("nt-autotyper", { createHTML: (x) => x }) ?? null;
  } catch {
    /* policy name not allowed; plain strings it is */
  }
  const setHTML = (el, markup) => {
    el.innerHTML = htmlPolicy ? htmlPolicy.createHTML(markup) : markup;
  };

  const fmt = (n, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : "–");
  const average = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box {
      --bg: #141b33; --bg2: #1c2547; --line: #2b3762; --text: #e8edff; --sub: #8e9cc9;
      --accent: #f5a623; --good: #3ddc84; --bad: #ff5c6c;
      position: fixed; display: flex; flex-direction: column;
      min-width: 250px; max-width: 520px; min-height: 44px;
      background: var(--bg); color: var(--text);
      border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .45);
      font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      overflow: hidden; resize: both;
      opacity: var(--idle-opacity, 1); transition: opacity .15s;
    }
    .box:hover, .box.running { opacity: 1; }
    .box.collapsed { resize: none; height: auto !important; min-height: 0; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: linear-gradient(90deg, #212c57, #1a2346); cursor: grab; user-select: none;
      touch-action: none; flex: none;
    }
    header:active { cursor: grabbing; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #5d6a94; flex: none; }
    .running .dot { background: var(--good); box-shadow: 0 0 0 3px rgba(61, 220, 132, .2); }
    .title { font-weight: 700; letter-spacing: .2px; flex: 1; white-space: nowrap; }
    .title small { color: var(--sub); font-weight: 500; margin-left: 6px; }
    .icon { all: unset; cursor: pointer; color: var(--sub); padding: 2px 6px; border-radius: 6px; font-size: 14px; }
    .icon:hover { color: var(--text); background: rgba(255, 255, 255, .08); }
    .main { display: flex; flex-direction: column; min-height: 0; flex: 1; }
    .collapsed .main { display: none; }
    .live { padding: 10px 12px 8px; border-bottom: 1px solid var(--line); flex: none; }
    .status { color: var(--sub); overflow-wrap: anywhere; }
    .running .status { color: var(--text); }
    .bar { height: 6px; margin: 8px 0 6px; background: var(--bg2); border-radius: 99px; overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--accent), #ffd36b); transition: width .2s; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { background: var(--bg2); border: 1px solid var(--line); border-radius: 99px; padding: 1px 8px; font-size: 11.5px; color: var(--sub); }
    .chip b { color: var(--text); font-weight: 600; }
    nav { display: flex; gap: 4px; padding: 8px 12px 0; flex: none; }
    nav button { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 8px 8px 0 0; color: var(--sub); font-weight: 600; font-size: 12px; }
    nav button.on { color: var(--text); background: var(--bg2); }
    .tabs { flex: 1; min-height: 0; overflow: auto; background: var(--bg2); margin: 0 8px 8px; border-radius: 0 10px 10px 10px; }
    section { display: none; padding: 12px; gap: 12px; flex-direction: column; }
    section.on { display: flex; }
    .field > .lbl { display: flex; justify-content: space-between; color: var(--sub); margin-bottom: 4px; font-size: 12px; }
    .field > .lbl b { color: var(--text); font-weight: 600; }
    .row { display: flex; align-items: center; gap: 8px; }
    input[type=range] { flex: 1; min-width: 60px; accent-color: var(--accent); margin: 0; }
    input[type=number] {
      width: 58px; padding: 4px 6px; border-radius: 7px; border: 1px solid var(--line);
      background: var(--bg); color: var(--text); font: inherit; text-align: right;
    }
    input[type=number]:focus { outline: none; border-color: var(--accent); }
    .range2 { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 6px; }
    .range2 span { color: var(--sub); }
    .range2 input[type=number] { width: 100%; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .hint { color: var(--sub); font-size: 11px; margin-top: 3px; }
    .go {
      all: unset; text-align: center; cursor: pointer; padding: 10px; border-radius: 10px;
      background: var(--accent); color: #1a1f33; font-weight: 800; letter-spacing: .3px; flex: none;
      margin: 0 8px 8px;
    }
    .go:hover { filter: brightness(1.08); }
    .running .go { background: var(--bad); color: #fff; }
    .foot { color: var(--sub); font-size: 11px; text-align: center; padding: 0 8px 10px; flex: none; }
    .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .card { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
    .card .k { color: var(--sub); font-size: 11px; }
    .card .v { font-size: 18px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
    th { text-align: right; color: var(--sub); font-weight: 600; padding: 3px 4px; border-bottom: 1px solid var(--line); }
    td { text-align: right; padding: 3px 4px; border-bottom: 1px solid rgba(43, 55, 98, .5); }
    th:first-child, td:first-child { text-align: left; }
    .empty { color: var(--sub); text-align: center; padding: 8px; }
    .btn2 { all: unset; cursor: pointer; text-align: center; padding: 7px; border-radius: 8px; border: 1px solid var(--line); color: var(--sub); }
    .btn2:hover { color: var(--text); border-color: var(--sub); }
    .check { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
    .check input { accent-color: var(--accent); margin: 2px 0 0; }
    .check small { display: block; color: var(--sub); font-size: 11px; }
    .sep { border: 0; border-top: 1px solid var(--line); margin: 0; }
    .breaks { display: grid; grid-template-columns: auto 52px auto; align-items: center; gap: 6px; color: var(--sub); font-size: 12px; }
    .breaks input[type=number] { width: 52px; }
    .breaks .len { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; }
    .cards.six { grid-template-columns: repeat(3, 1fr); }
    .cards.six .v { font-size: 16px; }
    .footnote { color: var(--sub); font-size: 11px; }
    .chart-title { display: flex; justify-content: space-between; color: var(--sub); font-size: 12px; margin-bottom: 2px; }
    .chart { position: relative; touch-action: none; }
    .chart svg { display: block; overflow: visible; }
    .chart .tip {
      position: absolute; top: 0; display: none; pointer-events: none; white-space: nowrap;
      transform: translate(-50%, -105%); padding: 4px 8px; border-radius: 8px;
      background: var(--bg); border: 1px solid var(--line); font-size: 11.5px; color: var(--text);
    }
    pre.debug {
      display: none; margin: 8px 0 0; padding: 8px; max-height: 240px; overflow: auto;
      background: var(--bg); border: 1px solid var(--line); border-radius: 8px; color: var(--sub);
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .debugging pre.debug { display: block; }
    /* compact mode: just status, progress and the button */
    .box.compact { resize: none; height: auto !important; min-height: 0; }
    .compact nav, .compact .tabs, .compact .foot, .compact pre.debug { display: none !important; }
    .compact .main { flex: none; }
    .compact .live { padding: 8px 12px 6px; border-bottom: 0; }
    .compact .status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .compact .bar { margin: 6px 0 4px; }
    .compact .chips { flex-wrap: nowrap; overflow: hidden; }
    .compact .go { padding: 6px; margin: 2px 8px 8px; }
  `;

  const PANEL_HTML = `
    <div class="box">
      <header>
        <span class="dot"></span>
        <span class="title">NT Autotyper<small class="count"></small></span>
        <button class="icon compact-btn" title="Compact mode">⊟</button>
        <button class="icon collapse" title="Collapse">▾</button>
      </header>
      <div class="main">
        <div class="live">
          <div class="status">Idle</div>
          <div class="bar"><i></i></div>
          <div class="chips"></div>
          <pre class="debug"></pre>
        </div>
        <nav>
          <button data-tab="race" class="on">Race</button>
          <button data-tab="stats">Stats</button>
          <button data-tab="panel">Panel</button>
        </nav>
        <div class="tabs">
          <section data-tab="race" class="on">
            <div class="field">
              <div class="lbl">Speed range <b class="wpmLabel"></b></div>
              <div class="range2">
                <input type="number" data-k="wpmMin" min="10" max="300"><span>to</span><input type="number" data-k="wpmMax" min="10" max="300">
              </div>
              <div class="row" style="margin-top:6px"><input type="range" data-k="wpmMin" min="10" max="300"></div>
              <div class="row"><input type="range" data-k="wpmMax" min="10" max="300"></div>
              <div class="hint">Each race picks a random speed in this range.</div>
            </div>
            <div class="field">
              <div class="lbl">Accuracy range <b class="accLabel"></b></div>
              <div class="range2">
                <input type="number" data-k="accMin" min="80" max="100" step="0.5"><span>to</span><input type="number" data-k="accMax" min="80" max="100" step="0.5">
              </div>
              <div class="row" style="margin-top:6px"><input type="range" data-k="accMin" min="80" max="100" step="0.5"></div>
              <div class="row"><input type="range" data-k="accMax" min="80" max="100" step="0.5"></div>
            </div>
            <div class="field">
              <div class="lbl">Timing variation <b><span data-show="variance"></span>%</b></div>
              <div class="row"><input type="range" data-k="variance" min="0" max="60"></div>
            </div>
            <div class="pair">
              <div class="field">
                <div class="lbl">Nitros / race</div>
                <input type="number" data-k="nitros" min="0" max="10">
                <div class="hint">Used on the longest words.</div>
              </div>
              <div class="field">
                <div class="lbl">Races to run</div>
                <input type="number" data-k="races" min="1" max="500">
                <div class="hint">Clicks "Race Again" in between.</div>
              </div>
            </div>
            <div class="field">
              <div class="lbl">Long breaks <b class="breakLabel"></b></div>
              <div class="breaks">
                <span>Every</span><input type="number" data-k="breakEvery" min="0" max="100"><span>races (0 = off)</span>
                <div class="len">for <input type="number" data-k="breakLenMin" min="0.1" max="30" step="0.5"> to <input type="number" data-k="breakLenMax" min="0.1" max="30" step="0.5"> min</div>
              </div>
              <div class="hint">The race count varies a little each time.</div>
            </div>
          </section>
          <section data-tab="stats">
            <div class="cards six">
              <div class="card"><div class="k">Races</div><div class="v s-races"></div></div>
              <div class="card"><div class="k">Avg WPM</div><div class="v s-wpm"></div></div>
              <div class="card"><div class="k">Avg acc</div><div class="v s-acc"></div></div>
              <div class="card"><div class="k">Best WPM</div><div class="v s-best"></div></div>
              <div class="card"><div class="k">Money</div><div class="v s-money"></div></div>
              <div class="card"><div class="k">XP</div><div class="v s-xp"></div></div>
            </div>
            <div>
              <div class="chart-title"><span>WPM per race</span><span class="chart-range"></span></div>
              <div class="chart"><svg class="chart-svg" role="img" aria-label="WPM per race"></svg><div class="tip"></div></div>
            </div>
            <table>
              <thead><tr><th>When</th><th>WPM</th><th>Acc</th><th>Place</th><th>Nitros</th></tr></thead>
              <tbody class="history"></tbody>
            </table>
            <div class="footnote"></div>
            <button class="btn2 reset-stats">Reset stats</button>
          </section>
          <section data-tab="panel">
            <div class="field">
              <div class="lbl">Opacity when not hovered <b><span class="opLabel"></span>%</b></div>
              <div class="row"><input type="range" class="opacity" min="20" max="100"></div>
            </div>
            <div class="hint">Drag the header to move the panel, drag the bottom-right corner to resize it, ⊟ for compact mode, ▾ to collapse it.</div>
            <button class="btn2 reset-panel">Reset position and size</button>
            <hr class="sep">
            <label class="check"><input type="checkbox" data-k="notify"><span>Desktop notification when a session ends<small class="notify-hint">Only when you're not looking at the tab.</small></span></label>
            <label class="check"><input type="checkbox" data-k="debug"><span>Debug view<small>Shows what the script sees on the page. Copy it and send it over if something breaks.</small></span></label>
            <button class="btn2 copy-debug">Copy debug info</button>
            <hr class="sep">
            <div class="hint version"></div>
          </section>
        </div>
        <button class="go">Start</button>
        <div class="foot">Alt+Shift+A start/stop · pressing any key stops it</div>
      </div>
    </div>`;

  function buildPanel() {
    panelHost = document.createElement("div");
    const root = panelHost.attachShadow({ mode: "open" });
    setHTML(root, `<style>${PANEL_CSS}</style>${PANEL_HTML}`);
    document.body.appendChild(panelHost);

    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => [...root.querySelectorAll(sel)];
    const box = $(".box");
    let settings = loadSettings();
    const UI_DEFAULTS = { x: 16, y: null, w: 290, h: null, collapsed: false, compact: false, tab: "race", opacity: 100 };
    let ui = { ...UI_DEFAULTS, ...readJSON(localStorage, KEYS.ui, {}) };
    const saveUI = () => writeJSON(localStorage, KEYS.ui, ui);

    // ---- position, size, collapse --------------------------------------
    function place() {
      const rect = box.getBoundingClientRect();
      const maxX = Math.max(0, innerWidth - rect.width);
      const maxY = Math.max(0, innerHeight - Math.min(rect.height, 60));
      if (ui.y === null) ui.y = innerHeight - rect.height - 16;
      ui.x = Math.min(maxX, Math.max(0, ui.x));
      ui.y = Math.min(maxY, Math.max(0, ui.y));
      box.style.left = `${ui.x}px`;
      box.style.top = `${ui.y}px`;
    }
    function applyLayout() {
      box.style.width = `${ui.w}px`;
      box.style.height = ui.h && !ui.collapsed && !ui.compact ? `${ui.h}px` : "";
      box.classList.toggle("collapsed", ui.collapsed);
      box.classList.toggle("compact", ui.compact);
      box.classList.toggle("debugging", settings.debug);
      $(".collapse").textContent = ui.collapsed ? "▸" : "▾";
      $(".compact-btn").textContent = ui.compact ? "⊞" : "⊟";
      $(".compact-btn").title = ui.compact ? "Full panel" : "Compact mode";
      box.style.setProperty("--idle-opacity", ui.opacity / 100);
      $(".opacity").value = ui.opacity;
      $(".opLabel").textContent = ui.opacity;
      for (const el of $$("[data-tab]")) el.classList.toggle("on", el.dataset.tab === ui.tab);
      place();
    }

    let drag = null;
    $("header").addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      drag = { dx: e.clientX - ui.x, dy: e.clientY - ui.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    });
    $("header").addEventListener("pointermove", (e) => {
      if (!drag) return;
      ui.x = e.clientX - drag.dx;
      ui.y = e.clientY - drag.dy;
      place();
    });
    const endDrag = () => {
      if (drag) saveUI();
      drag = null;
    };
    $("header").addEventListener("pointerup", endDrag);
    $("header").addEventListener("pointercancel", endDrag);
    listen(window, "resize", place);

    new ResizeObserver(() => {
      if (ui.collapsed || ui.compact) return;
      const w = Math.round(box.offsetWidth);
      const h = Math.round(box.offsetHeight);
      if (w !== ui.w || (ui.h !== null && h !== ui.h) || (ui.h === null && box.style.height)) {
        ui.w = w;
        ui.h = box.style.height ? h : ui.h;
        saveUI();
      }
    }).observe(box);
    // CSS resize sets an inline height once the user drags the corner.
    new MutationObserver(() => {
      if (!ui.collapsed && !ui.compact && box.style.height) {
        ui.h = Math.round(box.offsetHeight);
        saveUI();
      }
    }).observe(box, { attributes: true, attributeFilter: ["style"] });

    $(".collapse").addEventListener("click", () => {
      ui.collapsed = !ui.collapsed;
      saveUI();
      applyLayout();
    });
    $(".compact-btn").addEventListener("click", () => {
      ui.compact = !ui.compact;
      if (ui.compact) ui.collapsed = false;
      saveUI();
      applyLayout();
      panel.render();
    });
    for (const tab of $$("nav button")) {
      tab.addEventListener("click", () => {
        ui.tab = tab.dataset.tab;
        saveUI();
        applyLayout();
        panel.render();
      });
    }
    $(".opacity").addEventListener("input", (e) => {
      ui.opacity = Number(e.target.value);
      saveUI();
      applyLayout();
    });
    $(".reset-panel").addEventListener("click", () => {
      ui = { ...UI_DEFAULTS, tab: "panel" };
      box.style.height = "";
      saveUI();
      applyLayout();
    });

    // ---- settings ----------------------------------------------------------
    const PAIR_OF = Object.fromEntries(Object.entries(PAIRS).flatMap(([lo, hi]) => [[lo, hi], [hi, lo]]));

    function fillSettings() {
      for (const el of $$("[data-k]")) {
        if (el.type === "checkbox") el.checked = settings[el.dataset.k];
        else el.value = settings[el.dataset.k];
      }
      fillLabels();
    }
    function fillLabels() {
      const span = (a, b, unit) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return lo === hi ? `${lo}${unit}` : `${lo}–${hi}${unit}`;
      };
      for (const el of $$("[data-show]")) el.textContent = settings[el.dataset.show];
      $(".wpmLabel").textContent = span(settings.wpmMin, settings.wpmMax, " WPM");
      $(".accLabel").textContent = span(settings.accMin, settings.accMax, "%");
      $(".breakLabel").textContent = settings.breakEvery
        ? `~${settings.breakEvery} races, ${span(settings.breakLenMin, settings.breakLenMax, " min")}`
        : "off";
    }
    function applySetting(key, value, keepOrder) {
      settings = normalize({ ...settings, [key]: value });
      // Keep min <= max by pushing the other end (not while typing a number,
      // where "1" on the way to "120" would drag the other end down).
      const other = PAIR_OF[key];
      if (keepOrder && other) {
        const isMin = key in PAIRS;
        if (isMin ? settings[key] > settings[other] : settings[key] < settings[other]) settings[other] = settings[key];
      }
      writeJSON(localStorage, KEYS.settings, settings);
      session.sync();
      applyLayout();
    }
    for (const el of $$("[data-k]")) {
      if (el.type === "checkbox") {
        el.addEventListener("change", async () => {
          const key = el.dataset.k;
          if (key === "notify" && el.checked && "Notification" in window && Notification.permission !== "granted") {
            const answer = await Notification.requestPermission().catch(() => "denied");
            if (answer !== "granted") {
              el.checked = false;
              $(".notify-hint").textContent = "Notifications are blocked for nitrotype.com. Allow them in the site settings (padlock icon), then try again.";
            }
          }
          applySetting(key, el.checked);
          panel.render();
          panel.renderDebug();
        });
        continue;
      }
      el.addEventListener("input", () => {
        if (el.value === "") return;
        applySetting(el.dataset.k, el.value, el.type === "range");
        // Update everything except the box being typed in.
        for (const other of $$("[data-k]")) if (other !== el && other.type !== "checkbox") other.value = settings[other.dataset.k];
        fillLabels();
      });
      el.addEventListener("change", () => {
        if (el.value !== "") applySetting(el.dataset.k, el.value, true);
        fillSettings(); // snap out-of-range values
      });
    }

    $(".copy-debug").addEventListener("click", async () => {
      const text = debugText();
      try {
        await navigator.clipboard.writeText(text);
        $(".copy-debug").textContent = "Copied!";
      } catch {
        $(".copy-debug").textContent = "Couldn't copy: select the text in the debug view";
      }
      timers.set(() => ($(".copy-debug").textContent = "Copy debug info"), 2000);
    });
    $(".version").textContent = `Version ${VERSION}. Tampermonkey updates it automatically; to check now: Tampermonkey menu → Utilities → Check for userscript updates.`;

    $(".go").addEventListener("click", () => {
      session.toggle();
      $(".go").blur(); // so the next key you press reaches the page
      if (session.state.active) focusRace();
    });
    $(".reset-stats").addEventListener("click", () => session.resetStats());

    // ---- rendering ---------------------------------------------------------
    panel.render = () => {
      const active = session.state.active;
      const statuses = [...panel.statuses.values()].sort((a, b) => a.at - b.at);
      const live = statuses.filter((s) => s.running).pop() ?? statuses.filter((s) => s.hasRace).pop();
      const typing = Boolean(live?.running);
      box.classList.toggle("running", active || typing);

      // Whichever spoke last: the engine typing the race, or the session.
      $(".status").textContent = live && (typing || live.at > session.messageAt) ? live.message : session.message;
      $(".go").textContent = active ? "Stop" : "Start";
      $(".count").textContent = active ? `race ${Math.min(session.state.done + 1, session.state.total)}/${session.state.total}` : "";

      const pct = live?.len ? (100 * live.pos) / live.len : live?.done ? 100 : 0;
      $(".bar > i").style.width = `${active || typing ? pct : 0}%`;
      const chips = [];
      if (live?.target && (active || typing)) chips.push(`target <b>${live.target}</b>`);
      if (typing && Number.isFinite(live.wpm)) chips.push(`now <b>${fmt(live.wpm)}</b> WPM`);
      if (typing && live.nitros) chips.push(`nitros <b>${live.nitros}</b>`);
      if (active) chips.push(`done <b>${session.state.done}</b>/${session.state.total}`);
      setHTML($(".chips"), chips.map((c) => `<span class="chip">${c}</span>`).join(""));

      if (ui.tab === "stats" && !ui.compact) renderStats();
      panel.renderDebug();
    };

    // ---- debug view --------------------------------------------------------
    function debugText() {
      const lines = [
        `NT Autotyper ${VERSION}`,
        `script loaded: ${LOADED_LATE ? "LATE (after the page)" : "on time"}`,
        `session: ${session.state.active ? `on, ${session.state.done}/${session.state.total} done${session.onBreak() ? ", on a break" : ""}` : "off"}`,
        `notifications: ${"Notification" in window ? Notification.permission : "not supported"}`,
        `page: ${location.host}${location.pathname}`,
      ];
      const fresh = [...session.debug.values()].filter((d) => Date.now() - d.at < 5000);
      if (!fresh.length) lines.push("", "(no report from the race frame yet)");
      for (const d of fresh) {
        lines.push("", `-- ${d.frame} --`);
        for (const [k, v] of Object.entries(d)) if (k !== "frame" && k !== "at" && v !== "") lines.push(`${k}: ${v}`);
      }
      return lines.join("\n");
    }
    panel.renderDebug = () => {
      if (settings.debug && !ui.compact) $("pre.debug").textContent = debugText();
    };

    // ---- chart ---------------------------------------------------------------
    const wpmOf = (r) => r.official?.wpm ?? r.wpm;
    const accOf = (r) => r.official?.accuracy ?? r.accuracy;
    const LINE = "#d07f10"; // checked for contrast and lightness on the panel background
    let chartGeom = null;

    function renderChart() {
      const wrap = $(".chart");
      const svg = $(".chart-svg");
      const races = session.stats.slice(-40);
      const W = Math.round(wrap.clientWidth);
      if (!W) return;
      const H = 110;
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      $(".chart-range").textContent = races.length ? `last ${races.length} race${races.length === 1 ? "" : "s"}` : "";
      if (races.length < 2) {
        chartGeom = null;
        setHTML(svg, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#8e9cc9" font-size="12">The chart starts after 2 races</text>`);
        return;
      }
      const vals = races.map(wpmOf);
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      const padV = Math.max(5, (hi - lo) * 0.15);
      lo = Math.max(0, Math.floor((lo - padV) / 5) * 5);
      hi = Math.ceil((hi + padV) / 5) * 5;
      const L = 30;
      const R = 8;
      const T = 8;
      const B = 8;
      const x = (i) => L + (i * (W - L - R)) / (races.length - 1);
      const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
      const avg = average(vals);
      const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const last = vals.length - 1;
      chartGeom = { races, x, y, L, R, W };
      setHTML(
        svg,
        `
        <line x1="${L}" x2="${W - R}" y1="${y(hi)}" y2="${y(hi)}" stroke="#2b3762" stroke-width="1"/>
        <line x1="${L}" x2="${W - R}" y1="${y(lo)}" y2="${y(lo)}" stroke="#2b3762" stroke-width="1"/>
        <text x="${L - 6}" y="${y(hi) + 4}" text-anchor="end" fill="#8e9cc9" font-size="10">${hi}</text>
        <text x="${L - 6}" y="${y(lo) + 4}" text-anchor="end" fill="#8e9cc9" font-size="10">${lo}</text>
        <line x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}" stroke="#8e9cc9" stroke-width="1" stroke-dasharray="3 4"/>
        <text x="${L + 4}" y="${y(avg) - 4}" text-anchor="start" fill="#8e9cc9" font-size="10">avg ${fmt(avg)}</text>
        <polyline points="${pts}" fill="none" stroke="${LINE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(last)}" cy="${y(vals[last])}" r="4" fill="${LINE}" stroke="#1c2547" stroke-width="2"/>
        <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#8e9cc9" stroke-width="1" visibility="hidden"/>
        <circle class="hover-dot" r="4" fill="${LINE}" stroke="#1c2547" stroke-width="2" visibility="hidden"/>`,
      );
    }

    // Hover anywhere on the chart: crosshair on the nearest race + tooltip.
    $(".chart").addEventListener("pointermove", (e) => {
      if (!chartGeom) return;
      const { races, x, y, L, R, W } = chartGeom;
      const rect = $(".chart").getBoundingClientRect();
      const px = e.clientX - rect.left;
      const i = Math.max(0, Math.min(races.length - 1, Math.round(((px - L) / (W - L - R)) * (races.length - 1))));
      const r = races[i];
      const cx = x(i);
      const cy = y(wpmOf(r));
      const cross = $(".cross");
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      const dot = $(".hover-dot");
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.setAttribute("visibility", "visible");
      const tip = $(".chart .tip");
      tip.textContent = `${fmt(wpmOf(r))} WPM${r.official ? "" : " (est.)"} · ${fmt(accOf(r), 1)}% · ${timeAgo(r.at)}`;
      tip.style.display = "block";
      tip.style.left = `${Math.max(70, Math.min(W - 70, cx))}px`;
      tip.style.top = `${cy - 6}px`;
    });
    $(".chart").addEventListener("pointerleave", () => {
      $(".chart .tip").style.display = "none";
      $(".cross")?.setAttribute("visibility", "hidden");
      $(".hover-dot")?.setAttribute("visibility", "hidden");
    });

    const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`);
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);

    function renderStats() {
      const st = session.stats;
      const money = st.map((r) => r.official?.money).filter(Number.isFinite);
      const xp = st.map((r) => r.official?.xp).filter(Number.isFinite);
      $(".s-races").textContent = st.length;
      $(".s-wpm").textContent = fmt(average(st.map(wpmOf)));
      $(".s-acc").textContent = st.length ? `${fmt(average(st.map(accOf)), 1)}%` : "–";
      $(".s-best").textContent = st.length ? fmt(Math.max(...st.map(wpmOf))) : "–";
      $(".s-money").textContent = money.length ? `$${sum(money).toLocaleString()}` : "–";
      $(".s-xp").textContent = xp.length ? sum(xp).toLocaleString() : "–";
      renderChart();
      const rows = st.slice(-25).reverse();
      setHTML(
        $(".history"),
        rows.length
          ? rows
              .map((r) => {
                const est = r.official ? "" : "~";
                const tip = `target ${r.target ?? "?"} WPM, ${r.accTarget ?? "?"}%` + (r.official?.money ? `, $${r.official.money}` : "") + (r.official?.xp ? `, ${r.official.xp} XP` : "");
                return `<tr title="${tip}"><td>${timeAgo(r.at)}</td><td>${est}${fmt(wpmOf(r))}</td><td>${est}${fmt(accOf(r), 1)}%</td><td>${r.official?.place ? ordinal(r.official.place) : "–"}</td><td>${r.nitros ?? 0}</td></tr>`;
              })
              .join("")
          : `<tr><td colspan="5" class="empty">No races yet</td></tr>`,
      );
      $(".footnote").textContent = rows.some((r) => !r.official)
        ? "~ = the script's own estimate (Nitro Type's results weren't found on screen)."
        : "";
    }

    fillSettings();
    applyLayout();
    panel.render();
    timers.every(() => ui.tab === "stats" && renderStats(), 15000); // refresh "x ago"
  }

  // Mount the panel last, once everything above is defined. (Not with
  // requestAnimationFrame: it never fires in a background tab.)
  if (IS_TOP) {
    if (document.body) buildPanel();
    else listen(document, "DOMContentLoaded", buildPanel, { once: true });
  }
})();
