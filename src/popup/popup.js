const { load, save, normalize } = globalThis.MTA_SETTINGS;
const MONKEYTYPE_URL = /^https:\/\/([a-z0-9-]+\.)*monkeytype\.com\//i;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const toggleBtn = $("toggle");

let tabId = null;
let running = false;

// ---- settings --------------------------------------------------------------

const NUMERIC = ["wpm", "accuracy", "variance"];
let saveTimer = null;

function scheduleSave() {
  // chrome.storage.sync limits writes per minute, so batch slider drags.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const raw = { showOverlay: $("showOverlay").checked };
    for (const key of NUMERIC) raw[key] = $(key).value;
    save(normalize(raw));
  }, 250);
}

function fill(settings) {
  for (const key of NUMERIC) {
    $(key).value = settings[key];
    $(`${key}-range`).value = settings[key];
  }
  $("showOverlay").checked = settings.showOverlay;
}

for (const key of NUMERIC) {
  const number = $(key);
  const range = $(`${key}-range`);
  range.addEventListener("input", () => {
    number.value = range.value;
    scheduleSave();
  });
  number.addEventListener("input", () => {
    range.value = number.value;
    scheduleSave();
  });
  // Snap an out-of-range number back once the user leaves the box.
  number.addEventListener("change", () => {
    const fixed = normalize({ [key]: number.value })[key];
    number.value = fixed;
    range.value = fixed;
    scheduleSave();
  });
}
$("showOverlay").addEventListener("change", scheduleSave);

// ---- status ----------------------------------------------------------------

function showStatus(status) {
  running = Boolean(status.running);
  statusEl.textContent = status.running ? "Typing…" : status.message;
  statusEl.className = `status${status.running ? " running" : ""}`;
  toggleBtn.disabled = false;
  toggleBtn.textContent = running ? "Stop" : "Start";
  toggleBtn.classList.toggle("stop", running);
}

function showError(message) {
  statusEl.textContent = message;
  statusEl.className = "status error";
  toggleBtn.disabled = true;
}

async function send(type) {
  try {
    showStatus(await chrome.tabs.sendMessage(tabId, { type }));
  } catch {
    showError("Reload the Monkeytype tab, then try again.");
  }
}

toggleBtn.addEventListener("click", async () => {
  await send(running ? "stop" : "start");
  // Hand focus back to the page so the test isn't blurred behind the popup.
  if (running) window.close();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "status" && sender.tab?.id === tabId) showStatus(msg.status);
});

// ---- shortcut --------------------------------------------------------------

chrome.commands.getAll().then((commands) => {
  const cmd = commands.find((c) => c.name === "toggle-autotyper");
  if (cmd?.shortcut) $("shortcut").textContent = cmd.shortcut;
});

$("edit-shortcut").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

$("open-mt").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://monkeytype.com/" });
  window.close();
});

// ---- init ------------------------------------------------------------------

(async () => {
  fill(await load());
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !MONKEYTYPE_URL.test(tab.url ?? "")) {
    $("wrong-site").hidden = false;
    $("controls").hidden = true;
    statusEl.textContent = "Not on Monkeytype";
    return;
  }
  tabId = tab.id;
  await send("getStatus");
})();
