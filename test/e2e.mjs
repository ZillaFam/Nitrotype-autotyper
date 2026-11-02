// End-to-end test: loads the unpacked extension into Chromium, serves
// test/mock-monkeytype.html at https://monkeytype.com/, starts the autotyper
// and checks the result. Run with: node test/e2e.mjs
import { chromium } from "playwright";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mockHtml = readFileSync(path.join(root, "test/mock-monkeytype.html"), "utf8");
const userDataDir = mkdtempSync(path.join(tmpdir(), "mta-e2e-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
await context.route("https://monkeytype.com/**", (route) =>
  route.fulfill({ contentType: "text/html", body: mockHtml }),
);

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extensionId = new URL(worker.url()).host;

async function setSettings(settings) {
  await worker.evaluate((s) => chrome.storage.sync.set(s), settings);
}

async function sendToTab(type) {
  return worker.evaluate(async (t) => {
    const [tab] = await chrome.tabs.query({ url: "https://monkeytype.com/*" });
    return chrome.tabs.sendMessage(tab.id, { type: t });
  }, type);
}

async function openTest(query) {
  for (const p of context.pages()) await p.close();
  const page = await context.newPage();
  await page.goto(`https://monkeytype.com/${query}`);
  await page.waitForSelector("#words .word.active");
  await page.waitForTimeout(300); // let the content script load settings
  return page;
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function runCase({ name, query, settings, wpmTolerance = 0.2, accTolerance = 3 }) {
  await setSettings(settings);
  const page = await openTest(query);
  const started = await sendToTab("start");
  check(`${name}: starts`, started.running === true, started.message);
  await page.waitForFunction(() => window.__result, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.__result);
  // The typer notices the result screen on its next tick.
  let status = await sendToTab("getStatus");
  for (let i = 0; i < 20 && status.running; i++) {
    await page.waitForTimeout(100);
    status = await sendToTab("getStatus");
  }
  const detail = `wpm ${r.wpm.toFixed(1)}, acc ${r.accuracy.toFixed(1)}%, wrong keys ${r.wrongKeys}`;
  check(`${name}: finishes with every word correct`, r.allCorrect, detail);
  check(
    `${name}: speed near ${settings.wpm} WPM`,
    Math.abs(r.wpm - settings.wpm) / settings.wpm <= wpmTolerance,
    `got ${r.wpm.toFixed(1)}`,
  );
  if (accTolerance !== null) {
    check(
      `${name}: accuracy near ${settings.accuracy}%`,
      Math.abs(r.accuracy - settings.accuracy) <= accTolerance,
      `got ${r.accuracy.toFixed(1)}%`,
    );
  }
  check(`${name}: stops itself afterwards`, status.running === false, status.message);
  return r;
}

try {
  await runCase({
    name: "100% accuracy",
    query: "?words=40",
    settings: { wpm: 150, accuracy: 100, variance: 20, showOverlay: true },
    accTolerance: 0,
  });

  // Accuracy is random over a short test, so use a longer one and a loose band.
  await runCase({
    name: "95% accuracy",
    query: "?words=120",
    settings: { wpm: 200, accuracy: 95, variance: 25, showOverlay: true },
  });

  await runCase({
    name: "typos shown as typed (indicate typos: replace)",
    query: "?words=60&typos=replace",
    settings: { wpm: 200, accuracy: 90, variance: 25, showOverlay: true },
    accTolerance: 4,
  });

  // With stop-on-error the wrong key never lands, so nothing needs fixing.
  await runCase({
    name: "stop on error: letter",
    query: "?words=60&stopOnError=letter",
    settings: { wpm: 200, accuracy: 93, variance: 25, showOverlay: true },
    accTolerance: null,
  });

  // A real key press takes control back.
  await setSettings({ wpm: 60, accuracy: 100, variance: 20, showOverlay: true });
  const page = await openTest("?words=40");
  await sendToTab("start");
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
  const afterEsc = await sendToTab("getStatus");
  check("real key press stops it", afterEsc.running === false, afterEsc.message);
  const pill = await page.evaluate(() => {
    const host = document.documentElement.lastElementChild;
    return host?.tagName === "DIV" && host.style.position === "fixed";
  });
  check("status pill is mounted", pill);

  // Starting off the test page reports a clear message.
  await page.goto("https://monkeytype.com/").catch(() => {});
  await page.evaluate(() => document.getElementById("words").remove());
  const noTest = await sendToTab("start");
  await page.waitForTimeout(100);
  const noTestStatus = await sendToTab("getStatus");
  check("no test on page -> refuses", noTestStatus.running === false, noTestStatus.message ?? noTest.message);

  // Popup renders (it's opened in its own tab here, so it sees no Monkeytype tab).
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: 520 });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForTimeout(300);
  check("popup loads", (await popup.textContent("h1")) === "Monkeytype Autotyper");
  if (process.env.SCREENSHOT_DIR) {
    await popup.evaluate(() => {
      document.getElementById("wrong-site").hidden = true;
      document.getElementById("controls").hidden = false;
      document.getElementById("status").textContent = "Idle";
      document.getElementById("toggle").disabled = false;
    });
    await popup.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "popup.png"), fullPage: true });
  }
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
