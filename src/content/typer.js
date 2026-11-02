// The typing engine.
//
// Monkeytype reads keystrokes from a hidden <textarea id="wordsInput">. Its
// value is always " " + the input for the current word (the leading space is
// deliberate), and Monkeytype reacts to these events on it:
//   keydown -> beforeinput (cancelable) -> [browser edits value] -> input -> keyup
// Synthetic events don't make the browser edit the value, so we do that part
// ourselves, but only when Monkeytype didn't cancel the beforeinput.
//
// The loop never assumes a keystroke worked. Before every key it re-reads the
// active word and the textarea, then decides: next correct letter, a typo,
// a space, or backspace to fix a mistake. That keeps it in sync with settings
// like stop-on-error, and with the user restarting the test.
(() => {
  const { keyFor, shiftCodeFor, typoFor } = globalThis.MTA_KEYS;

  // Chance that a typo is noticed one letter late, like a real typist.
  const LATE_NOTICE_CHANCE = 0.35;
  // Average pause before starting to fix a typo, in ms.
  const REACTION_MS = { min: 120, max: 300 };
  // Stop if Monkeytype ignores our input for this long.
  const STALL_TIMEOUT_MS = 4000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const rand = (min, max) => min + Math.random() * (max - min);

  // Standard normal sample (Box-Muller).
  function gaussian() {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }

  // ---- reading Monkeytype's DOM -------------------------------------------

  function readState() {
    const input = document.getElementById("wordsInput");
    const word = document.querySelector("#words .word.active");
    if (!input || !word || !input.isConnected || word.getClientRects().length === 0) {
      return null;
    }
    const value = input.value;
    const index = Number(word.dataset.wordindex);
    return {
      input,
      word,
      index: Number.isFinite(index) ? index : -1,
      typed: value.startsWith(" ") ? value.slice(1) : value,
    };
  }

  // The text of a word, from its <letter> children. Read it before anything
  // is typed into the word: with "indicate typos: replace" a wrong letter
  // shows what was typed instead of what was expected.
  function readTarget(word) {
    let text = "";
    for (const letter of word.querySelectorAll(":scope > letter")) {
      const cls = letter.classList;
      if (cls.contains("extra") || cls.contains("invisible")) continue;
      if (cls.contains("tabChar")) text += "\t";
      else if (cls.contains("nlChar")) text += "\n";
      else text += letter.textContent;
    }
    return text;
  }

  // ---- synthesising keystrokes --------------------------------------------

  function fireKey(target, type, key, code, shiftKey) {
    return target.dispatchEvent(
      new KeyboardEvent(type, { key, code, shiftKey, bubbles: true, cancelable: true, composed: true }),
    );
  }

  function fireInput(input, inputType, data, edit) {
    const init = { inputType, data, bubbles: true, composed: true };
    const before = new InputEvent("beforeinput", { ...init, cancelable: true });
    if (!input.dispatchEvent(before)) return false;
    input.value = edit(input.value);
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new InputEvent("input", init));
    return true;
  }

  function pressChar(input, ch, holdMs) {
    const k = keyFor(ch);
    const shiftCode = k.shift ? shiftCodeFor(ch) : null;
    if (shiftCode) fireKey(input, "keydown", "Shift", shiftCode, true);
    const allowed = fireKey(input, "keydown", k.key, k.code, k.shift);
    // Monkeytype inserts tabs itself from the keydown handler.
    if (allowed && ch !== "\t") {
      if (ch === "\n") fireInput(input, "insertLineBreak", null, (v) => v + "\n");
      else fireInput(input, "insertText", ch, (v) => v + ch);
    }
    setTimeout(() => {
      fireKey(input, "keyup", k.key, k.code, k.shift);
      if (shiftCode) fireKey(input, "keyup", "Shift", shiftCode, false);
    }, holdMs);
  }

  function pressBackspace(input, holdMs) {
    if (fireKey(input, "keydown", "Backspace", "Backspace", false)) {
      fireInput(input, "deleteContentBackward", null, (v) => v.slice(0, -1));
    }
    setTimeout(() => fireKey(input, "keyup", "Backspace", "Backspace", false), holdMs);
  }

  // ---- timing --------------------------------------------------------------

  // Chance of a typo on each letter, so that the final accuracy lands near the
  // target. Monkeytype accuracy = correct keys / (correct + wrong keys), and
  // spaces (~1 in 6 keys) are never typos, hence the 1.2 factor.
  function typoChance(accuracy) {
    if (accuracy >= 100) return 0;
    return Math.min(0.5, (100 / accuracy - 1) * 1.2);
  }

  // Base gap between keystrokes. Each typo costs extra keys (the wrong one,
  // sometimes a late one, and the backspaces) plus a reaction pause, so type
  // the rest a bit faster to still average the target WPM.
  function baseInterval(wpm, pTypo) {
    const perChar = 12000 / wpm; // 60s / (wpm * 5 chars)
    const extraKeys = pTypo * (2 + 2 * LATE_NOTICE_CHANCE);
    const reaction = pTypo * ((REACTION_MS.min + REACTION_MS.max) / 2);
    return Math.max(6, (perChar - reaction) / (1 + extraKeys));
  }

  // How much of the pace error to correct on each keystroke.
  const PACE_GAIN = 0.3;

  function commonPrefixLength(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  function jitter(ms, variancePct) {
    const factor = 1 + gaussian() * (variancePct / 100);
    return ms * Math.min(2.5, Math.max(0.35, factor));
  }

  // ---- the engine ------------------------------------------------------------

  class Typer {
    constructor(onStatus) {
      this.onStatus = onStatus;
      this.settings = globalThis.MTA_SETTINGS.DEFAULTS;
      this.runId = 0;
      this.status = { running: false, message: "Idle" };
    }

    setSettings(settings) {
      this.settings = settings;
    }

    start() {
      if (this.status.running) return;
      const id = ++this.runId;
      this.setStatus({ running: true, message: "Typing…" });
      this.loop(id).catch((err) => {
        console.error("[Monkeytype Autotyper]", err);
        this.halt(id, `Error: ${err.message}`);
      });
    }

    stop(message = "Stopped") {
      if (!this.status.running) return;
      this.runId++;
      this.setStatus({ running: false, message });
    }

    toggle() {
      if (this.status.running) this.stop();
      else this.start();
    }

    halt(id, message) {
      if (id !== this.runId) return;
      this.runId++;
      this.setStatus({ running: false, message });
    }

    setStatus(status) {
      this.status = status;
      this.onStatus(status);
    }

    async loop(id) {
      const alive = () => id === this.runId;

      let state = readState();
      if (!state) {
        this.halt(id, "No typing test here. Open the Monkeytype test page first.");
        return;
      }
      state.input.focus({ preventScroll: true });

      const targets = new Map(); // word index -> expected text
      let lastIndex = state.index;
      let typedAnything = false;
      let lateLetters = 0; // correct letters to type before noticing a typo
      let correcting = false;
      let lastSignature = "";
      let lastProgressAt = performance.now();
      let nextAt = performance.now();
      // Pace control: correct letters (and spaces) in finished words, and the
      // point we measure speed from. Settings like stop-on-error change how
      // much time typos really cost, so we steer by the measured pace.
      let committed = 0;
      let pace = null;
      let lastTypoSpot = ""; // don't fumble the same letter twice in a row

      while (alive()) {
        await sleep(nextAt - performance.now());
        if (!alive()) return;

        state = readState();
        if (!state) {
          this.halt(id, typedAnything ? "Test finished" : "Typing test closed");
          return;
        }

        const now = performance.now();
        // A new test (restart) starts back at word 0.
        if (state.index < lastIndex) {
          targets.clear();
          correcting = false;
          lateLetters = 0;
          committed = 0;
          pace = null;
        }
        for (let i = lastIndex; i < state.index; i++) {
          const done = targets.get(i) ?? "";
          committed += done.length + (done.endsWith("\n") ? 0 : 1);
        }
        lastIndex = state.index;

        let target = targets.get(state.index);
        if (target === undefined) {
          target = readTarget(state.word);
          targets.set(state.index, target);
        }
        if (!target) {
          this.halt(id, "Couldn't read the words (zen mode isn't supported)");
          return;
        }

        const signature = `${state.index}|${state.typed}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastProgressAt = now;
        } else if (now - lastProgressAt > STALL_TIMEOUT_MS) {
          this.halt(id, "Stopped: Monkeytype isn't accepting input");
          return;
        }

        const { wpm, accuracy, variance } = this.settings;
        const pTypo = typoChance(accuracy);
        const interval = baseInterval(wpm, pTypo);
        const typed = state.typed;
        const hold = rand(45, 105);

        // Nudge the gap toward the target WPM based on real progress so far.
        const progress = committed + commonPrefixLength(typed, target);
        if (!pace || pace.wpm !== wpm) pace = { at: now, chars: progress, wpm };
        const behindMs = now - pace.at - (progress - pace.chars) * (12000 / wpm);
        const correction = Math.min(1.5 * interval, Math.max(-0.6 * interval, -behindMs * PACE_GAIN));
        const gap = Math.max(2, jitter(interval, variance) + correction);

        if (target.startsWith(typed)) {
          correcting = false;
          if (typed.length < target.length) {
            const ch = target[typed.length];
            const spot = `${state.index}:${typed.length}`;
            const typo = spot !== lastTypoSpot && Math.random() < pTypo ? typoFor(ch) : null;
            if (typo) {
              lastTypoSpot = spot;
              lateLetters = Math.random() < LATE_NOTICE_CHANCE ? 1 : 0;
            }
            pressChar(state.input, typo ?? ch, hold);
          } else if (target.endsWith("\n")) {
            // The newline already ended the word; wait for Monkeytype to move on.
            nextAt = now + 5;
            continue;
          } else {
            pressChar(state.input, " ", hold);
          }
        } else if (typed.startsWith(target) && /^\s+$/.test(typed.slice(target.length))) {
          // Space typed, Monkeytype hasn't moved to the next word yet.
          nextAt = now + 5;
          continue;
        } else if (lateLetters > 0 && typed.length < target.length) {
          lateLetters--;
          pressChar(state.input, target[typed.length], hold);
        } else {
          if (!correcting) {
            // Pause to "notice" the mistake before the first backspace.
            correcting = true;
            nextAt = now + rand(REACTION_MS.min, REACTION_MS.max);
            continue;
          }
          pressBackspace(state.input, hold);
        }

        typedAnything = true;
        // Schedule from the planned time so timer delays don't drift the WPM,
        // but don't try to catch up in a burst if we fell far behind.
        nextAt = Math.max(nextAt, performance.now() - interval) + gap;
      }
    }
  }

  globalThis.MTA_Typer = Typer;
})();
