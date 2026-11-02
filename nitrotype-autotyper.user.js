// ==UserScript==
// @name         Nitro Type Autotyper
// @namespace    https://github.com/ZillaFam/Nitrotype-autotyper
// @version      1.0.0
// @description  Types Nitro Type races for you at a set WPM and accuracy, with human-like timing and typos.
// @match        https://www.nitrotype.com/*
// @match        https://nitrotype.com/*
// @match        https://*.nitrotype.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * 1. Nitro Type ignores keyboard events that scripts create (event.isTrusted
 *    is false for them). Before any Nitro Type code runs (@run-at
 *    document-start), we wrap addEventListener and the on<key> properties so
 *    that, for events *this script* dispatched, listeners see isTrusted: true.
 *    Real events from your keyboard are passed through untouched.
 * 2. The race text is read from the .dash-letter spans, and the current
 *    position from their classes (is-waiting / is-correct / is-typed).
 * 3. For each letter we dispatch keydown -> keypress -> (input) -> keyup,
 *    exactly like a real key press. Nitro Type doesn't move on after a wrong
 *    key, so a typo is a wrong key, a short pause, then the right key.
 *
 * If the race runs inside an iframe, the script runs there too; the control
 * panel lives in the top page and talks to it with postMessage.
 */

(() => {
  "use strict";
  if (window.__NT_AUTOTYPER__) return;
  window.__NT_AUTOTYPER__ = true;

  const IS_TOP = window === window.top;
  const MSG_TAG = "nt-autotyper";
  const LOG = (...args) => console.debug("[NT Autotyper]", ...args);

  // =========================================================================
  // 1. Trusted-event shim. Must run before Nitro Type registers listeners.
  // =========================================================================

  const SPOOFED_TYPES = ["keydown", "keypress", "keyup", "beforeinput", "input", "textInput"];
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
  for (const proto of [HTMLElement.prototype, Document.prototype, Window.prototype, window]) {
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
  function typoFor(ch) {
    if (ch === " " || ch === "\n") return null;
    const base = SHIFTED[ch] ?? ch.toLowerCase();
    const near = neighbours(base);
    if (!near.length) return null;
    const letters = near.filter((c) => c >= "a" && c <= "z");
    const pool = base >= "a" && base <= "z" && letters.length ? letters : near;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return ch !== ch.toLowerCase() ? pick.toUpperCase() : pick;
  }

  // =========================================================================
  // 3. Synthesising key presses
  // =========================================================================

  function legacy(event, keyCode, charCode) {
    // keyCode/which/charCode can't be set through the constructor.
    for (const [prop, value] of [["keyCode", keyCode], ["which", keyCode || charCode], ["charCode", charCode]]) {
      Object.defineProperty(event, prop, { get: () => value });
    }
    return event;
  }

  function fire(target, event) {
    ourEvents.add(event);
    return target.dispatchEvent(event);
  }

  function fireKey(target, type, k, keyCode, charCode) {
    const init = { key: k.key, code: k.code, shiftKey: k.shift, bubbles: true, cancelable: true, composed: true, view: window };
    return fire(target, legacy(new KeyboardEvent(type, init), keyCode, charCode));
  }

  const nativeValueSetter = (el) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;

  function insertText(target, ch) {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const init = { inputType: "insertText", data: ch, bubbles: true, composed: true };
    if (!fire(target, new InputEvent("beforeinput", { ...init, cancelable: true }))) return;
    // Use the native setter so React-controlled inputs notice the change.
    const setter = nativeValueSetter(target);
    if (setter) setter.call(target, target.value + ch);
    else target.value += ch;
    fire(target, new InputEvent("input", init));
  }

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
    const shiftKey = { key: "Shift", code: LEFT_HAND.has(SHIFTED[ch] ?? ch.toLowerCase()) ? "ShiftRight" : "ShiftLeft", shift: true };
    if (k.shift) fireKey(target, "keydown", shiftKey, 16, 0);
    if (fireKey(target, "keydown", k, k.keyCode, 0)) {
      const charCode = ch === "\n" ? 13 : ch.charCodeAt(0);
      if (fireKey(target, "keypress", k, charCode, charCode)) insertText(target, ch);
    }
    setTimeout(() => {
      fireKey(target, "keyup", k, k.keyCode, 0);
      if (k.shift) fireKey(target, "keyup", { ...shiftKey, shift: false }, 16, 0);
    }, holdMs);
  }

  // =========================================================================
  // 4. Reading the race
  // =========================================================================

  /** { text, pos, id } or null. pos is null when the classes give no clue. */
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

  const sameRace = (a, b) => Boolean(a && b && a.id === b.id && a.text === b.text);

  // =========================================================================
  // 5. Typing engine
  // =========================================================================

  const REACTION_MS = [140, 320]; // pause after a typo before the right key
  const PROBE_MS = 120; // how often to try the first key while waiting for "GO"
  const MAX_WAIT_MS = 90000; // give up waiting for "GO" after this long
  const RETRY_MS = 250; // re-send a key Nitro Type didn't register after this long
  const STALL_MS = 5000;
  const PACE_GAIN = 0.3;

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
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
    runId: 0,
    running: false,
    settings: null,
    lastRace: null, // the race we last typed (or were stopped in)
    status: { running: false, message: "Idle", hasRace: false },

    setStatus(running, message) {
      this.running = running;
      this.status = { running, message, hasRace: Boolean(readRace()) };
      reportStatus(this.status);
    },

    start(settings) {
      if (settings) this.settings = settings;
      if (this.running) return;
      if (!readRace()) {
        // Frames without a race stay quiet unless nothing else answers.
        this.setStatus(false, this.settings.autoStart ? "No race yet. Will start when one opens." : "No race on this page");
        return;
      }
      const id = ++this.runId;
      this.run(id).catch((err) => {
        console.error("[NT Autotyper]", err);
        if (id === this.runId) this.setStatus(false, `Error: ${err.message}`);
      });
    },

    stop(message = "Stopped") {
      if (!this.running) return;
      this.runId++;
      const race = readRace();
      if (race) this.lastRace = race; // don't auto-restart this race
      this.setStatus(false, message);
    },

    async run(id) {
      const alive = () => id === this.runId;
      const halt = (message) => alive() && (this.runId++, this.setStatus(false, message));

      let race = readRace();
      const startRace = race;
      this.lastRace = race;
      const text = race.text;
      LOG("race text:", text);
      LOG("letter classes:", [...document.querySelectorAll(".dash-letter")].slice(0, 3).map((el) => el.className));
      focusRace();

      // Wait for "GO": keep trying the first key until Nitro Type accepts it.
      this.setStatus(true, "Waiting for the race to start…");
      const waitStart = performance.now();
      while (alive()) {
        race = readRace();
        if (!sameRace(race, startRace)) return halt("Race closed");
        if (race.pos !== null && race.pos > 0) break;
        if (race.pos === null && race.firstClass !== startRace.firstClass) {
          // Something changed, but not in a way we understand: don't keep
          // hammering the first key into a running race.
          return halt("Can't read the race progress (Nitro Type changed its page?)");
        }
        if (performance.now() - waitStart > MAX_WAIT_MS) return halt("Race didn't start");
        pressKey(text[0], rand(40, 90));
        await sleep(PROBE_MS);
      }
      if (!alive()) return;
      this.setStatus(true, "Typing…");

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
        race = readRace();
        if (!sameRace(race, startRace) || race.pos === null || race.pos >= text.length) {
          return halt("Race finished");
        }

        const now = performance.now();
        const pos = race.pos;
        if (pos !== lastPos) {
          lastPos = pos;
          lastProgressAt = now;
        } else if (now - lastProgressAt > STALL_MS) {
          return halt("Stopped: Nitro Type isn't accepting keys");
        } else if (pos === lastPressPos && now - lastPressAt < RETRY_MS) {
          // Last key not registered yet; give the page a moment.
          nextAt = now + 10;
          continue;
        }

        const { wpm, accuracy, variance } = this.settings;
        const pTypo = typoChance(accuracy);
        const perChar = 12000 / wpm; // 60 s / (wpm * 5 chars)
        const interval = Math.max(5, (perChar - pTypo * (REACTION_MS[0] + REACTION_MS[1]) / 2) / (1 + pTypo));
        const ch = text[pos];

        // Occasionally hit a neighbouring key first. Nitro Type stays on the
        // letter, so after a pause we just press the right one.
        if (lastTypoPos !== pos && Math.random() < pTypo) {
          const typo = typoFor(ch);
          lastTypoPos = pos;
          if (typo) {
            pressKey(typo, rand(40, 100));
            nextAt = now + rand(REACTION_MS[0], REACTION_MS[1]);
            continue;
          }
        }

        pressKey(ch, rand(40, 100));
        lastPressAt = now;
        lastPressPos = pos;

        // Steer toward the target WPM using real progress.
        if (!pace || pace.wpm !== wpm) pace = { at: now, pos, wpm };
        const behindMs = now - pace.at - (pos - pace.pos) * perChar;
        const correction = Math.min(1.5 * interval, Math.max(-0.6 * interval, -behindMs * PACE_GAIN));
        const jitter = Math.min(2.5, Math.max(0.35, 1 + gaussian() * (variance / 100)));
        nextAt = Math.max(nextAt, now - interval) + Math.max(2, interval * jitter + correction);
      }
    },
  };

  // Auto-start: begin typing whenever a new race shows up.
  setInterval(() => {
    if (engine.running || !engine.settings?.autoStart) return;
    const race = readRace();
    if (race && !sameRace(race, engine.lastRace)) engine.start();
  }, 300);

  // Safety stop: a real key press (not the shortcut) hands control back.
  // Registered with the native method so it sees the real isTrusted.
  nativeAdd.call(
    window,
    "keydown",
    (e) => {
      if (!e.isTrusted) return;
      if (isShortcut(e)) {
        e.preventDefault();
        sendCommand("toggle");
        return;
      }
      if (!engine.running) return;
      const path = e.composedPath();
      if (path.includes(panelHost) && path[0].tagName === "INPUT") return; // editing a setting
      if (e.altKey || e.ctrlKey || e.metaKey || ["Shift", "Alt", "Control", "Meta", "CapsLock"].includes(e.key)) return;
      engine.stop("Stopped: you pressed a key");
    },
    true,
  );

  const isShortcut = (e) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyA";

  // =========================================================================
  // 6. Messaging between frames (the race may be inside an iframe)
  // =========================================================================

  // Commands go from the top page to every frame; statuses come back up.
  function broadcast(msg, win = window) {
    for (let i = 0; i < win.frames.length; i++) {
      try {
        win.frames[i].postMessage({ tag: MSG_TAG, ...msg }, "*");
      } catch {
        /* frame went away */
      }
    }
  }

  function handleCommand(cmd, settings) {
    if (settings) engine.settings = settings;
    if (cmd === "start") engine.start();
    else if (cmd === "stop") engine.stop();
    else if (cmd === "settings") {
      /* settings already applied */
    }
  }

  // Called from any frame; the top page decides and fans out.
  function sendCommand(cmd) {
    if (!IS_TOP) {
      window.top.postMessage({ tag: MSG_TAG, request: cmd }, "*");
      return;
    }
    if (cmd === "toggle") cmd = panel.anyRunning() ? "stop" : "start";
    const settings = loadSettings();
    handleCommand(cmd, settings);
    broadcast({ cmd, settings });
  }

  function reportStatus(status) {
    if (IS_TOP) panel.onStatus(status, window);
    else window.top.postMessage({ tag: MSG_TAG, status }, "*");
  }

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || data.tag !== MSG_TAG) return;
    if (data.cmd) {
      handleCommand(data.cmd, data.settings);
      broadcast(data); // pass it on to nested frames
    } else if (IS_TOP && data.request) {
      sendCommand(data.request);
    } else if (IS_TOP && data.status) {
      panel.onStatus(data.status, e.source);
    }
  });

  // =========================================================================
  // 7. Settings and control panel (top page only)
  // =========================================================================

  const DEFAULTS = { wpm: 90, accuracy: 97, variance: 25, autoStart: true, collapsed: false };
  const LIMITS = { wpm: [10, 300], accuracy: [80, 100], variance: [0, 60] };
  const STORAGE_KEY = "nt-autotyper-settings";

  function normalize(raw) {
    const s = { ...DEFAULTS, ...raw };
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const n = Number(s[key]);
      s[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULTS[key];
    }
    s.autoStart = Boolean(s.autoStart);
    s.collapsed = Boolean(s.collapsed);
    return s;
  }

  function loadSettings() {
    try {
      return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
    } catch {
      return normalize({});
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* storage blocked; settings last for this page only */
    }
  }

  let panelHost = null;
  const panel = {
    statuses: new Map(), // frame window -> latest status
    anyRunning() {
      return [...this.statuses.values()].some((s) => s.running);
    },
    onStatus(status, source) {
      this.statuses.set(source, status);
      this.render?.();
    },
  };

  // Same-origin frames share localStorage; others get settings by message.
  engine.settings = loadSettings();

  if (IS_TOP) {
    // Child frames start with no settings until the first command; send them
    // whenever a frame says hello by reporting a status, and on page load.
    window.addEventListener("load", () => broadcast({ cmd: "settings", settings: loadSettings() }));
    setInterval(() => broadcast({ cmd: "settings", settings: loadSettings() }), 2000);

    const mount = () => {
      if (!document.body) return void requestAnimationFrame(mount);
      buildPanel();
    };
    mount();
  }

  function buildPanel() {
    panelHost = document.createElement("div");
    panelHost.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;";
    const root = panelHost.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { width: 250px; font: 13px/1.35 system-ui, sans-serif; color: #e6ecff;
               background: #1c2541; border: 1px solid #2f3d68; border-radius: 10px;
               box-shadow: 0 6px 24px rgba(0,0,0,.35); overflow: hidden; }
        header { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
                 background: #253159; cursor: pointer; user-select: none; }
        header b { flex: 1; font-size: 13px; }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; }
        .dot.on { background: #4ade80; }
        .body { padding: 10px; display: grid; gap: 9px; }
        .collapsed .body { display: none; }
        .status { color: #9fb0e0; font-size: 12px; min-height: 16px; }
        label.f { display: grid; grid-template-columns: 1fr 56px; gap: 4px 8px; align-items: center; color: #9fb0e0; }
        label.f span { grid-column: 1 / -1; }
        input[type=range] { width: 100%; accent-color: #f5a623; }
        input[type=number] { width: 56px; box-sizing: border-box; padding: 2px 4px; border-radius: 4px;
               border: 1px solid #2f3d68; background: #111a33; color: #e6ecff; font: inherit; text-align: right; }
        .check { display: flex; gap: 6px; align-items: center; color: #c9d4f5; cursor: pointer; }
        .check input { accent-color: #f5a623; }
        button { padding: 8px; border: 0; border-radius: 6px; background: #f5a623; color: #1c2541;
                 font: 700 13px system-ui, sans-serif; cursor: pointer; }
        button.stop { background: #e5484d; color: #fff; }
        .hint { color: #6f80b3; font-size: 11px; text-align: center; }
      </style>
      <div class="box">
        <header><span class="dot"></span><b>NT Autotyper</b><span class="chev">▾</span></header>
        <div class="body">
          <div class="status">Idle</div>
          <label class="f"><span>Speed (WPM)</span><input type="range" data-k="wpm" min="10" max="300" step="1"><input type="number" data-k="wpm" min="10" max="300"></label>
          <label class="f"><span>Accuracy (%)</span><input type="range" data-k="accuracy" min="80" max="100" step="0.5"><input type="number" data-k="accuracy" min="80" max="100" step="0.5"></label>
          <label class="f"><span>Timing variation (%)</span><input type="range" data-k="variance" min="0" max="60" step="1"><input type="number" data-k="variance" min="0" max="60"></label>
          <label class="check"><input type="checkbox" data-k="autoStart"> Start automatically each race</label>
          <button type="button" class="toggle">Start</button>
          <div class="hint">Alt+Shift+A starts/stops · any key stops</div>
        </div>
      </div>`;
    document.body.appendChild(panelHost);

    const $ = (sel) => root.querySelector(sel);
    const box = $(".box");
    const dot = $(".dot");
    const statusEl = $(".status");
    const toggleBtn = $(".toggle");
    let settings = loadSettings();

    const fill = () => {
      for (const el of root.querySelectorAll("[data-k]")) {
        const k = el.dataset.k;
        if (el.type === "checkbox") el.checked = settings[k];
        else el.value = settings[k];
      }
      box.classList.toggle("collapsed", settings.collapsed);
      $(".chev").textContent = settings.collapsed ? "▸" : "▾";
    };

    const apply = (partial) => {
      settings = normalize({ ...settings, ...partial });
      saveSettings(settings);
      handleCommand("settings", settings);
      broadcast({ cmd: "settings", settings });
    };

    for (const el of root.querySelectorAll("[data-k]")) {
      el.addEventListener(el.type === "checkbox" ? "change" : "input", () => {
        const k = el.dataset.k;
        if (el.type === "checkbox") return apply({ [k]: el.checked });
        // keep the slider and the number box in step
        for (const twin of root.querySelectorAll(`[data-k="${k}"]`)) if (twin !== el) twin.value = el.value;
        if (el.value !== "") apply({ [k]: el.value });
      });
      if (el.type === "number") el.addEventListener("change", fill); // snap out-of-range values
    }

    $("header").addEventListener("click", () => {
      apply({ collapsed: !settings.collapsed });
      fill();
    });
    toggleBtn.addEventListener("click", () => {
      sendCommand(panel.anyRunning() ? "stop" : "start");
      toggleBtn.blur(); // so the next key you press reaches the page
    });

    panel.render = () => {
      const all = [...panel.statuses.values()];
      const running = all.some((s) => s.running);
      // Prefer what the frame holding the race says.
      const shown = all.find((s) => s.running) ?? all.find((s) => s.hasRace) ?? all[all.length - 1];
      statusEl.textContent = shown?.message ?? "Idle";
      dot.classList.toggle("on", running);
      toggleBtn.textContent = running ? "Stop" : "Start";
      toggleBtn.classList.toggle("stop", running);
    };

    fill();
    panel.render();
  }
})();
