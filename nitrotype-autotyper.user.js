// ==UserScript==
// @name         Nitro Type Autotyper
// @namespace    https://github.com/ZillaFam/Nitrotype-autotyper
// @version      3.15.0
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

  const VERSION = "3.15.0";
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

  const pageSetTimeout = window.setTimeout.bind(window);
  const pageClearTimeout = window.clearTimeout.bind(window);
  const pageSetInterval = window.setInterval.bind(window);
  const pageClearInterval = window.clearInterval.bind(window);
  const pageRequestFrame = window.requestAnimationFrame?.bind(window);
  const pageCancelFrame = window.cancelAnimationFrame?.bind(window);

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
        if (!t.native) t.native = pageSetTimeout(() => fire(id), t.due - performance.now());
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
        else t.native = pageSetTimeout(() => fire(id), ms);
        return id;
      },
      clear(id) {
        const t = pending.get(id);
        if (!t) return;
        pending.delete(id);
        if (t.native) pageClearTimeout(t.native);
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
  // 1c. Keep Nitro Type's page running while minimised
  // =========================================================================
  //
  // In a minimised window or a hidden tab, Chrome stops screen refreshes
  // (requestAnimationFrame) completely and slows the page's own timers to
  // once a second, then once a minute. The script's typing doesn't care (it
  // uses the worker timers above), but Nitro Type's page does: if its race
  // loop stops, your progress stops reaching the server and you get
  // "disqualified due to inactivity".
  //
  // So, only while the page is hidden AND a session is running here, Nitro
  // Type's frames (~15 a second) and timers run on the worker timers. While
  // visible, or with no session, everything passes straight through.

  const HIDDEN_FRAME_MS = 66;
  let keepAliveWanted = false; // set by the engine: a session is on (breaks and pauses too) + setting on
  const keepAliveActive = () => keepAliveWanted && document.hidden && timers.usingWorker;

  // requestAnimationFrame: the real one, plus a worker-timer backup while hidden.
  const frames = new Map(); // id -> { cb, native, backup }
  let frameSeq = 0;
  function runFrame(id, time) {
    const f = frames.get(id);
    if (!f) return;
    frames.delete(id);
    if (f.native && pageCancelFrame) pageCancelFrame(f.native);
    timers.clear(f.backup);
    f.cb(time);
  }
  function backupFrame(id) {
    const f = frames.get(id);
    if (f && !f.backup) f.backup = timers.set(() => runFrame(id, performance.now()), HIDDEN_FRAME_MS);
  }
  if (pageRequestFrame) {
    window.requestAnimationFrame = function (cb) {
      const id = ++frameSeq;
      const f = { cb, native: 0, backup: 0 };
      frames.set(id, f);
      f.native = pageRequestFrame((t) => runFrame(id, t));
      if (keepAliveActive()) backupFrame(id);
      return id;
    };
    window.cancelAnimationFrame = function (id) {
      const f = frames.get(id);
      if (!f) return;
      frames.delete(id);
      pageCancelFrame?.(f.native);
      timers.clear(f.backup);
    };
  }

  // setTimeout / setInterval: worker timers while hidden and racing.
  // Our ids live above 2^30 so they never clash with the page's own.
  const ID_BASE = 2 ** 30;
  let timerSeq = ID_BASE;
  const pageTimers = new Map(); // id -> { fn, args, ms, repeat, native, worker }
  const callTimer = (fn, args) => (typeof fn === "function" ? fn(...args) : (0, eval)(String(fn)));

  function armTimer(id) {
    const t = pageTimers.get(id);
    if (!t) return;
    const useWorker = keepAliveActive();
    if (useWorker && !t.worker) {
      if (t.native) (t.repeat ? pageClearInterval : pageClearTimeout)(t.native);
      t.native = 0;
      const tick = () => {
        if (!pageTimers.has(id)) return;
        if (t.repeat) t.worker = timers.set(tick, Math.max(4, t.ms));
        else pageTimers.delete(id);
        callTimer(t.fn, t.args);
      };
      t.worker = timers.set(tick, Math.max(4, t.ms)); // 4 ms floor, like the browser's own
    } else if (!useWorker && t.repeat && t.worker) {
      // Back to the page's own interval when visible again.
      timers.clear(t.worker);
      t.worker = 0;
      t.native = pageSetInterval(() => callTimer(t.fn, t.args), t.ms);
    }
  }

  window.setTimeout = function (fn, ms = 0, ...args) {
    if (!keepAliveActive()) return pageSetTimeout(fn, ms, ...args);
    const id = ++timerSeq;
    pageTimers.set(id, { fn, args, ms: Number(ms) || 0, repeat: false, native: 0, worker: 0 });
    armTimer(id);
    return id;
  };
  window.setInterval = function (fn, ms = 0, ...args) {
    // Intervals are long-lived, so they're always tracked: one created while
    // visible must still switch over when the window is minimised.
    const id = ++timerSeq;
    const t = { fn, args, ms: Number(ms) || 0, repeat: true, native: 0, worker: 0 };
    pageTimers.set(id, t);
    if (keepAliveActive()) armTimer(id);
    else t.native = pageSetInterval(fn, ms, ...args);
    return id;
  };
  const clearOurs = (id) => {
    const t = pageTimers.get(id);
    if (!t) return false;
    pageTimers.delete(id);
    if (t.native) (t.repeat ? pageClearInterval : pageClearTimeout)(t.native);
    timers.clear(t.worker);
    return true;
  };
  window.clearTimeout = function (id) {
    if (!clearOurs(id)) pageClearTimeout(id);
  };
  window.clearInterval = function (id) {
    if (!clearOurs(id)) pageClearInterval(id);
  };

  // Hidden/visible or session on/off: move what's pending to the right clock.
  function refreshKeepAlive() {
    if (keepAliveActive()) for (const id of frames.keys()) backupFrame(id);
    for (const [id, t] of pageTimers) if (t.repeat) armTimer(id);
  }
  function setKeepAlive(on) {
    if (on === keepAliveWanted) return;
    keepAliveWanted = on;
    refreshKeepAlive();
  }
  nativeAdd.call(document, "visibilitychange", refreshKeepAlive);

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
   * The wrong key a person might hit instead of text[i]: Shift forgotten on
   * a capital, the next letter too early (fingers out of order), the
   * previous key again (double tap), or most often a neighbouring key.
   */
  function makeTypo(text, i) {
    const ch = text[i];
    const prev = text[i - 1];
    const next = text[i + 1];
    const r = Math.random();
    if (ch !== ch.toLowerCase() && r < 0.3) return ch.toLowerCase();
    if (r < 0.5 && next && next !== " " && next !== ch) return next;
    if (r < 0.6 && prev && prev !== " " && prev !== ch) return prev;
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

  // Reading all ~300 letters on every keystroke is wasteful: the text only
  // changes when a new race shows up. So the text is cached, and each call
  // just asks the browser (native selectors, fast) where the cursor is.
  const LETTERS = document.getElementsByClassName("dash-letter"); // live list
  let letterCache = null;
  const letterSample = (n) => LETTERS[0].textContent + LETTERS[n >> 1].textContent + LETTERS[n - 1].textContent;

  function buildLetterCache() {
    let text = "";
    const index = new Map(); // span -> position in the text
    for (const span of LETTERS) {
      const ch = span.textContent.replace(/\u00a0/g, " ");
      if (ch.length !== 1) continue; // skips the finish-flag emoji and empties
      index.set(span, text.length);
      text += ch;
    }
    const n = LETTERS.length;
    letterCache = { first: LETTERS[0], last: LETTERS[n - 1], count: n, sample: letterSample(n), text, index, at: Date.now() };
  }

  /** { text, pos, id, firstClass } or null. pos is null when the classes give no clue. */
  function readRace() {
    const n = LETTERS.length;
    if (!n) return null;
    const c = letterCache;
    const stale =
      !c || c.count !== n || c.first !== LETTERS[0] || c.last !== LETTERS[n - 1] || c.sample !== letterSample(n) || Date.now() - c.at > 3000;
    if (stale) buildLetterCache();
    const { text, index } = letterCache;
    if (!text) return null;
    const waiting = document.querySelector(".dash-letter.is-waiting, .dash-letter.is-current, .dash-letter.is-active");
    let pos = waiting ? index.get(waiting) : undefined;
    if (pos === undefined) {
      const typed = document.querySelectorAll(".dash-letter.is-correct, .dash-letter.is-typed").length;
      pos = typed > 0 ? typed : null;
    }
    return { text, pos, id: LETTERS[0], firstClass: LETTERS[0].className };
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

  /**
   * Small blocks of text that mention both WPM and accuracy, smallest first.
   * Only looks around text that says "WPM" (instead of reading every element
   * on the page, which is slow on a big page).
   */
  function resultCandidates() {
    if (!document.body) return [];
    const found = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/wpm/i.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    while (walker.nextNode()) {
      let el = walker.currentNode.parentElement;
      if (!el || el.closest(".dash-copy") || el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
        if (el === panelHost || found.has(el)) continue;
        if (!/^(DIV|SECTION|TABLE|UL|DL)$/.test(el.tagName)) continue;
        const raw = el.textContent;
        if (raw.length > 800) break;
        if (/acc/i.test(raw)) found.set(el, textOf(el));
      }
    }
    return [...found].map(([el, text]) => ({ el, text })).sort((a, b) => a.text.length - b.text.length);
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

  // ---- Nitro Type's race state ------------------------------------------
  //
  // Nitro Type is a React app. The race component behind #raceContainer keeps
  // every racer's progress and place in its state; other Nitro Type
  // userscripts read it the same way. We only read it, never change it.

  function findReact(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    let fiber = key ? el[key]?.return : null;
    while (fiber && typeof fiber.type === "string") fiber = fiber.return;
    return fiber?.stateNode ?? null;
  }

  function raceComponent() {
    const el = document.getElementById("raceContainer");
    if (!el) return null;
    try {
      const comp = findReact(el);
      return comp?.state ? comp : null;
    } catch {
      return null;
    }
  }

  const nameOf = (r) =>
    r.profile?.displayName || r.displayName || r.profile?.username || r.username || r.name || (r.robot ? "Bot" : "Racer");

  /** Every racer as { name, me, pct, wpm, acc, place, done }, or null without race state. */
  function readRacers() {
    const comp = raceComponent();
    const racers = comp?.state?.racers;
    if (!Array.isArray(racers) || !racers.length) return null;
    const myId = comp.props?.user?.userID;
    const len = (comp.state.lessonContent || "").length || readRace()?.text.length || 1;
    return racers
      .filter((r) => r && !r.disqualified)
      .map((r) => {
        const p = r.progress || {};
        const typed = p.typed || 0;
        const net = typed - (p.skipped || 0);
        const done = p.completeStamp > 0;
        const ms = (done ? p.completeStamp : Date.now()) - p.startStamp;
        return {
          id: r.userID,
          lane: Number.isFinite(r.lane) ? r.lane : undefined,
          kind: r.userID === myId ? "me" : r.profile?.specialRobot === "wampus" ? "wampus" : r.robot ? "bot" : "player",
          skipped: p.skipped || 0,
          name: String(nameOf(r)),
          me: myId !== undefined && r.userID === myId,
          pct: Math.max(0, Math.min(1, typed / len)),
          wpm: p.startStamp > 0 && ms > 1500 && net > 0 ? Math.round(net / 5 / (ms / 60000)) : undefined,
          acc: done && net > 0 && Number.isFinite(p.errors) ? Math.round((1 - p.errors / net) * 1000) / 10 : undefined,
          place: Number.isFinite(r.place) ? r.place : undefined,
          done,
        };
      });
  }

  // ---- your totals: money, XP, level -----------------------------------------
  //
  // Money and XP earned in a race = your totals after it minus before it.
  // Nitro Type sends your updated totals with the race update when you
  // finish (racer.rewards.current), and keeps them in its saved state
  // (localStorage "persist:nt"). Read-only; your login token is never used.

  function readSavedUser() {
    try {
      const outer = JSON.parse(localStorage.getItem("persist:nt") || "null");
      const user = typeof outer?.user === "string" ? JSON.parse(outer.user) : outer?.user;
      return user && typeof user === "object" ? user : null;
    } catch {
      return null;
    }
  }

  const asNumber = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const totalsOf = (u) => ({ money: asNumber(u?.money), xp: asNumber(u?.experience ?? u?.xp), level: asNumber(u?.level) });

  // Race updates from Nitro Type's server, as they arrive (read-only listener).
  const heardServers = new WeakSet();
  let serverRewards = null;
  // Nitro Type's race status: "countdown", then "racing" at GO. Lets the
  // first key come a human reaction time after GO, instead of instantly.
  const raceSignal = { seen: false, goAt: 0 };
  function listenToServer() {
    const comp = raceComponent();
    const server = comp?.server;
    if (!server || typeof server.on !== "function" || heardServers.has(server)) return;
    heardServers.add(server);
    try {
      server.on("status", (e) => {
        if (e?.status === "countdown") {
          raceSignal.seen = true;
          raceSignal.goAt = 0;
        } else if (e?.status === "racing") {
          raceSignal.seen = true;
          raceSignal.goAt = performance.now();
        }
      });
      server.on("update", (e) => {
        const myId = comp.props?.user?.userID;
        const me = e?.racers?.find?.((r) => r?.userID === myId);
        if (me?.rewards) serverRewards = me.rewards;
      });
    } catch {
      /* not an event emitter after all */
    }
  }

  /** Your Nitro Type username (display name if there's no username). */
  function myUsername() {
    const user = raceComponent()?.props?.user;
    const saved = readSavedUser();
    const name = user?.username || saved?.username || user?.displayName || saved?.displayName || "";
    return String(name).slice(0, 40);
  }

  /** Your updated totals for the race you just finished, if Nitro Type sent them. */
  function finishedTotals() {
    const comp = raceComponent();
    const myId = comp?.props?.user?.userID;
    const me = comp?.state?.racers?.find?.((r) => r?.userID === myId);
    const current = me?.rewards?.current ?? serverRewards?.current;
    return current ? totalsOf(current) : null;
  }

  /** Your totals right now: saved state first, then the race component. */
  function savedTotals() {
    const saved = totalsOf(readSavedUser());
    const props = totalsOf(raceComponent()?.props?.user);
    return { money: saved.money ?? props.money, xp: saved.xp ?? props.xp, level: saved.level ?? props.level };
  }

  /** Your official result from the race state, once you've crossed the line. */
  function officialFromState() {
    const me = readRacers()?.find((r) => r.me);
    return me?.done && me.wpm ? { wpm: me.wpm, accuracy: me.acc, place: me.place } : null;
  }

  /**
   * Nitro Type's results screen: everyone's rows in the results table (yours
   * is .is-self), and the rewards box with money and XP. Null if not shown.
   */
  function readResultsScreen() {
    const root = document.querySelector(".race-results, .raceResults");
    if (!root) return null;
    const rows = [...root.querySelectorAll(".gridTable-row")];
    const racers = rows.map((row, i) => {
      const parsed = parseResults(textOf(row));
      const cells = [...row.querySelectorAll(".gridTable-cell")].map(textOf);
      const name = cells.find((c) => /[a-z]/i.test(c) && !/wpm|%|^\d+\s?(st|nd|rd|th)$/i.test(c)) ?? `Racer ${i + 1}`;
      const me = row.classList.contains("is-self");
      return { name, me, pct: 1, wpm: parsed.wpm, acc: parsed.accuracy, place: parsed.place ?? i + 1, done: true };
    });
    const self = racers.find((r) => r.me);
    const rewardsEl = root.querySelector(".raceResults-rewards");
    const rewards = rewardsEl ? parseResults(textOf(rewardsEl)) : {};
    // No table (a different layout): read the whole results box instead.
    const whole = rows.length ? {} : parseResults(textOf(root));
    return {
      wpm: self?.wpm ?? whole.wpm,
      accuracy: self?.acc ?? whole.accuracy,
      place: self?.place ?? whole.place,
      money: rewards.money ?? whole.money,
      xp: rewards.xp ?? whole.xp,
      racers: racers.length ? racers : null,
    };
  }

  /**
   * Did this race level you up or unlock a season-pass tier? Compares your
   * level/tier in the race state with before the race, and looks for the
   * results screen's wording ("Level Up", "Reward Unlocked", ...).
   */
  function levelChanges(before = {}, totals = {}) {
    const after = readProgress();
    const screen = document.querySelector(".race-results, .raceResults");
    const text = screen ? textOf(screen) : "";
    const out = {};
    if (totals.after && totals.before && totals.after > totals.before) out.levelUp = totals.after;
    else if (after.level && before.level && after.level > before.level) out.levelUp = after.level;
    else if (/level\s*up|new level|reached level/i.test(text)) out.levelUp = Number(text.match(/(?:reached )?level\s*(\d+)/i)?.[1]) || true;
    if (after.season && before.season && after.season > before.season) out.seasonUp = after.season;
    else if (/season (?:pass )?reward|reward unlocked|new tier|tier \d+ unlocked/i.test(text)) out.seasonUp = Number(text.match(/tier\s*(\d+)/i)?.[1]) || true;
    return out;
  }

  // ---- captcha ---------------------------------------------------------------
  //
  // If Nitro Type asks for a captcha, the session stops and tells you. The
  // script never touches the captcha itself: solving it is up to you.
  // Ignored: the small "protected by reCAPTCHA" badge (an invisible-size
  // reCAPTCHA iframe) that some pages always show.
  const CAPTCHA_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i;
  const CAPTCHA_TEXT = /i'?m not a robot|verify (?:that )?you(?:'re| are) (?:a )?human|complete the (?:captcha|security check)/i;
  // Popups and captchas live in dialogs, modals and captcha widgets. Reading
  // the whole page's text instead (innerText) forces the browser to lay out
  // the entire page, which costs frames, so only these are read, and at most
  // every 1.5 s.
  const POPUP_SELECTOR =
    '.modal, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="captcha" i], [id*="captcha" i], [class*="challenge" i]';
  let popupScan = { at: 0, captcha: false, stuck: false, dq: false, kicked: false };
  // Nitro Type dropping the connection ("disconnected", "session expired", ...).
  const KICKED_TEXT = /disconnected|lost (?:the |your )?connection|connection (?:was |has been )?(?:lost|closed|interrupted)|session (?:has )?expired|(?:log|sign) in again|been kicked|kicked from/i;
  function scanPopups() {
    const now = Date.now();
    if (now - popupScan.at < 1500) return popupScan;
    let captcha = false;
    for (const f of document.getElementsByTagName("iframe")) {
      const src = f.getAttribute("src") || "";
      if (!CAPTCHA_FRAME.test(src) || /size=invisible/.test(src)) continue;
      const r = f.getBoundingClientRect();
      if (r.width > 30 && r.height > 30) captcha = true;
    }
    let stuck = false;
    let dq = false;
    let kicked = false;
    for (const el of document.querySelectorAll(POPUP_SELECTOR)) {
      if (el === panelHost || el.closest(".dash-copy")) continue;
      const text = el.textContent;
      const isCaptcha = !captcha && CAPTCHA_TEXT.test(text);
      const isStuck = !stuck && /currently in a race/i.test(text);
      const isDq = !dq && /disqualified/i.test(text) && !/currently in a race/i.test(text);
      const isKicked = !kicked && !isDq && !isStuck && KICKED_TEXT.test(text) && !/disqualified|currently in a race/i.test(text);
      // Only now check it's actually showing (hidden templates don't count).
      if ((isCaptcha || isStuck || isDq || isKicked) && el.getClientRects().length) {
        captcha ||= isCaptcha;
        stuck ||= isStuck;
        dq ||= isDq;
        kicked ||= isKicked;
      }
    }
    popupScan = { at: now, captcha, stuck, dq, kicked };
    return popupScan;
  }
  const captchaShowing = () => scanPopups().captcha;

  // Logged out (Nitro Type's race state says so): racing on would be as a
  // guest, with nothing saved.
  const loggedOut = () => raceComponent()?.props?.user?.loggedIn === false;
  // Sent to the login page, or a login box on screen (a visible password field).
  const onLoginPage = () =>
    /^\/(?:login|log-in|signin|sign-in|signup|sign-up|register)\b/i.test(location.pathname) ||
    [...document.querySelectorAll('input[type="password"]')].some((el) => el.getClientRects().length);

  // A jump this big in the clock between two steps means the computer was
  // asleep (lid closed, shut down with the tab restored, ...). Without the
  // worker timers a hidden tab's timers can legitimately pause for a minute,
  // so the limit is longer then.
  const ASLEEP_MS = 30000;
  const asleepLimit = () => (timers.usingWorker ? ASLEEP_MS : 5 * 60000);

  /** Your level and season-pass tier, if Nitro Type's race state has them. */
  function readProgress() {
    const u = raceComponent()?.props?.user ?? {};
    const num = (...vals) => vals.map(Number).find((n) => Number.isFinite(n) && n > 0);
    return {
      level: num(u.level, u.profile?.level),
      season: num(u.seasonLevel, u.seasonTier, u.racingSeasonLevel, u.season?.level, u.season?.tier),
    };
  }

  /**
   * Nitro Type's "Currently in a Race" popup: you left a race before it ended
   * and have to wait until it disqualifies you. Returns its "Try Again"
   * button (or null if the popup has none), or undefined when there's no popup.
   */
  function findStuckPopup() {
    if (!scanPopups().stuck) return undefined;
    const buttons = [...document.querySelectorAll("button, a, [role=button]")];
    return buttons.find((b) => /try again/i.test(b.textContent) && b.getClientRects().length) ?? null;
  }

  // =========================================================================
  // 5. Human rhythm
  // =========================================================================

  const COMMON_BIGRAMS = new Set(
    "th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur".split(" "),
  );
  // Words people type without thinking: their letters come faster.
  const COMMON_WORDS = new Set(
    ("the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an " +
      "will my one all would there their what so up out if about who get which go me when make can like time no just him " +
      "know take people into year your good some could them see other than then now look only come its over think also " +
      "back after use two how our work first well way even new want because any these give day most us is are was were " +
      "has had been did said very more much many such where why here").split(" "),
  );

  // Which finger types each key (touch typing), for hand/finger effects.
  // Fingers 0-4 are the left hand (pinky..index), 5-9 the right (index..pinky).
  const FINGER_COLUMNS = [
    [0, 0, 1, 2, 3, 3, 5, 5, 6, 7, 8, 8, 8],
    [0, 1, 2, 3, 3, 5, 5, 6, 7, 8, 8, 8, 8],
    [0, 1, 2, 3, 3, 5, 5, 6, 7, 8, 8],
    [0, 1, 2, 3, 3, 5, 5, 6, 7, 8],
  ];
  const KEY_FINGER = new Map();
  ROWS.forEach((row, r) => [...row].forEach((ch, c) => KEY_FINGER.set(ch, { finger: FINGER_COLUMNS[r][c], hand: FINGER_COLUMNS[r][c] < 5 ? "L" : "R", row: r })));
  const fingerOf = (ch) => (ch === " " ? null : KEY_FINGER.get(baseKey(ch)) ?? null);

  // How strong the human touch is (setting "humanLevel").
  const HUMAN = {
    // off / slow: chance per race of an off race (slower, sloppier) or a slow start
    light: { shape: 0.6, drift: 0.03, pause: 0.5, cluster: 1.25, react: [170, 360], off: 0.04, slow: 0.05 },
    natural: { shape: 1, drift: 0.06, pause: 1, cluster: 1.6, react: [220, 520], off: 0.07, slow: 0.08 },
    strong: { shape: 1.35, drift: 0.1, pause: 1.6, cluster: 2, react: [260, 650], off: 0.1, slow: 0.12 },
  };
  const humanProfile = (s) => HUMAN[s?.humanLevel] ?? HUMAN.natural;

  /** The word that letter i belongs to (lowercase, without punctuation). */
  function wordAt(text, i) {
    let a = i;
    let b = i;
    while (a > 0 && text[a - 1] !== " ") a--;
    while (b < text.length && text[b] !== " ") b++;
    return { start: a, word: text.slice(a, b).toLowerCase().replace(/[^a-z']/g, "") };
  }

  /** How long letter i takes relative to the average (before normalising). */
  function rhythmFactor(text, i, h) {
    const ch = text[i];
    const prev = text[i - 1] ?? " ";
    const progress = i / text.length;
    let f = 1;
    if (ch === " ") {
      f *= 0.82; // thumbs are quick
      // A beat after a sentence, a shorter one after a comma.
      if (/[.!?]/.test(prev)) f *= 1 + 1.4 * h.pause;
      else if (/[,;:]/.test(prev)) f *= 1 + 0.6 * h.pause;
    } else {
      const { start, word } = wordAt(text, i);
      if (i === start) {
        f *= 1.18; // starting a new word
        if (word.length >= 8) f *= 1 + 0.5 * h.pause; // a long word: a moment to read it
      } else if (COMMON_WORDS.has(word)) {
        f *= 0.85; // "the", "and"...: on autopilot
      }
      const a = fingerOf(prev);
      const b = fingerOf(ch);
      if (a && b) {
        if (a.hand !== b.hand) f *= 0.86; // alternating hands: fast
        else if (a.finger === b.finger && baseKey(prev) !== baseKey(ch)) f *= 1.3; // same finger, new key: slow
        f *= 1 + 0.08 * Math.abs(a.row - b.row); // reaching across rows
      }
      if (prev === ch) f *= 0.85; // double letters roll
      else if (COMMON_BIGRAMS.has((prev + ch).toLowerCase())) f *= 0.85;
      if (ch !== ch.toLowerCase()) f *= 1.45; // reach for Shift
      else if (ch >= "0" && ch <= "9") f *= 1.5;
      else if (/[^a-z']/.test(ch)) f *= 1.35; // punctuation
    }
    if (progress < 0.05) f *= 1.4 - (progress / 0.05) * 0.4; // warming up
    else if (progress > 0.9) f *= 0.92; // final push
    return f;
  }

  /**
   * A slow start: the first 15-30% of the race comes slower, easing into
   * the normal pace (not made up for later, so the race ends up a bit slower).
   */
  function slowStart(rhythm) {
    const n = Math.max(1, Math.round(rhythm.length * rand(0.15, 0.3)));
    const k = rand(0.5, 0.9);
    for (let i = 0; i < n && i < rhythm.length; i++) rhythm[i] *= 1 + k * (1 - i / n);
    return rhythm;
  }

  /** Per-letter timing for a race: the rhythm, plus a slow drift in speed. */
  function rhythmFor(text, h = HUMAN.natural) {
    // Speed drifts up and down over the race (two slow waves, random phase).
    const p1 = rand(0, 6.28);
    const p2 = rand(0, 6.28);
    const w1 = rand(0.8, 1.6);
    const w2 = rand(2.2, 3.4);
    const factors = [...text].map((_, i) => {
      const x = i / text.length;
      const drift = 1 + h.drift * (0.65 * Math.sin(6.28 * w1 * x + p1) + 0.35 * Math.sin(6.28 * w2 * x + p2));
      return rhythmFactor(text, i, h) ** h.shape * drift;
    });
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
  const SHAKY_KEYS = 6; // after a typo: this many keys a little slower and more typo-prone
  const PACE_GAIN = 0.3;

  const sleep = (ms) => new Promise((r) => timers.set(r, Math.max(0, ms)));
  const rand = (a, b) => a + Math.random() * (b - a);
  function gaussian() {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }

  // Typo chance per key. Accuracy = right keys / all keys; a space (about
  // 1 key in 6) gets a typo only 60% of the times it's picked (the next
  // letter too early, or a double tap), hence the 1.07.
  const typoChance = (acc) => (acc >= 100 ? 0 : Math.min(0.5, (100 / acc - 1) * 1.07));

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
      listenToServer(); // early, so the countdown signal isn't missed
      // Logged out, at any point in a session (breaks and pauses too), even
      // if Nitro Type sent you to the login page.
      if (this.live && !this.running && Date.now() - (this.loginCheckAt ?? 0) > 1000) {
        this.loginCheckAt = Date.now();
        if (onLoginPage() || (!this.armed && loggedOut())) return void toTop({ kind: "loggedOut" });
      }
      if (this.watchCaptcha && !this.armed) {
        // Paused for a captcha: keep telling the session whether it's there.
        const now = Date.now();
        if (now - (this.captchaToldAt ?? 0) >= 1000) {
          this.captchaToldAt = now;
          toTop({ kind: "captchaState", showing: captchaShowing() });
        }
        return;
      }
      if (!this.armed || this.running || !this.settings) return;
      if (captchaShowing()) return this.captchaStop();
      if (scanPopups().kicked) return this.stopFor("kicked");
      if (loggedOut()) {
        popupScan.at = 0; // a fresh look: a dropped connection logs you out too
        return this.stopFor(scanPopups().kicked ? "kicked" : "loggedOut");
      }
      if (scanPopups().dq) return this.disqualified();
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

    // Stop typing at once and tell the session why ("loggedOut", "asleep").
    stopFor(kind) {
      this.runId++;
      this.running = false;
      // (Logged out / connection dropped: the session says what it's doing.)
      if (kind === "asleep") this.status("Stopped: computer was asleep");
      toTop({ kind });
    },

    // Nitro Type disqualified us. Report it once per popup; the session
    // decides whether to go on (pressing the popup's Race Again) or stop.
    disqualified() {
      const wasRunning = this.running;
      this.runId++;
      this.running = false;
      const race = readRace();
      if (race) {
        this.lastRace = race;
        this.lastRaceFinished = true; // over, one way or another
      }
      if (this.dqReported && !wasRunning) return;
      // Just pressed Race Again on it: the popup is on its way out.
      if (Date.now() - (this.dqLeftAt ?? 0) < 4000) return;
      this.dqReported = true;
      this.status("Disqualified");
      toTop({ kind: "disqualified" });
    },

    // Press Race Again on the "Disqualified!" popup.
    leaveDisqualified() {
      const button = findRaceAgainButton();
      if (button && scanPopups().dq) {
        LOG("clicking Race Again on the disqualified popup");
        clickElement(button);
        this.dqLeftAt = Date.now();
        popupScan.at = 0; // look again next time, the popup is going away
      }
      this.dqReported = false;
    },

    // A captcha showed up: stop typing at once and tell the session (which
    // pauses until it's gone).
    captchaStop() {
      this.runId++;
      this.running = false;
      const race = readRace();
      if (race) {
        this.lastRace = race;
        this.lastRaceFinished = isDone(race);
      }
      this.status("Captcha on the page");
      toTop({ kind: "captcha" });
    },

    // "Currently in a Race" showed up during a race (or while waiting for
    // GO): that race isn't happening. Stop typing, then wait it out. Not a
    // failure: no "Race didn't start".
    stuckStop() {
      this.runId++;
      this.running = false;
      const race = readRace();
      if (race) {
        this.lastRace = race;
        this.lastRaceFinished = true; // over: the next race is a new one
      }
      this.status("Currently in a race");
      this.handleStuck(findStuckPopup());
    },

    // Wait out the "Currently in a Race" popup, then press its Try Again.
    handleStuck(tryAgain) {
      if (this.stuckTimer) return;
      const wait = rand(20000, 30000);
      toTop({ kind: "stuck", waitSec: Math.round(wait / 1000) });
      toTop({ kind: "raceSeen" }); // nothing to reload: just wait
      this.stuckTimer = timers.set(() => {
        this.stuckTimer = 0;
        const button = findStuckPopup();
        if (button) {
          LOG("clicking Try Again");
          clickElement(button);
          popupScan.at = 0; // look again next time, the popup is going away
          toTop({ kind: "say", message: "Pressed Try Again…" });
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
      let target = Math.min(hi, Math.floor(rand(lo, hi + 1)));
      // Accuracy for this race, somewhere in the range (to 0.1%).
      let accTarget = Math.round(rand(Math.min(s.accMin, s.accMax), Math.max(s.accMin, s.accMax)) * 10) / 10;
      const human = humanProfile(s);
      // Now and then an off race (slower and a bit sloppier) or a slow start,
      // like anyone has.
      let offDay = "";
      if (s.offDays) {
        const roll = Math.random();
        offDay = window.__ntAutotyperOffDay ?? (roll < human.off ? "off" : roll < human.off + human.slow ? "slow" : "");
      }
      if (offDay === "off") {
        target = Math.max(10, Math.round(target * rand(0.8, 0.9)));
        if (accTarget < 100) accTarget = Math.max(75, Math.round((accTarget - rand(0.5, 2.5)) * 10) / 10);
      }
      const rhythm = rhythmFor(text, human);
      if (offDay === "slow") slowStart(rhythm);
      const nitroAt = nitroWordStarts(text, s.nitros);
      LOG("race text:", text);
      LOG("letter classes:", [...document.querySelectorAll(".dash-letter")].slice(0, 3).map((el) => el.className));
      LOG("target WPM:", target, "accuracy:", accTarget, "nitro words at:", [...nitroAt]);
      this.dbg = { sent: 0, typos: 0, nitrosTried: 0, nitrosUsed: 0, target, accTarget, offDay };
      this.watchResults.snapshot(); // what's on screen before the race
      this.progressBefore = readProgress(); // level / season tier, to spot a level up
      listenToServer();
      serverRewards = null;
      const player = myUsername();
      if (player) toTop({ kind: "player", name: player });
      this.totalsBefore = savedTotals(); // money / XP / level before the race
      focusRace();

      // Wait for GO. With Nitro Type's race status, the first key comes a
      // human reaction time after GO; without it, keep trying the first key
      // (at uneven intervals) until Nitro Type takes it.
      this.status("Waiting for the race to start…", { target });
      const waitStart = performance.now();
      const reactMs = rand(human.react[0], human.react[1]);
      let reacted = false;
      let race = startRace;
      let probeWall = Date.now();
      while (alive()) {
        if (Date.now() - probeWall > asleepLimit()) return this.stopFor("asleep");
        probeWall = Date.now();
        if (captchaShowing()) return this.captchaStop();
        if (scanPopups().dq) return this.disqualified();
        if (scanPopups().stuck) return this.stuckStop();
        if (scanPopups().kicked) return this.stopFor("kicked");
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
        const signalled = raceSignal.seen && performance.now() - waitStart < 20000;
        if (signalled && !raceSignal.goAt) {
          await sleep(25); // countdown: GO is coming
          continue;
        }
        if (signalled && !reacted) {
          reacted = true;
          await sleep(reactMs - (performance.now() - raceSignal.goAt)); // a person's reaction to GO
          continue;
        }
        pressKey(text[0], rand(40, 90));
        await sleep(signalled ? PROBE_MS : rand(140, 280));
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
      let lastLoopWall = Date.now();
      let lastTypoPos = -1;
      let shakyUntil = -1; // after a typo: a little slower, and more typo-prone
      let nextAt = performance.now();

      while (alive()) {
        await sleep(nextAt - performance.now());
        if (!alive()) return;
        // Woke up from sleep (lid closed, ...): stop before pressing a key.
        if (Date.now() - lastLoopWall > asleepLimit()) return this.stopFor("asleep");
        lastLoopWall = Date.now();
        if (captchaShowing()) return this.captchaStop();
        if (scanPopups().dq) return this.disqualified();
        if (scanPopups().stuck) return this.stuckStop();
        if (scanPopups().kicked) return this.stopFor("kicked");
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
            ms: Math.round(now - startedAt),
            ...(offDay ? { offDay } : {}),
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

        if (now - this.lastLiveAt > (this.settings.lite ? 1000 : 250)) {
          this.lastLiveAt = now;
          const liveWpm = (pos - skipped) / 5 / ((now - startedAt) / 60000);
          this.status("Typing…", { target, pos, len: text.length, wpm: liveWpm, nitros: nitrosUsed, racers: readRacers() });
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
        const shaky = pos <= shakyUntil;
        const baseTypo = typoChance(accTarget);
        // Mistakes come in small clusters: for a few keys after one, another
        // is likelier. Elsewhere a bit less likely, so accuracy stays on target.
        const cluster = Math.max(1, Math.min(human.cluster, 0.7 / (SHAKY_KEYS * baseTypo)));
        const pTypo = shaky
          ? Math.min(0.5, baseTypo * cluster)
          : cluster === 1
            ? baseTypo
            : (baseTypo * (1 - SHAKY_KEYS * cluster * baseTypo)) / (1 - SHAKY_KEYS * baseTypo);
        const perChar = 12000 / target; // 60 s / (wpm * 5 chars)
        const interval = Math.max(5, (perChar - (baseTypo * (REACTION_MS[0] + REACTION_MS[1])) / 2) / (1 + baseTypo));

        // Sometimes hit the wrong key first, then (after a beat) the right one.
        if (lastTypoPos !== pos && Math.random() < pTypo) {
          lastTypoPos = pos;
          const typo = makeTypo(text, pos);
          if (typo) {
            shakyUntil = pos + SHAKY_KEYS;
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

        // Steer toward the target WPM, measured against the rhythm itself
        // (slow and fast letters included), so only real drift gets
        // corrected and the human rhythm survives. Nitro skips don't count.
        if (!pace) pace = { at: now, expected: 0 };
        else pace.expected += perChar * (rhythm[pos] ?? 1);
        const behindMs = now - pace.at - pace.expected;
        const correction = Math.min(1.5 * interval, Math.max(-0.6 * interval, -behindMs * PACE_GAIN));
        const jitter = Math.min(2.5, Math.max(0.35, 1 + gaussian() * (variance / 100)));
        let gap = interval * (rhythm[pos + 1] ?? 1) * jitter * (shaky ? 1.15 : 1) + correction;
        if (text[pos] === " " && Math.random() < HESITATE_CHANCE * human.pause) gap += rand(HESITATE_MS[0], HESITATE_MS[1]);
        nextAt = Math.max(nextAt, now - interval) + Math.max(2, gap);
      }
    },

    finishRun(id, message, result) {
      if (id !== this.runId) return;
      this.running = false;
      this.status(message, result ? { target: result.target, wpm: result.wpm, done: true } : {});
      if (result) {
        raceSignal.goAt = 0; // the next race waits for its own GO
        this.lastRaceFinished = true;
        toTop({ kind: "raceDone", result });
        this.watchResults.start(result.at);
      } else {
        toTop({ kind: "raceFailed", message });
      }
    },

    // ---- Nitro Type's own results ------------------------------------------
    //
    // After the finish line: your official WPM, accuracy and place from the
    // race state; money and XP (and everyone's rows) from the results screen.
    // If neither exists, fall back to a small block of new text that mentions
    // WPM exactly once (so a table of every racer, or a "your average WPM"
    // widget that was there before the race, doesn't count).
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
          const elapsed = Date.now() - startedAt;
          const state = officialFromState();
          const screen = readResultsScreen();
          let text = null;
          if (!screen) {
            text =
              resultCandidates()
                .filter((c) => !this.before.has(c.text) && (c.text.match(/wpm/gi) || []).length === 1)
                .map((c) => parseResults(c.text))
                .find((r) => r.wpm) ?? null;
          }
          // Money and XP: totals after minus before (the race update's totals,
          // or the saved state once it has changed).
          const before = engine.totalsBefore ?? {};
          const sent = finishedTotals();
          const saved = savedTotals();
          const diff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && a - b >= 0 && a - b < 1e7 ? a - b : undefined);
          const earned = sent
            ? { money: diff(sent.money, before.money), xp: diff(sent.xp, before.xp), level: sent.level, from: "race update" }
            : {
                money: diff(saved.money, before.money) || undefined,
                xp: diff(saved.xp, before.xp) || undefined,
                level: saved.level,
                from: "saved state",
              };
          const haveEarned = earned.money !== undefined || earned.xp !== undefined;
          // Wait a moment for the money and XP (and the results screen).
          const ready =
            (state && (haveEarned || screen?.money !== undefined || elapsed > 6000)) ||
            (screen && screen.wpm && (haveEarned || elapsed > 3000)) ||
            (text && elapsed > 1500) ||
            elapsed > 10000;
          if (!ready) {
            timers.set(poll, 400);
            return;
          }
          const pick = (k) => state?.[k] ?? screen?.[k] ?? text?.[k];
          const official = {
            wpm: pick("wpm"),
            accuracy: pick("accuracy"),
            place: pick("place"),
            money: earned.money ?? screen?.money ?? text?.money,
            xp: earned.xp ?? screen?.xp ?? text?.xp,
            racers: readRacers() ?? screen?.racers ?? null,
            source: state ? "race state" : screen ? "results screen" : "page text",
            moneySource: earned.money !== undefined ? earned.from : screen?.money !== undefined ? "results screen" : text?.money !== undefined ? "page text" : "not found",
            ...levelChanges(engine.progressBefore, { before: before.level, after: earned.level }),
          };
          if (!official.wpm) {
            this.found = { notFound: true };
            return;
          }
          this.found = official;
          LOG("Nitro Type results:", official);
          toTop({ kind: "raceResult", at: raceAt, official });
        };
        timers.set(poll, 300);
      },
    },

    // (see levelChanges below)

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
        raceState: raceComponent() ? `found, ${readRacers()?.length ?? 0} racers` : "not found (#raceContainer)",
        progress: (() => {
          const pr = readProgress();
          return `level ${pr.level ?? "?"}, season tier ${pr.season ?? "?"}`;
        })(),
        captcha: captchaShowing() ? "SHOWING" : "none",
        results: !found ? "-" : found.notFound ? "not found" : `${found.wpm} WPM, ${found.accuracy ?? "?"}%, place ${found.place ?? "?"} (from ${found.source})`,
        rewards: !found || found.notFound ? "-" : `$${found.money ?? "?"}, ${found.xp ?? "?"} XP (from ${found.moneySource})`,
        totals: (() => {
          const t = savedTotals();
          return `money ${t.money ?? "?"}, XP ${t.xp ?? "?"}, level ${t.level ?? "?"}`;
        })(),
        miniMap: miniMap.host ? "on (race track hidden)" : engine.settings?.miniMap ? "waiting for the race track" : "off",
        keepAlive: !engine.settings?.keepAlive ? "off" : keepAliveActive() ? `ACTIVE (hidden; ${frames.size} frames, ${pageTimers.size} timers on the worker clock)` : document.hidden ? "ready (no session)" : "ready (tab visible)",
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

    // A fresh race page: to reconnect, or after a long break. Never while
    // typing a race. (Only the top page reloads; frames come with it.)
    refreshPage() {
      if (!IS_TOP || this.running) return;
      LOG("loading a fresh race page");
      // Somewhere else (the login page, the garage...): go to the race page.
      if (!/^\/race\b/i.test(location.pathname)) location.href = "/race";
      else location.reload();
    },

    reloadRace() {
      if (!this.onResultsScreen()) return;
      LOG("no new race after Race Again: reloading the race page");
      location.reload();
    },
  };

  timers.every(() => engine.tick(), 250);

  // =========================================================================
  // 6b. Mini map (replaces Nitro Type's race track)
  // =========================================================================
  //
  // Five lanes, start and finish lines, a block per racer (you, players,
  // bots, the Wampus), an orange streak for nitros, places at the finish.
  // Inspired by Toonidy's "Nitro Type - Racing Mini Map" (MIT). Nitro Type's
  // track canvas is only hidden, never removed, and comes back when the map
  // is turned off. Everything moves with transforms; nothing runs while the
  // tab is hidden.

  const MINIMAP_CSS = `
    :host { all: initial; display: block; }
    .map {
      position: relative; height: 128px; margin: 0 0 6px; overflow: hidden; border-radius: 8px;
      background: #20222e; container-type: inline-size; contain: layout paint style;
      font: 600 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .lanes { position: absolute; inset: 0; background: repeating-linear-gradient(to bottom, transparent 0 calc(20% - 1px), #3a3e52 calc(20% - 1px) 20%); }
    .start, .finish { position: absolute; top: 0; bottom: 0; width: 2px; }
    .start { left: 36px; background: #8b8fa3; }
    .finish { right: 36px; background: repeating-linear-gradient(to bottom, #e8ebf5 0 4px, #20222e 4px 8px); }
    .car {
      --p: 0; position: absolute; left: 4px; width: 32px; height: calc(20% - 8px); margin-top: 4px;
      transform: translateX(calc(var(--p) * (100cqw - 76px))); transition: transform .4s linear; will-change: transform;
    }
    .body { position: absolute; inset: 0; border-radius: 5px; background: var(--c); box-shadow: 0 0 0 2px #20222e; }
    .me { --c: #f2887f; } .player { --c: #5097e3; } .bot { --c: #b8bac4; } .wampus { --c: #bc530d; }
    .me .body { box-shadow: 0 0 0 2px #20222e, 0 0 10px rgba(242, 136, 127, .55); }
    .label {
      position: absolute; top: 50%; left: calc(100% + 6px); transform: translateY(-50%);
      color: #c9ccd8; white-space: nowrap; text-shadow: 0 1px 2px #000;
    }
    .me .label { color: #ffd6d1; }
    .flip .label { left: auto; right: calc(100% + 6px); }
    .nitro { position: absolute; top: calc(50% - 1px); right: 100%; height: 3px; width: 0; border-radius: 2px; background: #ef9e18; opacity: 0; }
    .lite .car { transition: none; }
  `;

  const miniMap = {
    host: null,
    canvas: null,
    cars: new Map(), // racer id -> { el, p, skipped }
    lastAt: 0,
    boosts: 0,

    sync() {
      const s = engine.settings;
      const container = document.getElementById("raceContainer");
      const canvas = container?.querySelector("canvas");
      if (!s?.miniMap || !container || !canvas || !readRace()) return this.remove();
      if (!this.host || !this.host.isConnected) this.build(canvas);
      if (canvas.style.display !== "none") {
        this.canvas = canvas;
        this.canvasDisplay = canvas.style.display;
        canvas.style.display = "none";
      }
      if (document.hidden) return;
      const now = Date.now();
      if (s.lite && now - this.lastAt < 1000) return;
      this.lastAt = now;
      this.update(s);
    },

    build(canvas) {
      this.remove();
      this.host = document.createElement("div");
      this.host.className = "nta-minimap";
      this.root = this.host.attachShadow({ mode: "open" });
      setHTML(this.root, `<style>${MINIMAP_CSS}</style><div class="map"><div class="lanes"></div><div class="start"></div><div class="finish"></div></div>`);
      this.map = this.root.querySelector(".map");
      this.cars = new Map();
      canvas.before(this.host);
    },

    remove() {
      if (this.host) this.host.remove();
      this.host = null;
      if (this.canvas) this.canvas.style.display = this.canvasDisplay ?? "";
      this.canvas = null;
    },

    update(s) {
      this.map.classList.toggle("lite", Boolean(s.lite));
      const race = readRace();
      let racers = readRacers();
      if (!racers?.length) racers = [{ id: "me", me: true, kind: "me", name: "You", pct: 0, skipped: 0, done: false }];
      const width = this.map.clientWidth;
      const seen = new Set();
      racers.slice(0, 5).forEach((r, i) => {
        const id = r.id ?? `r${i}`;
        seen.add(id);
        let car = this.cars.get(id);
        if (!car) {
          const el = document.createElement("div");
          el.innerHTML = htmlPolicy ? htmlPolicy.createHTML('<i class="nitro"></i><b class="body"></b><span class="label"></span>') : '<i class="nitro"></i><b class="body"></b><span class="label"></span>';
          this.map.append(el);
          car = { el, p: 0, skipped: r.skipped || 0 };
          this.cars.set(id, car);
        }
        // You: from the letters on screen (instant); others: race state.
        const p = r.me && race && race.pos !== null ? Math.min(1, race.pos / race.text.length) : r.done ? 1 : r.pct;
        const lane = Math.min(4, Math.max(0, r.lane ?? i));
        car.el.className = `car ${r.kind || (r.me ? "me" : "bot")}${p > 0.72 ? " flip" : ""}`;
        car.el.style.top = `${lane * 20}%`;
        // A nitro jump: an orange streak from where it started, fading out.
        if ((r.skipped || 0) > car.skipped && p > car.p) {
          const streak = car.el.firstChild;
          streak.style.width = `${Math.round((p - car.p) * (width - 76))}px`;
          streak.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 1400, easing: "ease-out" });
          this.boosts++;
          this.host.dataset.boosts = String(this.boosts);
        }
        car.skipped = r.skipped || 0;
        car.p = p;
        car.el.style.setProperty("--p", p.toFixed(4));
        const label = r.done && r.place ? `${ordinalOf(r.place)} · ${r.me ? "You" : r.name}` : r.me ? "You" : r.name;
        const labelEl = car.el.lastChild;
        if (labelEl.textContent !== label) labelEl.textContent = label;
      });
      for (const [id, car] of this.cars) {
        if (!seen.has(id)) {
          car.el.remove();
          this.cars.delete(id);
        }
      }
    },
  };
  timers.every(() => miniMap.sync(), 250);
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
      if (e.key === "Escape" && engine.focusOpen) {
        // Esc only closes the focus view; it doesn't stop the typing.
        toTop({ kind: "closeFocus" });
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
    if (typeof msg.focus === "boolean") engine.focusOpen = msg.focus;
    // Carrying on after a captcha: if the finished race is still on screen,
    // ask for the next one (a race in progress just gets typed).
    const resuming = engine.watchCaptcha && msg.watchCaptcha === false && msg.armed === true;
    if (typeof msg.watchCaptcha === "boolean") engine.watchCaptcha = msg.watchCaptcha;
    if (typeof msg.armed === "boolean") engine.setArmed(msg.armed);
    if (resuming) {
      const race = readRace();
      if (race && isDone(race)) toTop({ kind: "needNext" });
    }
    // Keep Nitro Type's page running for the whole session, not just while
    // typing: during breaks, captcha pauses and between races too. A page left
    // idle in the background goes quiet, and Nitro Type drops the connection
    // (logged out, kicked for inactivity).
    if (typeof msg.live === "boolean") engine.live = msg.live;
    setKeepAlive(Boolean((engine.armed || engine.live) && engine.settings?.keepAlive));
    if (msg.cmd === "refresh") engine.refreshPage();
    if (msg.cmd === "next") engine.nextRace();
    if (msg.cmd === "leaveDq") engine.leaveDisqualified();
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
    humanLevel: "natural", // how human the typing is: light, natural, strong
    offDays: true, // now and then an off race or a slow start
    breakEvery: 0, breakLenMin: 1, breakLenMax: 3, // long break every ~N races (0 = off), minutes
    notify: false, debug: false, notifyAlways: false, alarmSound: true, notifySound: true,
    // which notifications (all need "notify" on)
    notifyRace: true, notifyLevel: true, notifySeason: true, notifySession: true, notifyMilestone: true, notifyCaptcha: true,
    // How each notification type is delivered: off, low (chime), normal
    // (pop-up), high (chime + pop-up), urgent (alarm + pop-up that stays).
    levelRace: "low", levelLevel: "normal", levelSeason: "normal", levelMilestone: "high", levelSession: "high", levelCaptcha: "urgent", levelLoggedOut: "urgent", levelProblem: "high",
    stopOnLock: false, // stop the session when the computer's screen locks
    lite: false, // Low-FPS mode: fewer panel updates, no animations
    miniMap: true, // show a mini map in place of Nitro Type's race track
    keepAlive: true, // keep Nitro Type's page running while minimised (during a session)
  };
  const BOOLEAN_SETTINGS = ["notify", "debug", "notifyRace", "notifyLevel", "notifySeason", "notifySession", "notifyMilestone", "notifyCaptcha", "stopOnLock", "lite", "notifyAlways", "miniMap", "keepAlive", "alarmSound", "notifySound", "offDays"];
  const LIMITS = {
    wpmMin: [10, 300], wpmMax: [10, 300], accMin: [80, 100], accMax: [80, 100], variance: [0, 60],
    nitros: [0, 10], races: [1, 500], breakEvery: [0, 100], breakLenMin: [0.1, 30], breakLenMax: [0.1, 30],
  };
  // Settings that come as a min/max pair.
  const PAIRS = { wpmMin: "wpmMax", accMin: "accMax", breakLenMin: "breakLenMax" };
  const KEYS = {
    settings: "nt-autotyper-settings",
    stats: "nt-autotyper-stats",
    days: "nt-autotyper-days", // day totals of races too old to keep one by one
    ui: "nt-autotyper-ui",
    session: "nt-autotyper-session",
    player: "nt-autotyper-player",
  };

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

  // Notification types (defined here: settings need them).
  const NOTIFY = {
    race: { level: "levelRace", old: "notifyRace", title: "Race finished" },
    level: { level: "levelLevel", old: "notifyLevel", title: "Level up!" },
    season: { level: "levelSeason", old: "notifySeason", title: "Season pass" },
    milestone: { level: "levelMilestone", old: "notifyMilestone", title: "★ Milestone" },
    session: { level: "levelSession", old: "notifySession", title: "NT Autotyper session" },
    captcha: { level: "levelCaptcha", old: "notifyCaptcha", title: "⚠ CAPTCHA: session paused" },
    // Logged out (or the session stuck with no races): the session stopped.
    loggedOut: { level: "levelLoggedOut", old: "notifyLoggedOut", title: "⚠ LOGGED OUT" },
    // Disqualified, logged out, computer asleep, keys not accepted, ...
    problem: { level: "levelProblem", old: "notifySession", title: "⚠ NT Autotyper" },
  };
  // off < low (chime only) < normal (pop-up) < high (chime + pop-up) < urgent
  // (alarm beep + a pop-up that stays on screen and re-alerts)
  const NOTIFY_LEVELS = ["off", "low", "normal", "high", "urgent"];

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
    for (const key of BOOLEAN_SETTINGS) s[key] = Boolean(s[key]);
    if (!(s.humanLevel in HUMAN)) s.humanLevel = DEFAULTS.humanLevel;
    for (const kind of Object.values(NOTIFY)) {
      // A type switched off in an older version stays off.
      if (raw[kind.level] === undefined && raw[kind.old] === false) s[kind.level] = "off";
      if (!NOTIFY_LEVELS.includes(s[kind.level])) s[kind.level] = DEFAULTS[kind.level];
    }
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
    player: "", // your Nitro Type username, shown in notification titles
    init() {
      this.player = readJSON(localStorage, KEYS.player, "") || "";
      if (LOADED_LATE) {
        this.message = 'Loaded late, so it may not type. In Tampermonkey settings set Content Script API to "UserScripts API Dynamic", then reload.';
      }
      this.state = { ...this.state, ...readJSON(sessionStorage, KEYS.session, {}) };
      // Reloaded while paused for a captcha: keep waiting for it to go.
      if (this.state.paused) this.captchaSeenAt = Date.now();
      this.stats = readJSON(localStorage, KEYS.stats, []);
      this.days = readJSON(localStorage, KEYS.days, {});
      this.lastActivity = Date.now(); // a fresh page: give it time
      // Chrome restores a tab's session storage after a restart, a crash or
      // sleep. A session whose last heartbeat is old was interrupted: end it
      // instead of picking up typing again.
      if (this.state.active && Date.now() - (this.state.beat ?? 0) > asleepLimit()) {
        this.state.active = false;
        this.state.breakUntil = 0;
        this.state.paused = "";
        this.save();
        // Chrome's Memory Saver puts background tabs to sleep, then reloads them
        // when you come back.
        this.message = document.wasDiscarded
          ? "Stopped: Chrome put this tab to sleep to save memory. In Chrome's Settings → Performance, add nitrotype.com under \"Always keep these sites active\", then press Start."
          : "Stopped: the browser was closed or the computer was off. Press Start to go again.";
        this.messageAt = Date.now();
      }
    },
    // Every few seconds while a session runs; also notices sleep.
    heartbeat() {
      const now = Date.now();
      const gap = now - (this.lastBeat ?? now);
      this.lastBeat = now;
      if (!this.state.active) return;
      if (gap > asleepLimit()) {
        this.stop("Stopped: your computer was asleep");
        return;
      }
      this.state.beat = now;
      this.save();
      // A session that's gone quiet (no race at all, not on a break or a
      // captcha pause): something's wrong. Reload; if that doesn't help, stop
      // and sound the alarm.
      if (this.onBreak() || this.paused() || this.reconnectTimer) this.lastActivity = now;
      else if (now - (this.lastActivity ?? now) > stallMs()) this.reconnect("stalled");
    },
    // Something happened (a race showed up, finished, a popup was handled).
    touch() {
      this.lastActivity = Date.now();
    },
    // Nitro Type's "Currently in a Race": you're still in an earlier race
    // (left before it ended). It disqualifies you from that one, then lets
    // you race again. The engine waits, then presses Try Again.
    stuck(waitSec) {
      if (!this.state.active) return;
      this.touch();
      const now = Date.now();
      this.stuckAt = now;
      timers.clear(this.fallbackTimer); // never reload now: that makes it worse
      this.say(`Currently in a race: Nitro Type still has you in your last race. Pressing Try Again in ${waitSec}s…`);
      // One notification per episode, not one per Try Again.
      if (now - (this.stuckToldAt ?? 0) > 3 * 60000) {
        this.stuckToldAt = now;
        notify(
          "problem",
          `Nitro Type still has you in your last race. That's expected after leaving a race early; nothing failed. The script waits it out, presses Try Again in about ${waitSec}s, and carries on.`,
          { title: "Currently in a race" },
        );
      }
    },
    disqualified() {
      if (!this.state.active) return;
      this.touch();
      // Right after "Currently in a Race": that's the old race ending. Expected,
      // so it doesn't count toward "disqualified twice in a row".
      if (Date.now() - (this.stuckAt ?? 0) < 5 * 60000) {
        this.stuckAt = 0;
        notify("problem", "From the race you were still in (after \"Currently in a race\"). Expected; going on to the next race.", { title: "Disqualified" });
        this.say("Disqualified from the old race. Next race soon…");
        timers.clear(this.nextTimer);
        this.nextTimer = timers.set(() => this.state.active && toEngines({ cmd: "leaveDq" }), rand(3000, 6000));
        return;
      }
      this.dqInARow = (this.dqInARow ?? 0) + 1;
      if (this.dqInARow >= 2) {
        this.stop("Stopped: disqualified twice in a row");
        return;
      }
      notify("problem", "Disqualified for inactivity. Going on to the next race.", { title: "Disqualified" });
      this.say("Disqualified. Next race soon…");
      timers.clear(this.nextTimer);
      this.nextTimer = timers.set(() => this.state.active && toEngines({ cmd: "leaveDq" }), rand(3000, 6000));
    },
    save() {
      writeJSON(sessionStorage, KEYS.session, this.state);
    },
    onBreak() {
      return this.state.active && Date.now() < this.state.breakUntil;
    },
    paused() {
      return this.state.active && Boolean(this.state.paused);
    },
    sync() {
      // Engines stay disarmed during a break or a captcha pause, even if a
      // race shows up. While paused, they watch for the captcha to go.
      // "live": a session is on (keeps Nitro Type's page running throughout).
      const paused = this.paused();
      toEngines({ settings: loadSettings(), armed: this.state.active && !this.onBreak() && !paused, watchCaptcha: paused, live: this.state.active });
    },
    // Logged out, or Nitro Type dropped the connection: usually a fresh page
    // reconnects you (your login is in the browser; the script never touches
    // it). Stops if it keeps happening.
    reconnect(why) {
      if (!this.state.active || this.reconnectTimer) return;
      const now = Date.now();
      const recent = (this.state.reconnects ?? []).filter((t) => now - t < 30 * 60000);
      // Still logged out right after a fresh page: you really are logged out.
      if (why === "loggedOut" && recent.some((t) => now - t < 2 * 60000)) {
        this.stop(LOGGED_OUT_TEXT, { silent: true });
        alarm.start("loggedOut"); // urgent: beeps, a pop-up that stays, a flashing tab title
        return;
      }
      if (why === "stalled" && recent.some((t) => now - t < 15 * 60000)) {
        this.stop("Stopped: no race for 10 minutes, even after reloading. Logged out? A popup in the way?", { silent: true });
        alarm.start("stalled");
        return;
      }
      if (recent.length >= 4) {
        this.stop("Stopped: Nitro Type keeps dropping the connection");
        return;
      }
      this.state.reconnects = [...recent, now];
      this.save();
      timers.clear(this.nextTimer);
      timers.clear(this.fallbackTimer);
      this.lastActivity = now;
      const message =
        why === "loggedOut"
          ? "Nitro Type shows you as logged out. Reloading the race page to reconnect (your login itself is untouched)…"
          : why === "stalled"
            ? "No race for 5 minutes. Loading the race page again…"
            : "Nitro Type dropped the connection. Reloading the race page to reconnect…";
      this.say(message);
      notify("problem", message, { title: "Reconnecting" });
      this.reconnectTimer = timers.set(() => {
        this.reconnectTimer = 0;
        if (!this.state.active) return;
        this.state.beat = Date.now(); // a reload, not a shutdown
        this.save();
        toEngines({ cmd: "refresh" });
      }, rand(3000, 6000));
    },
    pickBreakAfter(s) {
      if (!s.breakEvery) return 0;
      // Roughly every N races, +/- 20%, so breaks don't land like clockwork.
      return Math.max(1, Math.round(s.breakEvery * rand(0.8, 1.2)));
    },
    start() {
      const s = loadSettings();
      alarm.stop();
      alarm.unlock(); // Start is a click: the browser lets the alarm sound later
      this.dqInARow = 0;
      this.touch();
      this.state = { active: true, total: s.races, done: 0, sinceBreak: 0, breakAfter: this.pickBreakAfter(s), breakUntil: 0, paused: "", startAt: Date.now(), beat: Date.now() };
      this.save();
      this.sync();
      this.say("Waiting for a race…");
    },
    stop(message, { silent = false } = {}) {
      timers.clear(this.fallbackTimer);
      timers.clear(this.nextTimer);
      const wasActive = this.state.active;
      const wasPaused = this.paused();
      this.state.active = false;
      this.state.breakUntil = 0;
      this.state.paused = "";
      this.save();
      this.sync();
      if (wasPaused) alarm.stop();
      // Leave a mark in the tab title (and maybe a notification) if you
      // weren't watching.
      if (document.hidden) titleFlash = message.startsWith("Done") ? `✓ ${message}` : `■ ${message}`;
      if (message.startsWith("Done")) {
        // The summary waits a moment for the last race's money and XP.
        timers.clear(this.summaryTimer);
        this.summaryTimer = timers.set(() => this.sendSummary(), 6000);
      } else if (!silent && wasActive && !message.includes("you pressed")) {
        notify("problem", message);
      }
      this.say(message);
    },
    sendSummary() {
      timers.clear(this.summaryTimer);
      this.summaryTimer = 0;
      const races = this.stats.filter((r) => r.at >= (this.state.startAt ?? 0));
      if (!races.length) return;
      const wpm = average(races.map((r) => r.official?.wpm ?? r.wpm));
      const acc = average(races.map((r) => r.official?.accuracy ?? r.accuracy));
      const money = races.reduce((a, r) => a + (r.official?.money ?? 0), 0);
      const xp = races.reduce((a, r) => a + (r.official?.xp ?? 0), 0);
      const wins = races.filter((r) => r.official?.place === 1).length;
      const parts = [
        `${races.length} race${races.length === 1 ? "" : "s"}`,
        `avg ${Math.round(wpm)} WPM`,
        `${acc.toFixed(1)}%`,
        wins ? `${wins} win${wins === 1 ? "" : "s"}` : "",
        money ? `+$${money.toLocaleString()}` : "",
        xp ? `+${xp.toLocaleString()} XP` : "",
      ];
      notify("session", parts.filter(Boolean).join(" · "));
    },
    // After each race: a note with how it went, plus any level up, season
    // reward or milestone. Waits for Nitro Type's official numbers, or uses
    // the script's estimate if they never show up.
    noteRace(race) {
      timers.clear(this.raceNoteTimers?.get(race.at));
      this.raceNoteTimers?.delete(race.at);
      const o = race.official ?? {};
      const wpm = Math.round(o.wpm ?? race.wpm);
      const acc = (o.accuracy ?? race.accuracy).toFixed(1);
      const parts = [
        o.place ? ordinalOf(o.place) : "",
        `${wpm} WPM`,
        `${acc}%`,
        Number.isFinite(o.money) ? `+$${o.money.toLocaleString()}` : "",
        Number.isFinite(o.xp) ? `+${o.xp.toLocaleString()} XP` : "",
      ];
      notify("race", parts.filter(Boolean).join(" · "));
      if (o.levelUp) notify("level", typeof o.levelUp === "number" ? `You reached level ${o.levelUp}!` : "You levelled up!");
      if (o.seasonUp) notify("season", typeof o.seasonUp === "number" ? `Season pass tier ${o.seasonUp} unlocked` : "New season pass reward unlocked");
      // Milestones
      const earlier = this.stats.filter((r) => r !== race);
      const wpmOf = (r) => r.official?.wpm ?? r.wpm;
      if (earlier.length >= 5 && wpm > Math.max(...earlier.map(wpmOf))) notify("milestone", `New personal best: ${wpm} WPM!`);
      if (o.place === 1) {
        const wins = this.stats.filter((r) => r.official?.place === 1).length;
        const last3 = this.stats.slice(-3);
        if (last3.length === 3 && last3.every((r) => r.official?.place === 1)) notify("milestone", "Hat trick: 3 wins in a row!");
        else if (wins % 5 === 0) notify("milestone", `That's ${wins} wins!`);
      }
      // The last race of the session: send the summary now.
      if (this.summaryTimer && race === this.stats[this.stats.length - 1]) this.sendSummary();
    },
    raceNoteTimers: new Map(),
    // A captcha: pause (not stop). Once you've solved it and it's gone, the
    // session carries on by itself.
    captcha() {
      if (!this.state.active || this.paused()) return;
      timers.clear(this.nextTimer);
      timers.clear(this.fallbackTimer);
      this.state.paused = "captcha";
      this.state.breakUntil = 0;
      this.captchaSeenAt = Date.now();
      this.captchaFrames = new Map();
      this.save();
      this.sync();
      this.say(CAPTCHA_PAUSED);
      alarm.start();
    },
    // From each frame, about once a second while paused. The captcha may be
    // in any one frame; it's gone when no frame shows it any more.
    captchaState(showing, source) {
      if (!this.paused()) return;
      const now = Date.now();
      (this.captchaFrames ??= new Map()).set(source, { showing, at: now });
      if ([...this.captchaFrames.values()].some((f) => f.showing && now - f.at < 5000)) {
        this.captchaSeenAt = now;
        if (this.message !== CAPTCHA_PAUSED) this.say(CAPTCHA_PAUSED);
        return;
      }
      // Gone for a few seconds (no frame still showing it): carry on.
      const gone = now - (this.captchaSeenAt ?? 0);
      if (gone >= CAPTCHA_GONE_MS) this.resume();
      else this.say("Captcha gone. Carrying on in a moment…");
    },
    resume() {
      if (!this.paused()) return;
      this.state.paused = "";
      this.state.beat = Date.now();
      this.save();
      alarm.stop();
      panel.clearToasts?.((title) => title.startsWith(NOTIFY.captcha.title));
      this.sync();
      this.say("Captcha solved. Carrying on…");
      panel.toast?.("normal", "Captcha solved", "The session is carrying on by itself.");
    },
    toggle() {
      if (this.state.active) this.stop("Stopped");
      else this.start();
    },
    raceStarted() {
      timers.clear(this.fallbackTimer);
      this.touch();
    },
    raceDone(result) {
      this.touch();
      this.dqInARow = 0;
      this.stats.push(result);
      if (this.stats.length > 300) {
        // The oldest races go into day totals, so the By day chart keeps them.
        for (const old of this.stats.splice(0, this.stats.length - 300)) addToDay(this.days, old);
        pruneDays(this.days);
        writeJSON(localStorage, KEYS.days, this.days);
      }
      writeJSON(localStorage, KEYS.stats, this.stats);
      // If Nitro Type's own numbers don't arrive, note the race with ours.
      this.raceNoteTimers.set(result.at, timers.set(() => this.noteRace(result), 11000));
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
        this.state.breakLen = ms;
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
      race.official = {
        wpm: official.wpm,
        accuracy: official.accuracy,
        place: official.place,
        money: official.money,
        xp: official.xp,
        racers: official.racers?.slice(0, 8).map((r) => ({ name: String(r.name).slice(0, 40), me: r.me, wpm: r.wpm, place: r.place, done: r.done, pct: r.pct })),
        levelUp: official.levelUp,
        seasonUp: official.seasonUp,
      };
      writeJSON(localStorage, KEYS.stats, this.stats);
      panel.render();
      if (this.raceNoteTimers.has(at)) this.noteRace(race);
    },
    scheduleNext(delay) {
      timers.clear(this.nextTimer);
      this.nextTimer = timers.set(() => {
        if (!this.state.active) return;
        if (this.state.breakUntil) {
          const long = (this.state.breakLen ?? 0) >= longBreakMs();
          this.state.breakUntil = 0;
          this.state.beat = Date.now();
          this.save();
          this.sync();
          if (long) {
            // After minutes of sitting idle, Nitro Type's connection may be
            // stale: start from a fresh race page instead of Race Again.
            this.say("Back from the break: loading a fresh race page…");
            toEngines({ cmd: "refresh" });
            return;
          }
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
      this.days = {};
      writeJSON(localStorage, KEYS.stats, this.stats);
      writeJSON(localStorage, KEYS.days, this.days);
      panel.render();
    },
  };

  // Progress in the tab title, so you can follow a background tab:
  // "▶ 2/5 · Nitro Type", then "✓ Done: 5 races · …" until you look at it.
  const TITLE_PREFIX = /^(?:(?:[▶✓■⚠]|❚❚) [^·]* · )+/; // ours, however many piled up
  let titleFlash = "";
  function updateTitle() {
    if (!IS_TOP) return;
    const base = document.title.replace(TITLE_PREFIX, "");
    let prefix = "";
    if (session.paused()) prefix = `${titleFlash || "❚❚ Captcha"} · `;
    else if (session.onBreak()) prefix = `❚❚ ${session.state.done}/${session.state.total} · `;
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

  const ordinalOf = (n) => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`);

  // Desktop notifications: each type has its own switch, and all need the
  // main switch on and the browser's permission. Only when you're not
  // looking at the tab, except the ones marked "always" (captchas).
  //
  // Priority, lowest to highest:
  //   1 race finished      silent
  //   2 level up / season  normal (with the system's sound)
  //   3 milestone          normal, marked with a star
  //   4 session done       stays on screen until you dismiss it
  //   5 captcha            stays on screen, re-alerts, plus an alarm in the page

  // Every time, whether or not you're looking at the tab.
  function notify(type, message, { title: ownTitle } = {}) {
    const s = loadSettings();
    const kind = NOTIFY[type];
    if (!kind || !s.notify) return;
    const level = s[kind.level];
    if (level === "off") return;
    // "Race finished · yourname"
    const base = ownTitle ?? kind.title;
    const title = session.player ? `${base} · ${session.player}` : base;
    deliver(level, title, message, `nt-autotyper-${type}`);
  }

  /**
   * Deliver a notification at a level: the sound, the system pop-up, and a
   * pop-up inside the page (seen even in full screen, where the system may
   * hide its own). Returns the system pop-up's outcome via onResult.
   */
  let noteSeq = 0;
  // What happened to the last system pop-up: "shown", "not allowed", "error…",
  // or "unconfirmed" (Chrome never said). The panel warns when they're not
  // getting through, instead of only the sound playing.
  let noteHealth = { result: "", at: 0 };
  function deliver(level, title, body, tag, onResult) {
    if (level === "low" || level === "high") alarm.chime();
    if (level === "urgent") alarm.beep();
    if (level === "low") return void onResult?.("chime only");
    panel.toast?.(level, title, body);
    // A fresh tag every time: reusing one makes the system quietly replace
    // the previous notification instead of popping up a new one.
    let reported = false;
    const report = (result) => {
      if (reported) return;
      reported = true;
      noteHealth = { result, at: Date.now() };
      panel.noteHealthChanged?.();
      onResult?.(result);
    };
    timers.set(() => report("unconfirmed"), 8000);
    showNotification(title, body, `${tag}-${Date.now()}-${++noteSeq}`, level, report);
  }

  // Notifications are kept referenced until Chrome reports on them, so none
  // gets cleaned up before it's shown. Only the options a priority needs are
  // set: plain ones are as plain as possible (some setups mishandle extras).
  const liveNotifications = new Set();
  function showNotification(title, body, tag, level = "normal", onResult) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      onResult?.("not allowed");
      return false;
    }
    // (onResult reports "shown" / "error" below)
    try {
      const options = { body, tag };
      if (level === "urgent") {
        options.requireInteraction = true; // stays until dismissed
        options.renotify = true; // alerts again even with the same tag
      }
      const n = new Notification(title, options);
      liveNotifications.add(n);
      const done = (result) => {
        onResult?.(result);
        onResult = null;
      };
      n.onshow = () => done("shown");
      n.onerror = () => {
        liveNotifications.delete(n);
        done("error");
      };
      n.onclose = () => liveNotifications.delete(n);
      // Clicking a notification brings you to the race tab.
      n.onclick = () => {
        window.focus();
        n.close();
      };
      timers.set(() => liveNotifications.delete(n), 10 * 60000);
      return true;
    } catch (err) {
      /* some browsers only allow notifications from a service worker */
      onResult?.(`error: ${err.message}`);
      return false;
    }
  }

  // The captcha alarm: the top-priority notification (re-sent every minute,
  // up to 5 times), a beep, a flashing tab title and a red panel, until you
  // come back to the tab or press Start.
  const ALARM_REPEAT_MS = 60000;
  const ALARM_MAX = 5;
  const CAPTCHA_TEXT_BODY = "Nitro Type is asking for a captcha. The session is paused: solve it yourself, and it carries on by itself.";
  const CAPTCHA_PAUSED = "Paused: solve the captcha and I'll carry on by myself";
  const CAPTCHA_GONE_MS = 2500; // the captcha has to stay gone this long
  const LOGGED_OUT_TEXT = "Stopped: you're logged out of Nitro Type. Log back in, then press Start.";
  // The alarms: what they say, and how the tab title flashes.
  const ALARMS = {
    captcha: { type: "captcha", body: () => CAPTCHA_TEXT_BODY, test: "TEST: this is what a captcha alert looks like.", flash: ["⚠ CAPTCHA", "■ Captcha"], badge: "Captcha" },
    loggedOut: {
      type: "loggedOut",
      body: () => "Nitro Type logged you out, so the session stopped (it tried a fresh page first). Log back in, then press Start.",
      test: "TEST: this is what the logged-out alert looks like.",
      flash: ["⚠ LOGGED OUT", "■ Logged out"],
      badge: "Logged out",
    },
    stalled: {
      type: "loggedOut",
      title: "⚠ SESSION STUCK",
      body: () => "No race for 10 minutes, even after reloading the race page, so the session stopped. Check the tab (logged out? a popup?), then press Start.",
      test: "TEST: this is what the stuck alert looks like.",
      flash: ["⚠ STUCK", "■ Stuck"],
      badge: "Stuck",
    },
  };
  // No race at all for this long (not on a break or a captcha pause): reload.
  const stallMs = () => window.__ntAutotyperStallMs ?? 5 * 60000;
  // Breaks at least this long end with a fresh race page, not Race Again.
  const longBreakMs = () => window.__ntAutotyperLongBreakMs ?? 2 * 60000;
  const alarm = {
    on: false,
    count: 0,
    timer: 0,
    flashTimer: 0,
    audio: null,
    // Browsers only allow sound after a click on the page; Start is one.
    unlock() {
      this.ready();
    },
    /**
     * Make sure sound can play, then run play(). Browsers only allow sound
     * after a click on the page; after a reload that has to happen again, so
     * this retries every time and says so (once) if it's still blocked.
     */
    ready(play) {
      try {
        this.audio ??= new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        this.audio = null;
        return;
      }
      const running = () => !this.audio.state || this.audio.state === "running";
      const unblock = () => {
        if (this.blocked) {
          this.blocked = false;
          panel.render?.();
        }
      };
      if (running()) {
        unblock();
        play?.();
        return;
      }
      const resumed = Promise.resolve(this.audio.resume?.()).catch(() => {});
      const timeout = new Promise((r) => timers.set(r, 600));
      Promise.race([resumed, timeout]).then(() => {
        if (running()) {
          unblock();
          play?.();
        } else if (play) {
          this.blocked = true;
          if (!this.toldBlocked) {
            this.toldBlocked = true;
            panel.toast?.("high", "Sound is off for now", "Your browser needs one click on this page before it allows sound. Click anywhere here (the panel counts).");
          }
          panel.render?.();
        }
      });
    },
    // A soft two-note chime for milestones and session done.
    chime() {
      this.ready(() => this.chimeNow());
    },
    chimeNow() {
      if (!this.audio) return;
      try {
        const ctx = this.audio;
        const t0 = ctx.currentTime + 0.02;
        [660, 990].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t0 + i * 0.18);
          gain.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.18 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.18 + 0.5);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0 + i * 0.18);
          osc.stop(t0 + i * 0.18 + 0.55);
        });
        this.chimes = (this.chimes ?? 0) + 1;
      } catch {
        /* no sound */
      }
    },
    beep() {
      this.ready(() => this.beepNow());
    },
    beepNow() {
      if (!this.audio) return;
      try {
        const ctx = this.audio;
        const t0 = ctx.currentTime + 0.02;
        for (let i = 0; i < 3; i++) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          osc.frequency.value = i % 2 ? 660 : 880;
          gain.gain.setValueAtTime(0.0001, t0 + i * 0.32);
          gain.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.32 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.32 + 0.24);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0 + i * 0.32);
          osc.stop(t0 + i * 0.32 + 0.26);
        }
        this.beeps = (this.beeps ?? 0) + 1;
      } catch {
        /* no sound, the rest still happens */
      }
    },
    // start("captcha" | "loggedOut" | "stalled", { test })
    start(which = "captcha", { test = false } = {}) {
      if (typeof which === "boolean") [which, test] = ["captcha", which]; // start(true): the captcha test
      const kind = ALARMS[which] ?? ALARMS.captcha;
      this.stop();
      this.on = true;
      this.kind = which;
      this.count = 0;
      const ring = () => {
        if (!this.on) return;
        this.count++;
        notify(kind.type, test ? kind.test : kind.body(), kind.title ? { title: kind.title } : {});
        // Urgent rings again every minute; lower levels alert once.
        if (loadSettings()[NOTIFY[kind.type].level] === "urgent" && this.count < ALARM_MAX) this.timer = timers.set(ring, ALARM_REPEAT_MS);
      };
      ring();
      // Flash the tab title.
      let flip = false;
      this.flashTimer = timers.set(function flash() {
        if (!alarm.on) return;
        flip = !flip;
        titleFlash = flip ? kind.flash[0] : kind.flash[1];
        updateTitle();
        alarm.flashTimer = timers.set(flash, 1000);
      }, 0);
      panel.render();
    },
    stop() {
      if (!this.on) return;
      this.on = false;
      timers.clear(this.timer);
      timers.clear(this.flashTimer);
      titleFlash = "";
      updateTitle();
      panel.render();
    },
  };
  // Any real click or key press on the page lets the browser allow sound.
  for (const type of ["pointerdown", "keydown"]) {
    listen(window, type, (e) => e.isTrusted && alarm.ready(), true);
  }

  // Back at the tab: you've seen it, stop ringing (the message stays).
  listen(document, "visibilitychange", () => {
    if (!document.hidden && alarm.on) timers.set(() => !document.hidden && alarm.stop(), 3000);
  });
  listen(window, "focus", () => alarm.on && timers.set(() => document.hasFocus() && alarm.stop(), 3000));

  // Stop the session when the computer's screen locks (Chrome's Idle
  // Detection; it asks for permission once).
  const lockWatch = {
    detector: null,
    async start(askPermission) {
      if (this.detector) return "on";
      if (!("IdleDetector" in window)) return "unsupported";
      try {
        let state;
        if (askPermission) state = await IdleDetector.requestPermission();
        else state = (await navigator.permissions.query({ name: "idle-detection" }).catch(() => ({ state: "prompt" }))).state;
        if (state !== "granted") return "denied";
        const detector = new IdleDetector();
        detector.addEventListener("change", () => {
          if (detector.screenState === "locked" && session.state.active) session.stop("Stopped: your screen locked");
        });
        await detector.start({ threshold: 60000 });
        this.detector = detector;
        return "on";
      } catch {
        return "denied";
      }
    },
  };

  function topHandle(msg, source) {
    switch (msg.kind) {
      case "status":
        if (msg.status?.running) session.touch(); // typing: all's well
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
      case "player":
        if (msg.name && msg.name !== session.player) {
          session.player = String(msg.name).slice(0, 40);
          writeJSON(localStorage, KEYS.player, session.player);
        }
        break;
      case "captcha":
        session.captcha();
        break;
      case "captchaState":
        session.captchaState(Boolean(msg.showing), source);
        break;
      case "disqualified":
        session.disqualified();
        break;
      case "stuck":
        session.stuck(msg.waitSec ?? 25);
        break;
      case "loggedOut":
      case "kicked":
        session.reconnect(msg.kind);
        break;
      case "asleep":
        if (session.state.active) session.stop("Stopped: your computer was asleep");
        break;
      case "raceResult":
        session.attachOfficial(msg.at, msg.official);
        break;
      case "debug":
        session.debug.set(source, { ...msg.info, at: Date.now() });
        panel.renderDebug?.();
        break;
      case "closeFocus":
        panel.closeFocus?.();
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
    timers.every(() => session.heartbeat(), 2000);
    if (loadSettings().stopOnLock) lockWatch.start(false);
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
  // Rebuilding unchanged markup still costs style and layout work, so skip it.
  const setHTML = (el, markup) => {
    if (el.__ntaMarkup === markup) return;
    el.__ntaMarkup = markup;
    el.innerHTML = htmlPolicy ? htmlPolicy.createHTML(markup) : markup;
  };

  const fmt = (n, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : "–");
  // 1,234 below 100k, then 123.4K, 1.2M
  const short = (n) =>
    !Number.isFinite(n) ? "–" : Math.abs(n) < 100000 ? Math.round(n).toLocaleString() : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const raceWpm = (r) => r.official?.wpm ?? r.wpm;
  const raceAcc = (r) => r.official?.accuracy ?? r.accuracy;

  // ---- day totals ------------------------------------------------------------
  const dayKey = (at) => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const emptyDay = () => ({ races: 0, wpm: 0, acc: 0, money: 0, xp: 0, wins: 0 });
  function addToDay(days, r) {
    const d = (days[dayKey(r.at)] ??= emptyDay());
    d.races++;
    d.wpm += raceWpm(r) || 0; // sums: divide by races for the average
    d.acc += raceAcc(r) || 0;
    d.money += r.official?.money || 0;
    d.xp += r.official?.xp || 0;
    if (r.official?.place === 1) d.wins++;
  }
  // Keep a year of day totals at most.
  function pruneDays(days) {
    const keys = Object.keys(days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 366))) delete days[k];
  }
  /** Day totals: the archived ones plus the races still kept one by one. */
  function allDays(archive, races) {
    const days = {};
    for (const [k, d] of Object.entries(archive ?? {})) days[k] = { ...d };
    for (const r of races) addToDay(days, r);
    return days;
  }
  /**
   * Money and XP per hour of racing: races less than 10 minutes apart count
   * as one stretch, from the start of its first race to the end of its last.
   */
  function perHour(races) {
    let ms = 0;
    let money = 0;
    let xp = 0;
    let prev = null;
    for (const r of [...races].sort((a, b) => a.at - b.at)) {
      const own = r.ms ?? (r.chars && r.wpm ? (r.chars / 5 / r.wpm) * 60000 : 30000);
      ms += prev !== null && r.at - prev < 10 * 60000 ? r.at - prev : own;
      prev = r.at;
      money += r.official?.money || 0;
      xp += r.official?.xp || 0;
    }
    const hours = ms / 3600000;
    return hours >= 2 / 60 ? { money: money / hours, xp: xp / hours, races: races.length / hours } : null;
  }
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
    /* themes (the host's data-theme) and accent colours (data-accent) */
    :host {
      --bg: #141b33; --bg2: #1c2547; --line: #2b3762; --text: #e8edff; --sub: #8e9cc9; --muted: #6b7aa8;
      --good: #3ddc84; --bad: #ff5c6c; --warn: #f5c451; --info: #9cc3ff;
      --head1: #212c57; --head2: #1a2346; --shade: rgba(10, 14, 30, .28); --shadow: rgba(0, 0, 0, .45);
      --accent: #f5a623; --on-accent: #1a1f33;
    }
    :host([data-theme="midnight"]) {
      --bg: #0c0e15; --bg2: #13161f; --line: #242938; --text: #eceef4; --sub: #8a91a8; --muted: #59627c;
      --head1: #161a26; --head2: #10131c; --shade: rgba(0, 0, 0, .3); --shadow: rgba(0, 0, 0, .6);
    }
    :host([data-theme="light"]) {
      --bg: #ffffff; --bg2: #f2f4f9; --line: #dce0eb; --text: #182038; --sub: #5d6684; --muted: #a3abc2;
      --good: #148a52; --bad: #d93a48; --warn: #9a6408; --info: #2f5fcf;
      --head1: #f6f7fb; --head2: #eef1f8; --shade: #f8f9fc; --shadow: rgba(24, 32, 56, .18);
    }
    :host([data-accent="sky"]) { --accent: #4fb3ff; }
    :host([data-accent="mint"]) { --accent: #34d399; }
    :host([data-accent="pink"]) { --accent: #ff7ab6; }
    :host([data-accent="violet"]) { --accent: #a78bfa; }
    :host([data-accent="red"]) { --accent: #ff6b5e; }
    * { box-sizing: border-box; }
    .box {
      position: fixed; z-index: 1; display: flex; flex-direction: column;
      min-width: 250px; max-width: 520px; min-height: 44px; max-height: calc(100vh - 16px);
      background: var(--bg); color: var(--text);
      border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 12px 40px var(--shadow);
      font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      overflow: hidden; resize: both;
      opacity: var(--idle-opacity, 1); transition: opacity .15s;
      contain: layout paint style; /* our updates never re-lay-out the page */
    }
    .box:hover, .box.running { opacity: 1; }
    .box.collapsed { resize: none; height: auto !important; min-height: 0; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: linear-gradient(90deg, var(--head1), var(--head2)); cursor: grab; user-select: none;
      touch-action: none; flex: none;
    }
    header:active { cursor: grabbing; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
    .running .dot { background: var(--good); box-shadow: 0 0 0 3px rgba(61, 220, 132, .2); }
    .title { font-weight: 700; letter-spacing: .2px; flex: 1; white-space: nowrap; }
    .title small { color: var(--sub); font-weight: 500; margin-left: 6px; }
    .icon { all: unset; cursor: pointer; color: var(--sub); padding: 2px 6px; border-radius: 6px; font-size: 14px; }
    .icon:hover { color: var(--text); background: rgba(255, 255, 255, .08); }
    .icon.on { color: var(--accent); }
    .main { display: flex; flex-direction: column; min-height: 0; flex: 1; }
    .collapsed .main { display: none; }
    .live { padding: 10px 12px 8px; border-bottom: 1px solid var(--line); flex: none; }
    .status { color: var(--sub); overflow-wrap: anywhere; min-width: 0; flex: 1; }
    .status-row { display: flex; align-items: center; gap: 8px; }
    .badge {
      flex: none; font-size: 10.5px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase;
      padding: 2px 8px; border-radius: 99px; background: var(--line); color: var(--sub);
      display: inline-flex; align-items: center; gap: 5px;
    }
    .badge.typing { background: color-mix(in srgb, var(--good) 16%, transparent); color: var(--good); }
    .badge.waiting { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
    .badge.break { background: color-mix(in srgb, var(--info) 18%, transparent); color: var(--info); }
    .badge.paused { background: color-mix(in srgb, var(--bad) 20%, transparent); color: var(--bad); }
    .badge.done { background: color-mix(in srgb, var(--good) 12%, transparent); color: var(--good); }
    /* a little live dot while typing */
    .badge.typing::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: blink 1.1s ease-in-out infinite; }
    @keyframes blink { 50% { opacity: .25; } }
    .running .status { color: var(--text); }
    /* mini track: a lane, a car that drives to the checkered finish, a trail */
    .track {
      --car-w: 30px; --p: 0;
      /* moving parts use transforms (GPU) sized by the track's width (cqw) */
      --run: calc(100cqw - var(--car-w) - 16px);
      position: relative; height: 24px; margin: 8px 0 6px; border-radius: 8px;
      background: var(--bg2); overflow: hidden; container-type: inline-size; contain: layout paint style;
    }
    .track::before {
      content: ""; position: absolute; left: 8px; right: 16px; top: 50%;
      border-top: 2px dashed rgba(142, 156, 201, .22);
    }
    .track .finish {
      position: absolute; right: 0; top: 0; bottom: 0; width: 8px; opacity: .65;
      background: repeating-conic-gradient(#e8edff 0 25%, #141b33 0 50%) 0 0 / 8px 8px;
    }
    .track .trail {
      position: absolute; left: 0; top: 0; bottom: 0; width: calc(100% - var(--car-w) / 2 - 12px);
      transform-origin: left center; transform: scaleX(var(--p));
      background: linear-gradient(90deg, transparent, rgba(245, 166, 35, .22));
    }
    .track .car {
      position: absolute; top: 50%; left: 4px; line-height: 0;
      transform: translate(calc(var(--run) * var(--p)), -50%);
      color: var(--accent); transition: transform .25s linear; will-change: transform;
    }
    .track .car svg { width: var(--car-w); height: calc(var(--car-w) * 14 / 30); }
    .box:not(.running) .track .car { color: var(--muted); }
    /* other racers: dots riding along the top of the lane */
    .track .rivals i {
      position: absolute; top: 3px; left: 0; width: 7px; height: 7px; border-radius: 50%;
      background: var(--sub); box-shadow: 0 0 0 2px var(--bg2);
      transform: translateX(calc(4px + var(--run) * var(--rp, 0) + var(--car-w) / 2 - 50%));
    }
    .f-track .rivals i { top: 5px; width: 9px; height: 9px; background: #9aa3bd; box-shadow: 0 0 0 2px #1d2232; }
    /* standings: position, name, progress, WPM */
    .people { display: grid; gap: 3px; margin-top: 6px; font-size: 12px; }
    .people:empty { display: none; }
    .p-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) 56px 30px; align-items: center; gap: 6px; color: var(--sub); }
    .p-row.me { color: var(--text); font-weight: 600; }
    .p-pos, .p-wpm { font-variant-numeric: tabular-nums; }
    .p-wpm { text-align: right; }
    .p-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .p-bar { height: 4px; border-radius: 99px; background: var(--line); overflow: hidden; }
    .p-bar i { display: block; height: 100%; background: var(--muted); transform-origin: left center; }
    .p-row.me .p-bar i { background: var(--accent); }
    /* after a race: place badge, your numbers, final standings */
    .result-card {
      margin-top: 8px; padding: 10px; border-radius: 10px; background: var(--bg2); border: 1px solid var(--line);
      display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; align-items: center;
    }
    .result-card[hidden] { display: none; }
    .rc-place {
      grid-row: span 2; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
      font-weight: 800; font-size: 14px; background: var(--line); color: var(--text);
    }
    .rc-place.p1 { background: #e3b341; color: #2a2108; }
    .rc-place.p2 { background: #c3cbdb; color: #1f2433; }
    .rc-place.p3 { background: #c98a5a; color: #2a1608; }
    .rc-main { font-size: 13px; color: var(--sub); }
    .rc-main b { font-size: 18px; color: var(--text); }
    .rc-sub { color: var(--sub); font-size: 12px; }
    .result-card .people { grid-column: 1 / -1; margin-top: 8px; }
    .compact .people, .compact .result-card { display: none !important; }
    .f-people { width: min(440px, 84vw); font-size: 13px; margin: 0 0 16px; text-align: left; }
    .f-people .p-row { grid-template-columns: 34px minmax(0, 1fr) 110px 40px; color: #8f98b3; }
    .f-people .p-row.me { color: #eef0f6; }
    .f-people .p-bar { background: rgba(255, 255, 255, .07); }
    .f-people .p-bar i { background: #6f7894; }
    .f-people .p-row.me .p-bar i { background: #e3b673; }
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
    /* the Race tab: settings in small groups */
    .group {
      display: flex; flex-direction: column; gap: 10px; padding: 10px 10px 11px;
      border: 1px solid var(--line); border-radius: 10px; background: var(--shade);
    }
    .g-head { font-size: 10.5px; font-weight: 800; letter-spacing: .6px; text-transform: uppercase; color: var(--sub); }
    .group input[type=number] { background: var(--bg2); }
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); padding: 3px; gap: 3px; border-radius: 9px; background: var(--bg); border: 1px solid var(--line); }
    .seg button {
      all: unset; cursor: pointer; text-align: center; padding: 5px 4px; border-radius: 7px;
      font-size: 12px; font-weight: 700; color: var(--sub); transition: background .12s, color .12s;
    }
    .seg button:hover { color: var(--text); }
    .seg button.on { background: var(--accent); color: var(--on-accent); }
    .seg.four { grid-template-columns: repeat(4, 1fr); }
    .swatches { display: flex; gap: 8px; flex-wrap: wrap; }
    .swatches button {
      all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 50%; background: var(--sw);
      box-shadow: inset 0 0 0 2px rgba(0, 0, 0, .15); transition: transform .12s;
    }
    .swatches button:hover { transform: scale(1.12); }
    .swatches button.on { box-shadow: 0 0 0 2px var(--bg2), 0 0 0 4px var(--sw); }
    .swatches button:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
    .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .hint { color: var(--sub); font-size: 11px; margin-top: 3px; }
    .go {
      all: unset; text-align: center; cursor: pointer; padding: 10px; border-radius: 10px;
      background: var(--accent); color: var(--on-accent); font-weight: 800; letter-spacing: .3px; flex: none;
      transition: filter .12s, transform .08s;
      margin: 0 8px 8px;
    }
    .go:hover { filter: brightness(1.08); }
    .go:active { transform: scale(.985); }
    .running .go { background: var(--bad); color: #fff; }
    .foot {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      color: var(--sub); font-size: 11px; padding: 0 12px 10px; flex: none;
    }
    .switch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11.5px; position: relative; }
    .switch input { position: absolute; opacity: 0; pointer-events: none; }
    .switch .knob { width: 26px; height: 14px; border-radius: 99px; background: var(--line); position: relative; transition: background .15s; }
    .switch .knob::after {
      content: ""; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%;
      background: var(--sub); transition: transform .15s, background .15s;
    }
    .switch input:checked + .knob { background: color-mix(in srgb, var(--accent) 35%, transparent); }
    .switch input:checked + .knob::after { transform: translateX(12px); background: var(--accent); }
    .switch input:focus-visible + .knob { outline: 2px solid var(--accent); outline-offset: 2px; }
    /* simple mode: just the essentials */
    .box.simple { resize: horizontal; height: auto !important; }
    .simple nav, .simple .adv, .simple section { display: none !important; }
    .simple section[data-tab="race"] { display: flex !important; }
    .simple .tabs { border-radius: 10px; margin-top: 8px; flex: 0 1 auto; min-height: 0; overflow: auto; }
    .simple .chips { display: none; }
    /* focus view: full screen and mellow */
    .focus {
      position: fixed; inset: 0; z-index: 2; display: flex; flex-direction: column;
      color: #dfe3ee; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #161a26; overflow: hidden; contain: strict;
    }
    /* the soft colours drift as one GPU layer (no repainting every frame) */
    .focus::before {
      content: ""; position: absolute; inset: -12%; pointer-events: none; will-change: transform;
      background:
        radial-gradient(1100px 700px at 25% 15%, rgba(68, 84, 140, .45), transparent 60%),
        radial-gradient(900px 650px at 85% 95%, rgba(96, 74, 120, .35), transparent 55%);
      animation: drift 40s ease-in-out infinite alternate;
    }
    .focus > * { position: relative; }
    .focus[hidden] { display: none; }
    @keyframes drift { from { transform: translate3d(-5%, -4%, 0); } to { transform: translate3d(5%, 4%, 0); } }
    .f-top { display: flex; align-items: center; gap: 10px; padding: 18px 24px; color: #8f98b3; font-size: 13px; letter-spacing: .03em; }
    .f-brand { font-weight: 600; }
    .f-count { flex: 1; }
    .f-btn { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; color: #8f98b3; font-size: 15px; }
    .f-btn:hover, .f-btn:focus-visible { background: rgba(255, 255, 255, .06); color: #dfe3ee; }
    .f-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 0 24px; text-align: center; }
    .f-status { color: #8f98b3; font-size: 14px; letter-spacing: .04em; }
    .f-wpm { display: flex; align-items: baseline; gap: 12px; }
    .f-num { font-size: clamp(72px, 15vw, 168px); font-weight: 200; line-height: 1; color: #eef0f6; font-variant-numeric: tabular-nums; }
    .f-unit { font-size: 20px; color: #8f98b3; letter-spacing: .12em; }
    .f-sub { color: #8f98b3; font-size: 14px; min-height: 21px; }
    .track.f-track { --car-w: 48px; width: min(720px, 88vw); height: 44px; margin: 22px 0 14px; border-radius: 14px; background: rgba(255, 255, 255, .04); }
    .f-track .car { color: #e3b673; }
    .f-track .trail { background: linear-gradient(90deg, transparent, rgba(227, 182, 115, .16)); }
    .f-track .finish { width: 10px; background-size: 10px 10px; opacity: .45; }
    .f-go {
      all: unset; cursor: pointer; padding: 10px 30px; border-radius: 999px; font-weight: 600; letter-spacing: .04em;
      border: 1px solid rgba(227, 182, 115, .5); color: #e3b673;
    }
    .f-go:hover, .f-go:focus-visible { background: rgba(227, 182, 115, .1); }
    .focus.running .f-go { border-color: rgba(229, 143, 143, .5); color: #e58f8f; }
    .f-hint { text-align: center; color: #646d88; font-size: 12px; padding: 18px; }
    @media (prefers-reduced-motion: reduce) {
      .focus::before { animation: none; }
      .track .car, .track .trail { transition: none; }
    }
    /* Low-FPS mode: no animations or transitions anywhere in the panel */
    .lite *, .lite *::before, .lite *::after, .focus.lite::before { animation: none !important; transition: none !important; }
    .lite .rivals, .lite .live-people { display: none !important; }
    .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .card { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
    .card .k { color: var(--sub); font-size: 11px; }
    .card .v { font-size: 18px; font-weight: 700; }
    .card .sub { color: var(--sub); font-size: 10.5px; }
    .cards.nine { grid-template-columns: repeat(3, 1fr); }
    .cards.nine .card { padding: 7px 8px; min-width: 0; }
    .cards.nine .v { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
    .today { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; padding: 8px 10px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); font-size: 12px; color: var(--sub); }
    .today b { color: var(--text); }
    .today span:not(:first-of-type)::before { content: "· "; color: var(--muted); }
    .mini-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--bg); border: 1px solid var(--line); }
    .mini-seg button { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; font-size: 11px; font-weight: 600; color: var(--sub); }
    .mini-seg button.on { background: var(--line); color: var(--text); }
    .chart-title { align-items: center; }
    .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    /* chart colours follow the theme */
    .c-grid { stroke: var(--line); stroke-width: 1; }
    .c-avg { stroke: var(--sub); stroke-width: 1; stroke-dasharray: 3 4; }
    .cross { stroke-dasharray: none; }
    .c-lbl { fill: var(--sub); }
    .c-line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .c-dot { fill: var(--accent); stroke: var(--bg2); stroke-width: 2; }
    .c-off { fill: var(--bg2); stroke: var(--warn); stroke-width: 1.5; }
    .c-bar { fill: color-mix(in srgb, var(--accent) 55%, transparent); }
    .c-bar.now { fill: var(--accent); }
    .c-bar.zero { fill: var(--line); }
    /* small touches: tabs fade in, the result card pops, 1st place shines */
    section.on { animation: fade-in .16s ease-out; }
    @keyframes fade-in { from { opacity: 0; transform: translateY(3px); } }
    .result-card:not([hidden]) { animation: pop-in .28s cubic-bezier(.2, .9, .3, 1.2); }
    @keyframes pop-in { from { opacity: 0; transform: translateY(6px) scale(.97); } }
    .rc-place.p1 { animation: shine 1.6s ease-out 2; }
    @keyframes shine { 0% { box-shadow: 0 0 0 0 rgba(227, 179, 65, .6); } 100% { box-shadow: 0 0 0 10px rgba(227, 179, 65, 0); } }
    @media (prefers-reduced-motion: reduce) {
      section.on, .result-card:not([hidden]), .rc-place.p1, .badge.typing::before { animation: none; }
    }
    table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
    th { text-align: right; color: var(--sub); font-weight: 600; padding: 3px 4px; border-bottom: 1px solid var(--line); }
    td { text-align: right; padding: 3px 4px; border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
    td .tag { margin-left: 5px; font-size: 9.5px; font-weight: 700; padding: 0 5px; border-radius: 99px; color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
    td .pl.p1 { color: #e3b341; font-weight: 700; }
    td .pl.p2 { color: #b9c2d6; font-weight: 700; }
    td .pl.p3 { color: #c98a5a; font-weight: 700; }
    th:first-child, td:first-child { text-align: left; }
    td:first-child { white-space: nowrap; }
    .empty { color: var(--sub); text-align: center; padding: 8px; }
    .btn2 { all: unset; cursor: pointer; text-align: center; padding: 7px; border-radius: 8px; border: 1px solid var(--line); color: var(--sub); }
    .btn2:hover { color: var(--text); border-color: var(--sub); }
    .check { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
    .check input { accent-color: var(--accent); margin: 2px 0 0; }
    .check small { display: block; color: var(--sub); font-size: 11px; }
    .sub-checks { display: grid; gap: 7px; padding-left: 22px; }
    .sub-checks.off { opacity: .45; pointer-events: none; }
    .notify-test { display: grid; gap: 6px; }
    /* pop-ups inside the page: top right, above everything (full screen too) */
    .toasts {
      position: fixed; top: 16px; right: 16px; z-index: 3; width: min(340px, calc(100vw - 32px));
      display: flex; flex-direction: column; gap: 8px; pointer-events: none;
      font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .toast {
      pointer-events: auto; display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: start;
      padding: 10px 12px; border-radius: 12px; color: var(--text); background: var(--bg2); border: 1px solid var(--line);
      border-left: 4px solid #5d8bf4; box-shadow: 0 10px 30px var(--shadow);
      animation: toast-in .18s ease-out;
    }
    .toast.high { border-left-color: #f5a623; }
    .toast.urgent { border-left-color: var(--bad); background: color-mix(in srgb, var(--bad) 16%, var(--bg2)); border-color: color-mix(in srgb, var(--bad) 40%, var(--bg2)); }
    .toast b { font-size: 13.5px; }
    .toast p { grid-column: 1; margin: 0; color: var(--sub); }
    .toast button { all: unset; cursor: pointer; grid-row: 1 / span 2; grid-column: 2; color: var(--sub); padding: 0 4px; font-size: 15px; }
    .toast button:hover { color: var(--text); }
    @keyframes toast-in { from { transform: translateY(-8px); opacity: 0; } }
    .levels-hint { color: var(--sub); font-size: 11px; }
    .nrow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 6px; }
    .nname { font-size: 12.5px; }
    .nname small { display: block; color: var(--sub); font-size: 11px; }
    .nrow select {
      padding: 3px 4px; border-radius: 7px; border: 1px solid var(--line);
      background: var(--bg); color: var(--text); font: inherit; font-size: 12px;
    }
    .nrow select:focus { outline: none; border-color: var(--accent); }
    .try { all: unset; cursor: pointer; color: var(--sub); padding: 3px 7px; border-radius: 6px; border: 1px solid var(--line); font-size: 11px; }
    .try:hover, .try:focus-visible { color: var(--text); border-color: var(--sub); }
    .prio { font-style: normal; font-size: 10px; font-weight: 700; padding: 0 6px; border-radius: 99px; margin-left: 4px; vertical-align: 1px; }
    .prio.p1 { background: #2b3762; color: #8e9cc9; }
    .prio.p2 { background: #24406a; color: #9cc3ff; }
    .prio.p3 { background: #4a3d16; color: #f5c451; }
    .prio.p4 { background: #5a3216; color: #ffb37a; }
    .prio.p5 { background: #6a1f2a; color: #ff9aa6; }
    /* captcha alarm: the panel turns red */
    .box.alarm { border-color: var(--bad); box-shadow: 0 0 0 3px rgba(255, 92, 108, .45), 0 12px 40px rgba(0, 0, 0, .45); animation: alarm 1s steps(2, jump-none) infinite; }
    .box.alarm .status { color: #ffd0d5; font-weight: 700; }
    @keyframes alarm { 50% { box-shadow: 0 0 0 3px rgba(255, 92, 108, .1), 0 12px 40px rgba(0, 0, 0, .45); } }
    .notify-status, .notify-last { color: var(--sub); font-size: 11px; }
    /* pop-ups aren't getting through: say so, with a fix */
    .note-warn {
      display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; margin-top: 8px;
      padding: 7px 8px 7px 10px; border-radius: 9px; font-size: 11.5px; line-height: 1.35;
      color: var(--text); background: color-mix(in srgb, var(--warn) 14%, var(--bg2)); border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--bg2));
    }
    .note-warn[hidden] { display: none; }
    .note-warn button { all: unset; cursor: pointer; font-weight: 700; padding: 3px 8px; border-radius: 6px; }
    .note-warn .nw-fix { background: var(--accent); color: var(--on-accent); }
    .note-warn .nw-fix[hidden] { display: none; }
    .note-warn .nw-x { color: var(--sub); padding: 3px 4px; }
    .note-warn .nw-x:hover { color: var(--text); }
    .sep { border: 0; border-top: 1px solid var(--line); margin: 0; }
    .breaks { display: grid; grid-template-columns: auto 52px auto; align-items: center; gap: 6px; color: var(--sub); font-size: 12px; }
    .breaks input[type=number] { width: 52px; }
    .breaks .len { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; }
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
    .compact .badge { font-size: 9.5px; padding: 1px 6px; }
    .compact .track { height: 20px; margin: 6px 0 4px; --car-w: 26px; }
    .compact .chips { flex-wrap: nowrap; overflow: hidden; }
    .compact .go { padding: 6px; margin: 2px 8px 8px; }
  `;

  const PANEL_HTML = `
    <div class="box">
      <header>
        <span class="dot"></span>
        <span class="title">NT Autotyper<small class="count"></small></span>
        <button class="icon mini-btn" title="Mini status window: a tiny window that stays on top of everything, for a corner of your screen">⧉</button>
        <button class="icon focus-btn" title="Focus view (full screen)">⛶</button>
        <button class="icon compact-btn" title="Compact mode">⊟</button>
        <button class="icon collapse" title="Collapse">▾</button>
      </header>
      <div class="main">
        <div class="live">
          <div class="status-row"><span class="badge idle">Idle</span><div class="status">Idle</div></div>
          <div class="note-warn" hidden><span class="nw-text"></span><button class="nw-fix" hidden>Allow</button><button class="nw-x" title="Hide this" aria-label="Hide this">✕</button></div>
          <div class="track"><div class="trail"></div><div class="finish"></div><div class="rivals"></div><div class="car"><svg viewBox="0 0 30 14" aria-hidden="true"><path d="M2.5 10.5V9.4Q3 8 4.4 7.6L6.2 4.8Q7.1 3.5 8.7 3.5H17Q18.8 3.5 20.1 4.8L22.6 7.3H25.6Q27.8 7.6 28 9.6V10.5Z" fill="currentColor"/><path d="M9.2 5H13V7.3H7.8ZM14.4 5H17.2Q18 5 18.6 5.6L20.1 7.3H14.4Z" fill="#0f1426" opacity=".55"/><circle cx="8.3" cy="11" r="2.4" fill="#0f1426" stroke="currentColor" stroke-width="1.2"/><circle cx="22" cy="11" r="2.4" fill="#0f1426" stroke="currentColor" stroke-width="1.2"/></svg></div></div>
          <div class="people live-people"></div>
          <div class="result-card" hidden></div>
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
            <div class="group">
              <div class="g-head">Speed &amp; accuracy</div>
              <div class="field">
                <div class="lbl">Speed range <b class="wpmLabel"></b></div>
                <div class="range2">
                  <input type="number" data-k="wpmMin" min="10" max="300"><span>to</span><input type="number" data-k="wpmMax" min="10" max="300">
                </div>
                <div class="row adv" style="margin-top:6px"><input type="range" data-k="wpmMin" min="10" max="300"></div>
                <div class="row adv"><input type="range" data-k="wpmMax" min="10" max="300"></div>
                <div class="hint adv">Each race picks a random speed in this range.</div>
              </div>
              <div class="field">
                <div class="lbl">Accuracy range <b class="accLabel"></b></div>
                <div class="range2">
                  <input type="number" data-k="accMin" min="80" max="100" step="0.5"><span>to</span><input type="number" data-k="accMax" min="80" max="100" step="0.5">
                </div>
                <div class="row adv" style="margin-top:6px"><input type="range" data-k="accMin" min="80" max="100" step="0.5"></div>
                <div class="row adv"><input type="range" data-k="accMax" min="80" max="100" step="0.5"></div>
              </div>
            </div>
            <div class="group">
              <div class="g-head">Human touch</div>
              <div class="field">
                <div class="seg" role="radiogroup" aria-label="Human touch">
                  <button role="radio" data-human="light">Light</button><button role="radio" data-human="natural">Natural</button><button role="radio" data-human="strong">Strong</button>
                </div>
                <div class="hint human-hint"></div>
              </div>
              <label class="check"><input type="checkbox" data-k="offDays"><span>Off races now and then<small>Once in a while a slower, sloppier race, or a slow start.</small></span></label>
              <div class="field adv">
                <div class="lbl">Timing variation <b><span data-show="variance"></span>%</b></div>
                <div class="row"><input type="range" data-k="variance" min="0" max="60"></div>
              </div>
            </div>
            <div class="group">
              <div class="g-head">Session</div>
              <div class="pair">
                <div class="field">
                  <div class="lbl">Nitros / race</div>
                  <input type="number" data-k="nitros" min="0" max="10">
                  <div class="hint adv">Used on the longest words.</div>
                </div>
                <div class="field">
                  <div class="lbl">Races to run</div>
                  <input type="number" data-k="races" min="1" max="500">
                  <div class="hint adv">Clicks "Race Again" in between.</div>
                </div>
              </div>
              <div class="field adv">
                <div class="lbl">Long breaks <b class="breakLabel"></b></div>
                <div class="breaks">
                  <span>Every</span><input type="number" data-k="breakEvery" min="0" max="100"><span>races (0 = off)</span>
                  <div class="len">for <input type="number" data-k="breakLenMin" min="0.1" max="30" step="0.5"> to <input type="number" data-k="breakLenMax" min="0.1" max="30" step="0.5"> min</div>
                </div>
                <div class="hint">The race count varies a little each time.</div>
              </div>
            </div>
          </section>
          <section data-tab="stats">
            <div class="today"></div>
            <div class="cards nine">
              <div class="card"><div class="k">Races</div><div class="v s-races"></div></div>
              <div class="card"><div class="k">Avg WPM</div><div class="v s-wpm"></div></div>
              <div class="card"><div class="k">Avg acc</div><div class="v s-acc"></div></div>
              <div class="card"><div class="k">Best WPM</div><div class="v s-best"></div></div>
              <div class="card"><div class="k">Wins</div><div class="v s-wins"></div><div class="sub s-winrate"></div></div>
              <div class="card"><div class="k">Top 3</div><div class="v s-podium"></div></div>
              <div class="card"><div class="k">Money</div><div class="v s-money"></div></div>
              <div class="card"><div class="k">XP</div><div class="v s-xp"></div></div>
              <div class="card" title="Per hour of racing (breaks over 10 minutes don't count)"><div class="k">Per hour</div><div class="v s-rate"></div><div class="sub s-rate-xp"></div></div>
            </div>
            <div>
              <div class="chart-title"><span class="mini-seg metric"><button data-metric="wpm">WPM</button><button data-metric="acc">Accuracy</button></span><span class="chart-range"></span></div>
              <div class="chart"><svg class="chart-svg" role="img" aria-label="Per race"></svg><div class="tip"></div></div>
            </div>
            <div>
              <div class="chart-title"><span class="mini-seg day-metric"><button data-day="races">Races</button><button data-day="money">Money</button><button data-day="xp">XP</button></span><span>by day</span></div>
              <div class="chart days"><svg class="days-svg" role="img" aria-label="By day"></svg><div class="tip"></div></div>
            </div>
            <table>
              <thead><tr><th>When</th><th>WPM</th><th>Acc</th><th>Place</th><th>Money</th></tr></thead>
              <tbody class="history"></tbody>
            </table>
            <div class="footnote"></div>
            <div class="btn-row"><button class="btn2 export-stats">Export CSV</button><button class="btn2 reset-stats">Reset stats</button></div>
          </section>
          <section data-tab="panel">
            <div class="field">
              <div class="lbl">Theme</div>
              <div class="seg four" role="radiogroup" aria-label="Theme">
                <button role="radio" data-theme-pick="dark">Dark</button><button role="radio" data-theme-pick="midnight">Midnight</button><button role="radio" data-theme-pick="light">Light</button><button role="radio" data-theme-pick="auto">Auto</button>
              </div>
            </div>
            <div class="field">
              <div class="lbl">Accent</div>
              <div class="swatches" role="radiogroup" aria-label="Accent colour">
                ${[
                  ["amber", "#f5a623", "Amber"],
                  ["sky", "#4fb3ff", "Sky"],
                  ["mint", "#34d399", "Mint"],
                  ["pink", "#ff7ab6", "Pink"],
                  ["violet", "#a78bfa", "Violet"],
                  ["red", "#ff6b5e", "Coral"],
                ]
                  .map(([key, color, label]) => `<button role="radio" data-accent-pick="${key}" style="--sw:${color}" title="${label}" aria-label="${label}"></button>`)
                  .join("")}
              </div>
            </div>
            <div class="field">
              <div class="lbl">Opacity when not hovered <b><span class="opLabel"></span>%</b></div>
              <div class="row"><input type="range" class="opacity" min="20" max="100"></div>
            </div>
            <div class="hint">Drag the header to move the panel, drag the bottom-right corner to resize it, ⊟ for compact mode, ▾ to collapse it.</div>
            <label class="check"><input type="checkbox" data-k="keepAlive"><span>Keep Nitro Type running when minimised<small>For the whole session (breaks too), Nitro Type's page keeps updating even when its window is minimised or hidden, so it doesn't look idle and the connection stays up. For long sessions in Chrome, also add nitrotype.com under Settings → Performance → "Always keep these sites active", so Chrome doesn't put the tab to sleep.</small></span></label>
            <label class="check"><input type="checkbox" data-k="miniMap"><span>Mini map instead of the race track<small>A light five-lane map of every racer, in place of Nitro Type's track.</small></span></label>
            <label class="check"><input type="checkbox" data-k="lite"><span>Low-FPS mode<small>For slow computers: no animations, no live standings, and the panel updates once a second.</small></span></label>
            <button class="btn2 reset-panel">Reset position and size</button>
            <hr class="sep">
            <label class="check"><input type="checkbox" data-k="notify"><span>Notifications<small class="notify-hint">Every time: a system pop-up, plus a pop-up on this page (seen even in full screen).</small></span></label>
            <div class="sub-checks">
              <div class="levels-hint">Low: chime · Normal: pop-up · High: chime + pop-up · Urgent: alarm + pop-up that stays</div>
              ${[
                ["levelCaptcha", "captcha", "Captcha", "Session pauses, carries on once it's solved. Urgent repeats every minute."],
                ["levelLoggedOut", "loggedOut", "Logged out / stuck", "Session stopped: logged out, or no race for 10 minutes. Urgent repeats every minute."],
                ["levelProblem", "problem", "Problems", "Currently in a race, disqualified, logged out, asleep, stuck"],
                ["levelSession", "session", "Session done", "Races, WPM, wins, money, XP"],
                ["levelMilestone", "milestone", "Milestones", "Personal best, win streaks"],
                ["levelLevel", "level", "Level ups", ""],
                ["levelSeason", "season", "Season pass rewards", ""],
                ["levelRace", "race", "After each race", "Place, WPM, accuracy, money, XP"],
              ]
                .map(
                  ([key, type, label, note]) => `<div class="nrow">
                    <span class="nname">${label}${note ? `<small>${note}</small>` : ""}</span>
                    <select data-k="${key}" aria-label="${label}">
                      <option value="off">Off</option><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
                    </select>
                    <button class="try" data-try="${type}" title="Try this level">▶</button>
                  </div>`,
                )
                .join("")}
            </div>
            <div class="hint sound-state"></div>
            <div class="notify-test"><button class="btn2 test-notify">Send a test notification</button><button class="btn2 test-alarm">Test the captcha alert</button><small class="notify-status"></small><small class="notify-last"></small></div>
            <label class="check"><input type="checkbox" data-k="stopOnLock"><span>Stop when my screen locks<small class="lock-hint">Chrome asks for permission once.</small></span></label>
            <label class="check"><input type="checkbox" data-k="debug"><span>Debug view<small>Shows what the script sees on the page. Copy it and send it over if something breaks.</small></span></label>
            <button class="btn2 copy-debug">Copy debug info</button>
            <hr class="sep">
            <div class="hint version"></div>
          </section>
        </div>
        <button class="go">Start</button>
        <div class="foot">
          <label class="switch" title="Show every setting, plus the Stats and Panel tabs"><input type="checkbox" class="adv-switch"><span class="knob"></span>Advanced</label>
          <span>Alt+Shift+A · any key stops</span>
        </div>
      </div>
    </div>
    <div class="toasts" aria-live="polite"></div>
    <div class="focus" hidden>
      <div class="f-top">
        <span class="f-brand">NT Autotyper</span><span class="f-count"></span>
        <button class="f-btn f-full" title="Browser full screen">⛶</button>
        <button class="f-btn f-close" title="Close (Esc)">✕</button>
      </div>
      <div class="f-center">
        <div class="f-status">Idle</div>
        <div class="f-wpm"><span class="f-num">–</span><span class="f-unit">wpm</span></div>
        <div class="f-sub"></div>
        <div class="track f-track"><div class="trail"></div><div class="finish"></div><div class="rivals"></div><div class="car"><svg viewBox="0 0 30 14" aria-hidden="true"><path d="M2.5 10.5V9.4Q3 8 4.4 7.6L6.2 4.8Q7.1 3.5 8.7 3.5H17Q18.8 3.5 20.1 4.8L22.6 7.3H25.6Q27.8 7.6 28 9.6V10.5Z" fill="currentColor"/><path d="M9.2 5H13V7.3H7.8ZM14.4 5H17.2Q18 5 18.6 5.6L20.1 7.3H14.4Z" fill="#0f1426" opacity=".55"/><circle cx="8.3" cy="11" r="2.4" fill="#0f1426" stroke="currentColor" stroke-width="1.2"/><circle cx="22" cy="11" r="2.4" fill="#0f1426" stroke="currentColor" stroke-width="1.2"/></svg></div></div>
        <div class="people f-people"></div>
        <button class="f-go">Start</button>
      </div>
      <div class="f-hint">Esc or click outside to close · any other key stops typing</div>
    </div>`;

  function buildPanel() {
    panelHost = document.createElement("div");
    // A zero-size, top-most layer: the panel and focus view sit above the page.
    panelHost.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    const root = panelHost.attachShadow({ mode: "open" });
    setHTML(root, `<style>${PANEL_CSS}</style>${PANEL_HTML}`);
    document.body.appendChild(panelHost);

    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => [...root.querySelectorAll(sel)];
    const box = $(".box");
    let settings = loadSettings();
    const UI_DEFAULTS = { x: 16, y: null, w: 290, h: null, collapsed: false, compact: false, advanced: false, tab: "race", opacity: 100, theme: "dark", accent: "amber" };
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
    // Theme and accent colour: on the host, so the panel, its pop-ups and
    // everything in it follow.
    const lightScheme = window.matchMedia?.("(prefers-color-scheme: light)");
    function applyTheme() {
      const theme = ui.theme === "auto" ? (lightScheme?.matches ? "light" : "dark") : ui.theme;
      panelHost.dataset.theme = theme;
      panelHost.dataset.accent = ui.accent;
      for (const b of $$("[data-theme-pick]")) {
        b.classList.toggle("on", b.dataset.themePick === ui.theme);
        b.setAttribute("aria-checked", String(b.dataset.themePick === ui.theme));
      }
      for (const b of $$("[data-accent-pick]")) {
        b.classList.toggle("on", b.dataset.accentPick === ui.accent);
        b.setAttribute("aria-checked", String(b.dataset.accentPick === ui.accent));
      }
    }
    lightScheme?.addEventListener?.("change", () => ui.theme === "auto" && applyTheme());
    for (const b of $$("[data-theme-pick]")) {
      b.addEventListener("click", () => {
        ui.theme = b.dataset.themePick;
        saveUI();
        applyTheme();
        if (ui.tab === "stats") renderStats();
      });
    }
    for (const b of $$("[data-accent-pick]")) {
      b.addEventListener("click", () => {
        ui.accent = b.dataset.accentPick;
        saveUI();
        applyTheme();
      });
    }

    function applyLayout() {
      applyTheme();
      box.style.width = `${ui.w}px`;
      box.style.height = ui.h && !ui.collapsed && !ui.compact && ui.advanced ? `${ui.h}px` : "";
      box.classList.toggle("simple", !ui.advanced);
      $(".adv-switch").checked = ui.advanced;
      box.classList.toggle("collapsed", ui.collapsed);
      box.classList.toggle("compact", ui.compact);
      box.classList.toggle("debugging", settings.debug);
      box.classList.toggle("lite", settings.lite);
      focusEl.classList.toggle("lite", settings.lite);
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
      // Grew past the bottom of the window (standings, result card)? Move up.
      const rect = box.getBoundingClientRect();
      if (rect.bottom > innerHeight - 8 && ui.y > 0) {
        ui.y = Math.max(0, innerHeight - rect.height - 8);
        box.style.top = `${ui.y}px`;
      }
      if (ui.collapsed || ui.compact || !ui.advanced) {
        // Width can still be changed in these modes; height is automatic.
        if (!ui.collapsed && Math.round(box.offsetWidth) !== ui.w) {
          ui.w = Math.round(box.offsetWidth);
          saveUI();
        }
        return;
      }
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
      if (!ui.collapsed && !ui.compact && ui.advanced && box.style.height) {
        ui.h = Math.round(box.offsetHeight);
        saveUI();
      }
    }).observe(box, { attributes: true, attributeFilter: ["style"] });

    $(".collapse").addEventListener("click", () => {
      ui.collapsed = !ui.collapsed;
      saveUI();
      applyLayout();
    });
    $(".adv-switch").addEventListener("change", (e) => {
      ui.advanced = e.target.checked;
      saveUI();
      applyLayout();
      panel.render();
    });

    // ---- focus view ----------------------------------------------------------
    const focusEl = $(".focus");
    function setFocusView(open) {
      focusEl.hidden = !open;
      toEngines({ focus: open }); // so Esc closes it instead of stopping
      if (!open && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      if (open) renderNow(); // filled in at once, not a frame later
      else panel.render();
      focusRace(); // keys go to the race, not our buttons
    }
    panel.closeFocus = () => setFocusView(false);

    // ---- what's going on, in a word or two (badge and mini window) ---------
    // [badge class, badge text, mini window text]
    function stateNow() {
      const statuses = [...panel.statuses.values()].sort((a, b) => a.at - b.at);
      // Typing for real (has progress), not just waiting for GO.
      const typing = Boolean(statuses.filter((s) => s.running && s.len).pop());
      const msg = session.message;
      if (session.paused()) return ["paused", "Captcha", "Captcha!"];
      if (session.onBreak()) return ["break", "Break", "Taking a break"];
      if (session.state.active && session.reconnectTimer) return ["waiting", "Waiting", msg.includes("logged out") ? "Logged out · reconnecting" : "Reconnecting"];
      if (typing) return ["typing", "Typing", "Racing"];
      if (session.state.active) return ["waiting", "Waiting", "Waiting for race"];
      if (alarm.on) {
        const badge = ALARMS[alarm.kind]?.badge ?? "Captcha";
        return ["paused", badge, badge];
      }
      if (msg.startsWith("Done")) return ["done", "Done", "Done"];
      if (msg.startsWith("Stopped: you're logged out")) return ["paused", "Logged out", "Logged out"];
      if (msg.startsWith("Stopped: no race")) return ["paused", "Stuck", "Stuck"];
      if (msg.startsWith("Stopped")) return ["idle", "Idle", "Stopped"];
      return ["idle", "Idle", "Idle"];
    }

    // ---- mini status window --------------------------------------------------
    // A tiny always-on-top window (Chrome/Edge "Document Picture-in-Picture")
    // with just the status, for a corner of the screen. It belongs to this
    // tab: it closes when the page reloads, and comes back with your next
    // click on the page.
    const MINI_CSS = `
      html, body { margin: 0; height: 100%; background: #10152a; }
      body { display: flex; align-items: center; justify-content: center; overflow: hidden; user-select: none;
        font: 600 15px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #e8edff; }
      .m { display: flex; align-items: center; gap: 9px; padding: 0 12px; white-space: nowrap; }
      .m i { width: 10px; height: 10px; border-radius: 50%; background: #6b7aa8; flex: none; }
      body.typing .m i { background: #3ddc84; box-shadow: 0 0 0 3px rgba(61, 220, 132, .25); }
      body.waiting .m i { background: #f5c451; }
      body.break .m i { background: #9cc3ff; }
      body.done .m i { background: #3ddc84; }
      body.paused { background: #4a1520; animation: alert 1s steps(2, jump-none) infinite; }
      body.paused .m i { background: #ff5c6c; }
      @keyframes alert { 50% { background: #10152a; } }
      @media (prefers-reduced-motion: reduce) { body.paused { animation: none; } }
    `;
    const mini = { win: null, unloading: false };
    listen(window, "pagehide", () => (mini.unloading = true));
    function updateMini() {
      const win = mini.win;
      if (!win) return;
      const [cls, , text] = stateNow();
      const doc = win.document;
      if (doc.body.className !== cls) doc.body.className = cls;
      const span = doc.querySelector(".m span");
      if (span && span.textContent !== text) span.textContent = text;
      if (doc.title !== text) doc.title = text;
    }
    async function openMini() {
      if (mini.win) return;
      if (!("documentPictureInPicture" in window)) {
        panel.toast?.("high", "Mini window not available", "It needs Chrome or Edge, version 116 or newer.");
        return;
      }
      let win;
      try {
        win = await window.documentPictureInPicture.requestWindow({ width: 200, height: 44 });
      } catch (err) {
        panel.toast?.("high", "Couldn't open the mini window", String(err?.message ?? err));
        return;
      }
      mini.win = win;
      ui.mini = true;
      saveUI();
      const doc = win.document;
      const style = doc.createElement("style");
      style.textContent = MINI_CSS;
      doc.head.appendChild(style);
      const box = doc.createElement("div");
      box.className = "m";
      box.append(doc.createElement("i"), doc.createElement("span"));
      doc.body.appendChild(box);
      win.addEventListener("pagehide", () => {
        mini.win = null;
        // Closed by you (not by this page reloading): stays closed.
        if (!mini.unloading) {
          ui.mini = false;
          saveUI();
        }
        $(".mini-btn").classList.remove("on");
      });
      $(".mini-btn").classList.add("on");
      updateMini();
    }
    $(".mini-btn").addEventListener("click", () => {
      $(".mini-btn").blur();
      if (mini.win) mini.win.close();
      else openMini();
    });
    // Kept up to date even while this tab is in the background.
    timers.every(() => updateMini(), 1000);
    // It was open before the page reloaded: a window needs a click to open,
    // so the next click anywhere on the page brings it back.
    if (ui.mini) {
      const again = (e) => {
        if (!e.isTrusted || mini.win) return;
        window.removeEventListener("pointerdown", again, true);
        openMini();
      };
      listen(window, "pointerdown", again, true);
    }

    // ---- pop-ups inside the page -----------------------------------------
    const toastBox = $(".toasts");
    panel.clearToasts = (match) => {
      for (const el of [...toastBox.children]) if (match(el.dataset.title ?? "")) el.remove();
    };
    panel.toast = (level, title, body) => {
      const el = document.createElement("div");
      el.className = `toast ${level}`;
      el.dataset.title = title;
      setHTML(el, `<b></b><button title="Dismiss" aria-label="Dismiss">✕</button><p></p>`);
      el.querySelector("b").textContent = title;
      el.querySelector("p").textContent = body;
      el.querySelector("button").addEventListener("click", () => el.remove());
      el.addEventListener("click", () => window.focus());
      toastBox.prepend(el);
      while (toastBox.children.length > 4) toastBox.lastChild.remove();
      // Urgent ones stay until you close them; the rest go away by themselves.
      if (level !== "urgent") timers.set(() => el.remove(), level === "high" ? 12000 : 8000);
    };
    panel.focusOpen = () => !focusEl.hidden;
    $(".focus-btn").addEventListener("click", () => setFocusView(true));
    $(".f-close").addEventListener("click", () => setFocusView(false));
    focusEl.addEventListener("click", (e) => {
      // Click on the background (not a button) closes it.
      if (!e.target.closest("button")) setFocusView(false);
    });
    $(".f-full").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else document.documentElement.requestFullscreen?.().catch(() => {});
      $(".f-full").blur();
    });
    $(".f-go").addEventListener("click", () => {
      session.toggle();
      $(".f-go").blur();
      if (session.state.active) focusRace();
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
        if (ui.tab === "stats") renderStats(); // show it right away, not next frame
        panel.render();
      });
    }
    $(".opacity").addEventListener("input", (e) => {
      ui.opacity = Number(e.target.value);
      saveUI();
      applyLayout();
    });
    $(".reset-panel").addEventListener("click", () => {
      // Position and size only: keeps your colours and the Advanced switch.
      ui = { ...UI_DEFAULTS, tab: "panel", theme: ui.theme, accent: ui.accent, advanced: ui.advanced };
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
    // The per-type switches only matter with notifications on.
    const syncSubChecks = () => {
      $(".sub-checks").classList.toggle("off", !settings.notify);
      showNotifyStatus();
    };
    function showNotifyStatus() {
      const perm = "Notification" in window ? Notification.permission : "unsupported";
      $(".notify-status").textContent =
        perm === "granted"
          ? "Your browser allows notifications from nitrotype.com."
          : perm === "denied"
            ? "Blocked for nitrotype.com: click the padlock in the address bar → Notifications → Allow."
            : perm === "unsupported"
              ? "This browser can't show desktop notifications."
              : "Not allowed yet: the test button will ask.";
    }
    for (const btn of $$(".try")) {
      btn.addEventListener("click", async () => {
        if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
        alarm.unlock();
        const type = btn.dataset.try;
        btn.blur();
        if (type === "captcha") return void $(".test-alarm").click();
        if (type === "loggedOut") {
          // The real thing: one ring, then it stops on its own.
          if (alarm.on) return void alarm.stop();
          alarm.start("loggedOut", { test: true });
          timers.clear(alarm.timer);
          timers.set(() => alarm.stop(), 6000);
          return;
        }
        const level = settings[NOTIFY[type].level];
        const status = $(".notify-status");
        if (level === "off") {
          status.textContent = `${NOTIFY[type].title}: set to Off, so nothing happens.`;
          return;
        }
        deliver(level, NOTIFY[type].title, `Test: this is the ${level} level.`, `nt-autotyper-try-${type}`, (result) => {
          status.textContent = `${NOTIFY[type].title} at ${level}: ${result === "chime only" ? "a chime, no pop-up." : result === "shown" ? (level === "high" ? "a chime and a pop-up." : "a pop-up.") : `pop-up ${result}.`}`;
        });
      });
    }
    $(".test-alarm").addEventListener("click", async () => {
      if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
      alarm.unlock();
      if (alarm.on) alarm.stop();
      else {
        // One ring only, then stop on its own.
        alarm.start(true);
        timers.clear(alarm.timer);
        timers.set(() => alarm.stop(), 6000);
      }
      $(".test-alarm").blur();
    });
    // Where to look when Chrome showed it but nothing appeared.
    // ---- are pop-ups getting through? ----------------------------------------
    // Chrome can switch a site's notifications off by itself (e.g. a site that
    // sends a lot of them), and then only the sound is left.
    const popupLevels = () => Object.values(NOTIFY).some((k) => ["normal", "high", "urgent"].includes(settings[k.level]));
    function noteProblem() {
      if (!settings.notify || !popupLevels() || !("Notification" in window)) return null;
      const perm = Notification.permission;
      if (perm === "denied") {
        return {
          key: "denied",
          text: "Desktop pop-ups are blocked: Chrome has notifications for nitrotype.com turned off (it can do that by itself for sites that send a lot). To fix: click the icon left of the address bar → Notifications → Allow, then reload.",
          fix: false,
        };
      }
      if (perm !== "granted") return { key: "default", text: "Desktop pop-ups are off: Chrome reset the notification permission for nitrotype.com. Press Allow, then pick Allow in Chrome's prompt.", fix: true };
      if (noteHealth.result.startsWith("error")) {
        return { key: `error${noteHealth.at}`, text: `Chrome couldn't show the last pop-up (${noteHealth.result}). Check chrome://settings/content/notifications: nitrotype.com under "Allowed", and "Sites can ask to send notifications" on.`, fix: false };
      }
      return null;
    }
    let warnDismissed = "";
    let warnToasted = "";
    function renderNoteWarn() {
      const problem = noteProblem();
      const bar = $(".note-warn");
      bar.hidden = !problem || problem.key === warnDismissed;
      if (!problem) return;
      setText($(".nw-text"), problem.text);
      $(".nw-fix").hidden = !problem.fix;
    }
    panel.noteHealthChanged = () => {
      const problem = noteProblem();
      // Once per problem: an on-page pop-up too (the bar may be scrolled away).
      if (problem && problem.key !== warnToasted) {
        warnToasted = problem.key;
        panel.toast?.("high", "Desktop pop-ups aren't getting through", problem.text);
      }
      showLastNote();
      panel.render();
    };
    function showLastNote() {
      const { result, at } = noteHealth;
      if (!at) return setText($(".notify-last"), "");
      const when = new Date(at).toLocaleTimeString();
      setText(
        $(".notify-last"),
        result === "shown"
          ? `Last pop-up (${when}): Chrome says it showed it. Not seeing them? ${systemHelp()}`
          : result === "unconfirmed"
            ? `Last pop-up (${when}): Chrome never confirmed showing it. ${systemHelp()}`
            : `Last pop-up (${when}): ${result === "not allowed" ? "not allowed by Chrome" : result}.`,
      );
    }
    $(".nw-fix").addEventListener("click", async () => {
      if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
      showNotifyStatus();
      panel.render();
    });
    $(".nw-x").addEventListener("click", () => {
      warnDismissed = noteProblem()?.key ?? "";
      renderNoteWarn(); // at once
    });
    // Chrome changing the permission (by itself, or you in site settings).
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((st) => {
        st.onchange = () => {
          showNotifyStatus();
          panel.noteHealthChanged();
        };
      })
      .catch(() => {});

    function systemHelp() {
      const ua = navigator.userAgent;
      if (/Windows/.test(ua)) {
        return "Windows is hiding it: Settings → System → Notifications → turn on notifications AND your browser (Google Chrome / Edge) in the app list; turn off Do not disturb, and check the automatic Do-not-disturb rules (they switch on in full screen, e.g. the focus view's full-screen button, and while gaming). Also look in the notification centre (Win+N).";
      }
      if (/Mac/.test(ua)) {
        return "macOS is hiding it: System Settings → Notifications → Google Chrome → Allow notifications, alert style Banners or Alerts; and turn off Focus / Do Not Disturb (Control Centre).";
      }
      return "Your system is hiding it: check its notification settings for your browser, and Do Not Disturb.";
    }
    $(".test-notify").addEventListener("click", async () => {
      if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
      alarm.unlock();
      const status = $(".notify-status");
      showNotifyStatus();
      status.textContent += " Sending…";
      const result = await new Promise((resolve) => {
        showNotification("NT Autotyper", "Test: notifications are working.", `nt-autotyper-test-${Date.now()}`, "normal", resolve);
        timers.set(() => resolve("no reply"), 4000);
      });
      alarm.chime();
      status.textContent =
        result === "shown"
          ? `Chrome says it showed the notification (and you should have heard a chime). Didn't see it? ${systemHelp()}`
          : result === "not allowed"
            ? "Notifications aren't allowed for nitrotype.com: click the padlock in the address bar → Notifications → Allow."
            : result.startsWith("error")
              ? `Chrome couldn't show it (${result}). Open chrome://settings/content/notifications and make sure nitrotype.com is under "Allowed", and that "Sites can ask to send notifications" is on.`
              : `Chrome didn't confirm it showed the notification. Try once more. If it still says this: ${systemHelp()}`;
      status.dataset.result = result;
      $(".test-notify").blur();
    });
    const HUMAN_HINTS = {
      light: "Smooth and steady, with small human quirks.",
      natural: "Real rhythm: quick common words, slower reaches, a beat after sentences, typos in little bursts.",
      strong: "Very human: bigger speed swings, longer pauses, a slower start at GO.",
    };
    for (const button of $$(".seg [data-human]")) {
      button.addEventListener("click", () => {
        applySetting("humanLevel", button.dataset.human);
        fillLabels();
        button.blur();
      });
    }
    function fillLabels() {
      for (const button of $$(".seg [data-human]")) {
        const on = button.dataset.human === settings.humanLevel;
        button.classList.toggle("on", on);
        button.setAttribute("aria-checked", String(on));
      }
      $(".human-hint").textContent = HUMAN_HINTS[settings.humanLevel] ?? "";
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
          if (key === "stopOnLock" && el.checked) {
            const result = await lockWatch.start(true);
            if (result !== "on") {
              el.checked = false;
              $(".lock-hint").textContent =
                result === "unsupported"
                  ? "Your browser can't tell when the screen locks (needs Chrome or Edge)."
                  : "Permission denied. Allow it in the site settings (padlock icon), then try again.";
            }
          }
          applySetting(key, el.checked);
          syncSubChecks();
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
    const renderNow = () => {
      const active = session.state.active;
      const statuses = [...panel.statuses.values()].sort((a, b) => a.at - b.at);
      const live = statuses.filter((s) => s.running).pop() ?? statuses.filter((s) => s.hasRace).pop();
      const typing = Boolean(live?.running);
      box.classList.toggle("running", active || typing);
      box.classList.toggle("alarm", alarm.on); // captcha: red panel
      box.classList.toggle("paused", session.paused());
      // The badge: what the script is up to, at a glance.
      const [badgeClass, badgeText] = stateNow();
      updateMini();
      const badge = $(".badge");
      if (badge.className !== `badge ${badgeClass}`) badge.className = `badge ${badgeClass}`;
      setText(badge, badgeText);
      renderNoteWarn();
      const soundState = $(".sound-state");
      if (soundState) {
        setText(
          soundState,
          alarm.blocked ? "Sound: blocked until you click anywhere on this page (browsers need one click after a reload)." : alarm.audio ? "Sound: on." : "Sound: turns on with your first click on this page.",
        );
      }

      // Whichever spoke last: the engine typing the race, or the session.
      $(".status").textContent = live && (typing || live.at > session.messageAt) ? live.message : session.message;
      $(".go").textContent = active ? "Stop" : "Start";
      $(".count").textContent = active ? `race ${Math.min(session.state.done + 1, session.state.total)}/${session.state.total}` : "";

      const pct = live?.len ? (100 * live.pos) / live.len : live?.done ? 100 : 0;
      const progress = active || typing ? pct / 100 : 0;
      for (const track of $$(".track")) track.style.setProperty("--p", progress.toFixed(4));

      // The other racers: dots on the track and live standings while racing;
      // a result card with final standings afterwards.
      const liveRacers = typing && !settings.lite ? live.racers : null;
      const others = (liveRacers ?? []).filter((r) => !r.me);
      for (const el of $$(".rivals")) updateRivals(el, others);
      updatePeople($(".live-people"), liveRacers);
      const last = session.stats[session.stats.length - 1];
      const showCard = !typing && last && Date.now() - last.at < 30 * 60000;
      $(".result-card").hidden = !showCard;
      if (showCard) setHTML($(".result-card"), resultCardHTML(last));

      // focus view
      if (!focusEl.hidden) {
        focusEl.classList.toggle("running", active || typing);
        updatePeople($(".f-people"), liveRacers ?? last?.official?.racers);
        $(".f-status").textContent = $(".status").textContent;
        $(".f-num").textContent = typing && Number.isFinite(live.wpm) ? fmt(live.wpm) : last ? fmt(wpmOf(last)) : "–";
        $(".f-count").textContent = active ? `race ${Math.min(session.state.done + 1, session.state.total)} of ${session.state.total}` : "";
        $(".f-sub").textContent = typing
          ? `target ${live.target} wpm`
          : last
            ? `last race · ${fmt(accOf(last), 1)}%${last.official?.place ? ` · ${ordinal(last.official.place)}` : ""}`
            : "";
        $(".f-go").textContent = active ? "Stop" : "Start";
      }
      const chips = [];
      if (live?.target && (active || typing)) chips.push(`target <b>${live.target}</b>`);
      if (typing && Number.isFinite(live.wpm)) chips.push(`now <b>${fmt(live.wpm)}</b> WPM`);
      if (typing && live.nitros) chips.push(`nitros <b>${live.nitros}</b>`);
      if (active) chips.push(`done <b>${session.state.done}</b>/${session.state.total}`);
      setHTML($(".chips"), chips.map((c) => `<span class="chip">${c}</span>`).join(""));

      if (ui.tab === "stats" && !ui.compact) renderStats();
      panel.renderDebug();
    };

    // Updates are batched: at most once per frame (once a second in Low-FPS
    // mode), and none while the tab is hidden (caught up when it's shown).
    let renderQueued = false;
    let lastRenderAt = 0;
    panel.render = () => {
      if (renderQueued || document.hidden) return;
      renderQueued = true;
      const wait = settings.lite ? Math.max(0, 1000 - (Date.now() - lastRenderAt)) : 0;
      const run = () =>
        requestAnimationFrame(() => {
          renderQueued = false;
          lastRenderAt = Date.now();
          if (!document.hidden) renderNow();
        });
      if (wait) timers.set(run, wait);
      else run();
    };
    listen(document, "visibilitychange", () => panel.render());

    // ---- standings and result card ---------------------------------------------
    const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

    /** Finishers by place, then everyone else by progress. Top 5, always with you. */
    function standings(racers) {
      if (!racers || racers.length < 2) return [];
      const rows = [...racers].sort((a, b) =>
        a.done && b.done ? (a.place ?? 99) - (b.place ?? 99) : a.done ? -1 : b.done ? 1 : b.pct - a.pct,
      );
      let shown = rows.slice(0, 5);
      const me = rows.find((r) => r.me);
      if (me && !shown.includes(me)) shown = [...shown.slice(0, 4), me];
      return shown.map((r) => ({ ...r, pos: r.done && r.place ? ordinal(r.place) : String(rows.indexOf(r) + 1) }));
    }

    const setText = (el, text) => {
      if (el.textContent !== text) el.textContent = text;
    };

    // Live standings change 4 times a second: update the rows in place (a
    // number here, a bar there) instead of rebuilding them each time.
    function updatePeople(container, racers) {
      const rows = standings(racers);
      const shape = rows.map((r) => (r.me ? "m" : "o")).join("");
      if (container.__shape !== shape) {
        container.__shape = shape;
        setHTML(
          container,
          rows
            .map((r) => `<div class="p-row${r.me ? " me" : ""}"><span class="p-pos"></span><span class="p-name"></span><span class="p-bar"><i></i></span><span class="p-wpm"></span></div>`)
            .join(""),
        );
      }
      rows.forEach((r, i) => {
        const [pos, nameEl, bar, wpm] = container.children[i].children;
        setText(pos, r.pos);
        setText(nameEl, r.me ? "You" : r.name);
        setText(wpm, r.wpm === undefined ? "–" : String(r.wpm));
        bar.firstChild.style.transform = `scaleX(${(r.done ? 1 : r.pct).toFixed(3)})`;
      });
    }

    // Dots on the track, moved in place.
    function updateRivals(el, racers) {
      if (el.children.length !== racers.length) setHTML(el, racers.map(() => "<i></i>").join(""));
      racers.forEach((r, i) => {
        const dot = el.children[i];
        dot.style.setProperty("--rp", r.pct.toFixed(3));
        if (dot.title !== r.name) dot.title = r.name;
      });
    }

    function peopleHTML(racers) {
      return standings(racers)
        .map((r) => {
          const pos = r.pos;
          const pct = r.done ? 1 : r.pct;
          return `<div class="p-row${r.me ? " me" : ""}"><span class="p-pos">${pos}</span><span class="p-name">${r.me ? "You" : esc(r.name)}</span><span class="p-bar"><i style="transform:scaleX(${pct.toFixed(3)})"></i></span><span class="p-wpm">${r.wpm ?? "–"}</span></div>`;
        })
        .join("");
    }

    function resultCardHTML(race) {
      const o = race.official ?? {};
      const place = o.place;
      const badge = place ? `<div class="rc-place p${place}">${ordinal(place)}</div>` : `<div class="rc-place">✓</div>`;
      const extras = [
        Number.isFinite(o.money) ? `$${o.money.toLocaleString()}` : "",
        Number.isFinite(o.xp) ? `+${o.xp.toLocaleString()} XP` : "",
        race.nitros ? `${race.nitros} nitro${race.nitros === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      return `${badge}
        <div class="rc-main"><b>${fmt(wpmOf(race))}</b> wpm · ${fmt(accOf(race), 1)}%</div>
        <div class="rc-sub">${extras.join(" · ") || (race.official ? "Last race" : "Last race (estimated)")}</div>
        <div class="people rc-people">${peopleHTML(o.racers)}</div>`;
    }

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
    let chartGeom = null;
    const METRICS = {
      wpm: { of: wpmOf, step: 5, minPad: 5, label: (v) => fmt(v) },
      acc: { of: accOf, step: 1, minPad: 1, label: (v) => `${fmt(v)}%` },
    };

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
        setHTML(svg, `<text class="c-lbl" x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12">The chart starts after 2 races</text>`);
        return;
      }
      const metric = METRICS[ui.metric] ?? METRICS.wpm;
      const vals = races.map(metric.of);
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      const padV = Math.max(metric.minPad, (hi - lo) * 0.15);
      lo = Math.max(0, Math.floor((lo - padV) / metric.step) * metric.step);
      hi = Math.ceil((hi + padV) / metric.step) * metric.step;
      if (ui.metric === "acc") hi = Math.min(100, hi);
      const L = 30;
      const R = 8;
      const T = 8;
      const B = 8;
      const x = (i) => L + (i * (W - L - R)) / (races.length - 1);
      const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
      const avg = average(vals);
      const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const last = vals.length - 1;
      chartGeom = { races, x, y, L, R, W, of: metric.of };
      // Off races and slow starts: a hollow dot.
      const marks = races
        .map((r, i) => (r.offDay ? `<circle class="c-off" cx="${x(i).toFixed(1)}" cy="${y(vals[i]).toFixed(1)}" r="3"><title>${r.offDay === "off" ? "off race" : "slow start"}</title></circle>` : ""))
        .join("");
      setHTML(
        svg,
        `
        <line class="c-grid" x1="${L}" x2="${W - R}" y1="${y(hi)}" y2="${y(hi)}"/>
        <line class="c-grid" x1="${L}" x2="${W - R}" y1="${y(lo)}" y2="${y(lo)}"/>
        <text class="c-lbl" x="${L - 6}" y="${y(hi) + 4}" text-anchor="end" font-size="10">${hi}</text>
        <text class="c-lbl" x="${L - 6}" y="${y(lo) + 4}" text-anchor="end" font-size="10">${lo}</text>
        <line class="c-avg" x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}"/>
        <text class="c-lbl" x="${L + 4}" y="${y(avg) - 4}" text-anchor="start" font-size="10">avg ${metric.label(avg)}</text>
        <polyline class="c-line" points="${pts}"/>
        ${marks}
        <circle class="c-dot" cx="${x(last)}" cy="${y(vals[last])}" r="4"/>
        <line class="cross c-avg" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
        <circle class="hover-dot c-dot" r="4" visibility="hidden"/>`,
      );
    }

    // ---- by day: the last 14 days as bars ------------------------------------
    let dayGeom = null;
    const DAY_METRICS = {
      races: { of: (d) => d.races, label: (v) => `${v}` },
      money: { of: (d) => d.money, label: (v) => `$${short(v)}` },
      xp: { of: (d) => d.xp, label: (v) => short(v) },
    };
    function renderDays() {
      const wrap = $(".chart.days");
      const svg = $(".days-svg");
      const W = Math.round(wrap.clientWidth);
      if (!W) return;
      const H = 92;
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      const days = allDays(session.days, session.stats);
      const keys = [];
      for (let i = 13; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86400000));
      const metric = DAY_METRICS[ui.dayMetric] ?? DAY_METRICS.races;
      const vals = keys.map((k) => (days[k] ? metric.of(days[k]) : 0));
      const top = Math.max(1, ...vals);
      const L = 4;
      const B = 16;
      const slot = (W - L * 2) / keys.length;
      const bw = Math.max(4, slot * 0.62);
      const h = (v) => (v / top) * (H - B - 14);
      dayGeom = { keys, days, slot, L, W };
      const label = (k) => new Date(`${k}T12:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      setHTML(
        svg,
        vals
          .map((v, i) => {
            const cx = L + slot * i + slot / 2;
            const today = i === keys.length - 1;
            return `<rect class="c-bar${today ? " now" : ""}${v ? "" : " zero"}" x="${(cx - bw / 2).toFixed(1)}" y="${(H - B - Math.max(v ? 2 : 1, h(v))).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(v ? 2 : 1, h(v)).toFixed(1)}" rx="2"/>`;
          })
          .join("") +
          `<text class="c-lbl" x="${L}" y="${H - 3}" font-size="10">${label(keys[0])}</text>` +
          `<text class="c-lbl" x="${W - L}" y="${H - 3}" text-anchor="end" font-size="10">today</text>` +
          `<text class="c-lbl" x="${W - L}" y="10" text-anchor="end" font-size="10">${metric.label(top === 1 && !vals.some(Boolean) ? 0 : top)}</text>`,
      );
    }
    $(".chart.days").addEventListener("pointermove", (e) => {
      if (!dayGeom) return;
      const { keys, days, slot, L, W } = dayGeom;
      const rect = $(".chart.days").getBoundingClientRect();
      const i = Math.max(0, Math.min(keys.length - 1, Math.floor((e.clientX - rect.left - L) / slot)));
      const d = days[keys[i]];
      const when = i === keys.length - 1 ? "Today" : new Date(`${keys[i]}T12:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      const tip = $(".chart.days .tip");
      tip.textContent = d
        ? `${when}: ${d.races} race${d.races === 1 ? "" : "s"} · ${fmt(d.wpm / d.races)} WPM · $${short(d.money)} · ${short(d.xp)} XP`
        : `${when}: no races`;
      tip.style.display = "block";
      tip.style.left = `${Math.max(90, Math.min(W - 90, L + slot * i + slot / 2))}px`;
      tip.style.top = "0px";
    });
    $(".chart.days").addEventListener("pointerleave", () => ($(".chart.days .tip").style.display = "none"));

    // the two charts' switches
    for (const b of $$(".metric [data-metric]")) {
      b.addEventListener("click", () => {
        ui.metric = b.dataset.metric;
        saveUI();
        renderStats();
      });
    }
    for (const b of $$(".day-metric [data-day]")) {
      b.addEventListener("click", () => {
        ui.dayMetric = b.dataset.day;
        saveUI();
        renderStats();
      });
    }

    // ---- export ----------------------------------------------------------------
    $(".export-stats").addEventListener("click", () => {
      const head = ["date", "time", "wpm", "accuracy", "place", "money", "xp", "nitros", "target_wpm", "target_accuracy", "source", "note"];
      const rows = session.stats.map((r) => {
        const d = new Date(r.at);
        return [
          dayKey(r.at),
          d.toTimeString().slice(0, 8),
          fmt(wpmOf(r), 1),
          fmt(accOf(r), 1),
          r.official?.place ?? "",
          r.official?.money ?? "",
          r.official?.xp ?? "",
          r.nitros ?? 0,
          r.target ?? "",
          r.accTarget ?? "",
          r.official ? "nitro type" : "estimate",
          r.offDay === "off" ? "off race" : r.offDay === "slow" ? "slow start" : "",
        ];
      });
      const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const csv = [head, ...rows].map((row) => row.map(cell).join(",")).join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `nitro-type-races-${dayKey(Date.now())}.csv`;
      root.appendChild(a);
      a.click();
      a.remove();
      timers.set(() => URL.revokeObjectURL(url), 10000);
      $(".export-stats").blur();
    });

    // Hover anywhere on the chart: crosshair on the nearest race + tooltip.
    $(".chart").addEventListener("pointermove", (e) => {
      if (!chartGeom) return;
      const { races, x, y, L, R, W } = chartGeom;
      const rect = $(".chart").getBoundingClientRect();
      const px = e.clientX - rect.left;
      const i = Math.max(0, Math.min(races.length - 1, Math.round(((px - L) / (W - L - R)) * (races.length - 1))));
      const r = races[i];
      const cx = x(i);
      const cy = y(chartGeom.of(r));
      const cross = $(".cross");
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      const dot = $(".hover-dot");
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.setAttribute("visibility", "visible");
      const tip = $(".chart .tip");
      const note = r.offDay === "off" ? " · off race" : r.offDay === "slow" ? " · slow start" : "";
      tip.textContent = `${fmt(wpmOf(r))} WPM${r.official ? "" : " (est.)"} · ${fmt(accOf(r), 1)}% · ${timeAgo(r.at)}${note}`;
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
      const placed = st.filter((r) => r.official?.place);
      const wins = placed.filter((r) => r.official.place === 1).length;
      $(".s-races").textContent = st.length;
      $(".s-wpm").textContent = fmt(average(st.map(wpmOf)));
      $(".s-acc").textContent = st.length ? `${fmt(average(st.map(accOf)), 1)}%` : "–";
      $(".s-best").textContent = st.length ? fmt(Math.max(...st.map(wpmOf))) : "–";
      $(".s-wins").textContent = placed.length ? wins : "–";
      $(".s-winrate").textContent = placed.length ? `${fmt((100 * wins) / placed.length)}% of races` : "";
      $(".s-podium").textContent = placed.length ? `${fmt((100 * placed.filter((r) => r.official.place <= 3).length) / placed.length)}%` : "–";
      $(".s-money").textContent = money.length ? `$${short(sum(money))}` : "–";
      $(".s-xp").textContent = xp.length ? short(sum(xp)) : "–";
      const rate = money.length || xp.length ? perHour(st) : null;
      $(".s-rate").textContent = rate ? `$${short(rate.money)}` : "–";
      $(".s-rate-xp").textContent = rate ? `${short(rate.xp)} XP` : "";
      // Today, at a glance.
      const today = allDays(session.days, st)[dayKey(Date.now())];
      setHTML(
        $(".today"),
        today
          ? [
              `<b>Today</b>`,
              `${today.races} race${today.races === 1 ? "" : "s"}`,
              `${fmt(today.wpm / today.races)} WPM`,
              today.money ? `+$${short(today.money)}` : "",
              today.xp ? `+${short(today.xp)} XP` : "",
              today.wins ? `${today.wins} win${today.wins === 1 ? "" : "s"}` : "",
            ]
              .filter(Boolean)
              .map((t) => `<span>${t}</span>`)
              .join("")
          : `<b>Today</b><span>no races yet</span>`,
      );
      for (const b of $$(".metric [data-metric]")) b.classList.toggle("on", b.dataset.metric === (ui.metric ?? "wpm"));
      for (const b of $$(".day-metric [data-day]")) b.classList.toggle("on", b.dataset.day === (ui.dayMetric ?? "races"));
      renderChart();
      renderDays();
      const rows = st.slice(-25).reverse();
      setHTML(
        $(".history"),
        rows.length
          ? rows
              .map((r) => {
                const est = r.official ? "" : "~";
                const tip =
                  `target ${r.target ?? "?"} WPM, ${r.accTarget ?? "?"}%, ${r.nitros ?? 0} nitro${r.nitros === 1 ? "" : "s"}` +
                  (r.official?.xp ? `, ${r.official.xp} XP` : "") +
                  (r.offDay === "off" ? " (an off race)" : r.offDay === "slow" ? " (a slow start)" : "");
                const tag = r.offDay ? `<span class="tag">${r.offDay === "off" ? "off" : "slow"}</span>` : "";
                const place = r.official?.place ? `<span class="pl${r.official.place <= 3 ? ` p${r.official.place}` : ""}">${ordinal(r.official.place)}</span>` : "–";
                return `<tr title="${tip}"><td>${timeAgo(r.at)}${tag}</td><td>${est}${fmt(wpmOf(r))}</td><td>${est}${fmt(accOf(r), 1)}%</td><td>${place}</td><td>${Number.isFinite(r.official?.money) ? `$${short(r.official.money)}` : "–"}</td></tr>`;
              })
              .join("")
          : `<tr><td colspan="5" class="empty">No races yet</td></tr>`,
      );
      $(".footnote").textContent = rows.some((r) => !r.official)
        ? "~ = the script's own estimate (Nitro Type's results weren't found on screen)."
        : "";
    }

    fillSettings();
    syncSubChecks();
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
