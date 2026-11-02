// Handles the start/stop keyboard shortcut and keeps the toolbar badge in
// sync with whether a tab is autotyping.

const MONKEYTYPE_URL = /^https:\/\/([a-z0-9-]+\.)*monkeytype\.com\//i;

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-autotyper") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !MONKEYTYPE_URL.test(tab.url ?? "")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch {
    // The tab was open before the extension loaded; it needs a reload.
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#f59e0b" });
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "status" || !sender.tab?.id) return;
  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ tabId, text: msg.status.running ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#16a34a" });
});
