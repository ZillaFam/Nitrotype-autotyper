// Shared between the popup and the content script (both load this file as a
// classic script, so everything hangs off one global object).
(() => {
  const DEFAULTS = Object.freeze({
    wpm: 100, // target speed in words per minute (1 word = 5 keystrokes)
    accuracy: 97, // target accuracy in percent; misses are typed and then fixed
    variance: 25, // keystroke timing jitter, in percent of the base interval
    showOverlay: true, // small status pill on the Monkeytype page
  });

  const LIMITS = Object.freeze({
    wpm: { min: 10, max: 400 },
    accuracy: { min: 80, max: 100 },
    variance: { min: 0, max: 60 },
  });

  function clamp(value, { min, max }) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    return {
      wpm: Math.round(clamp(s.wpm, LIMITS.wpm)),
      accuracy: clamp(s.accuracy, LIMITS.accuracy),
      variance: Math.round(clamp(s.variance, LIMITS.variance)),
      showOverlay: Boolean(s.showOverlay),
    };
  }

  async function load() {
    const raw = await chrome.storage.sync.get(Object.keys(DEFAULTS));
    return normalize(raw);
  }

  async function save(partial) {
    const next = normalize({ ...(await load()), ...partial });
    await chrome.storage.sync.set(next);
    return next;
  }

  globalThis.MTA_SETTINGS = { DEFAULTS, LIMITS, normalize, load, save };
})();
