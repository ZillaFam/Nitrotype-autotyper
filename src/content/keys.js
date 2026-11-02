// Keyboard knowledge: which physical key (KeyboardEvent.code) produces a
// character on a US QWERTY layout, whether it needs Shift, and which keys sit
// next to it (used to pick believable typos).
(() => {
  const SHIFTED = {
    "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
    "&": "7", "*": "8", "(": "9", ")": "0", _: "-", "+": "=", "{": "[",
    "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
  };

  const PUNCT_CODES = {
    "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft",
    "]": "BracketRight", "\\": "Backslash", ";": "Semicolon", "'": "Quote",
    ",": "Comma", ".": "Period", "/": "Slash",
  };

  const ROWS = ["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"];
  // Horizontal stagger of each row, in key widths, so we can find the keys
  // physically above/below a key and not just left/right of it.
  const ROW_OFFSET = [0, 0.5, 0.75, 1.25];

  const POSITIONS = new Map();
  ROWS.forEach((row, r) => {
    [...row].forEach((ch, c) => POSITIONS.set(ch, { r, x: c + ROW_OFFSET[r] }));
  });

  const NEIGHBORS = new Map();
  for (const [ch, p] of POSITIONS) {
    const near = [];
    for (const [other, q] of POSITIONS) {
      if (other === ch) continue;
      if (Math.abs(q.r - p.r) <= 1 && Math.abs(q.x - p.x) <= 1.1) near.push(other);
    }
    NEIGHBORS.set(ch, near);
  }

  // Keys typed by the left hand; used to press the opposite Shift key.
  const LEFT_HAND = new Set("`12345qwertasdfgzxcvb");

  /** Describes the key press that produces `ch`. */
  function keyFor(ch) {
    if (ch === " ") return { key: " ", code: "Space", shift: false };
    if (ch === "\n") return { key: "Enter", code: "Enter", shift: false };
    if (ch === "\t") return { key: "Tab", code: "Tab", shift: false };

    const lower = ch.toLowerCase();
    if (lower >= "a" && lower <= "z" && lower.length === 1) {
      return { key: ch, code: `Key${lower.toUpperCase()}`, shift: ch !== lower };
    }
    if (ch >= "0" && ch <= "9") return { key: ch, code: `Digit${ch}`, shift: false };
    if (PUNCT_CODES[ch]) return { key: ch, code: PUNCT_CODES[ch], shift: false };

    const base = SHIFTED[ch];
    if (base !== undefined) {
      const code = base >= "0" && base <= "9" ? `Digit${base}` : PUNCT_CODES[base];
      return { key: ch, code, shift: true };
    }

    // Accented letters and other symbols have no QWERTY key; the browser
    // reports these as "Unidentified" when they come from an IME or layout.
    const shift = ch !== ch.toLowerCase();
    return { key: ch, code: "", shift };
  }

  /** The Shift key a touch typist would use for `ch`. */
  function shiftCodeFor(ch) {
    const base = SHIFTED[ch] ?? ch.toLowerCase();
    return LEFT_HAND.has(base) ? "ShiftRight" : "ShiftLeft";
  }

  /**
   * A plausible wrong character for `ch`: a neighbouring key, keeping the
   * case of the original. Returns null when no sensible typo exists.
   */
  function typoFor(ch) {
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    const base = SHIFTED[ch] ?? ch.toLowerCase();
    const near = NEIGHBORS.get(base);
    if (!near || near.length === 0) return null;
    // Prefer letters for letters so typos look like real fumbles.
    const isLetter = base >= "a" && base <= "z";
    const pool = isLetter ? near.filter((c) => c >= "a" && c <= "z") : near;
    const pick = (pool.length ? pool : near)[Math.floor(Math.random() * (pool.length || near.length))];
    if (ch !== ch.toLowerCase() && pick.toUpperCase() !== pick) return pick.toUpperCase();
    return pick;
  }

  globalThis.MTA_KEYS = { keyFor, shiftCodeFor, typoFor };
})();
