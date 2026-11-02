// End-to-end test for the userscript. Serves test/mock-nitrotype.html at
// https://www.nitrotype.com/race and injects the userscript at document-start
// in every frame, the way Tampermonkey does. Run with: npm test
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(path.join(root, "nitrotype-autotyper.user.js"), "utf8");
const mock = readFileSync(path.join(root, "test/mock-nitrotype.html"), "utf8");
const shotDir = process.env.SCREENSHOT_DIR;

const browser = await chromium.launch();
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function openRace(query, settings) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  await context.route("https://www.nitrotype.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: mock }),
  );
  await context.addInitScript((s) => {
    localStorage.setItem("nt-autotyper-settings", JSON.stringify(s));
  }, settings);
  await context.addInitScript({ content: script });
  const page = await context.newPage();
  await page.goto(`https://www.nitrotype.com/race${query}`);
  return { context, page };
}

const raceFrame = (page) => page.frames().find((f) => f.url().includes("listen") || f === page.mainFrame());

async function waitResult(page, frameQuery = false) {
  const frame = frameQuery ? page.frames()[1] : page.mainFrame();
  await frame.waitForFunction(() => window.__result, null, { timeout: 60000 });
  return frame.evaluate(() => window.__result);
}

const panelStatus = (page) => page.locator(".status").textContent();

async function raceCase({ name, query, settings, accTolerance = 3, inFrame = false }) {
  const { context, page } = await openRace(query, settings);
  const r = await waitResult(page, inFrame);
  const detail = `wpm ${r.wpm.toFixed(1)}, acc ${r.accuracy.toFixed(1)}%, wrong ${r.wrong}`;
  check(`${name}: finishes the race`, r.correct > 0, detail);
  check(`${name}: no keys rejected as untrusted`, r.untrusted === 0, `untrusted ${r.untrusted}`);
  check(`${name}: speed within 10% of ${settings.wpm}`, Math.abs(r.wpm - settings.wpm) / settings.wpm <= 0.1, `got ${r.wpm.toFixed(1)}`);
  check(`${name}: accuracy near ${settings.accuracy}%`, Math.abs(r.accuracy - settings.accuracy) <= accTolerance, `got ${r.accuracy.toFixed(1)}%`);
  await page.waitForTimeout(600);
  check(`${name}: panel shows it finished`, (await panelStatus(page)) === "Race finished", await panelStatus(page));
  await context.close();
  return r;
}

try {
  const base = { wpm: 100, accuracy: 100, variance: 25, autoStart: true, collapsed: false };

  const r1 = await raceCase({ name: "keypress listener", query: "?listen=keypress", settings: { ...base, wpm: 120 }, accTolerance: 0 });
  check("keypress listener: countdown keys ignored, then starts", r1.earlyKeys > 0, `${r1.earlyKeys} probe keys before GO`);
  await raceCase({ name: "keydown listener, 95%", query: "?listen=keydown", settings: { ...base, wpm: 150, accuracy: 95 } });
  await raceCase({ name: "document.onkeypress handler", query: "?listen=onkeypress", settings: { ...base, wpm: 90, accuracy: 97 } });
  await raceCase({ name: "input-event listener", query: "?listen=input", settings: { ...base, wpm: 110, accuracy: 96 } });
  await raceCase({ name: "race inside an iframe", query: "?listen=keypress&frame=1", settings: { ...base, wpm: 100, accuracy: 97 }, inFrame: true });

  // Manual mode: panel button, safety stop, shortcut.
  const { context, page } = await openRace("?listen=keypress&countdown=300", { ...base, wpm: 60, autoStart: false });
  await page.waitForTimeout(800);
  const untouched = await page.evaluate(() => document.querySelectorAll(".is-typed").length);
  check("auto-start off: waits for you", untouched === 0);
  check("page's own synthetic events stay untrusted", (await page.evaluate(() => window.__pageEventTrusted)) === false);
  if (shotDir) await page.screenshot({ path: path.join(shotDir, "panel.png"), clip: { x: 0, y: 380, width: 300, height: 320 } });

  await page.locator("button.toggle").click();
  await page.waitForTimeout(1200);
  const typedAfterStart = await page.evaluate(() => document.querySelectorAll(".is-typed").length);
  check("Start button types", typedAfterStart > 3, `${typedAfterStart} letters`);
  check("panel shows typing", (await panelStatus(page)) === "Typing…", await panelStatus(page));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const atStop = await page.evaluate(() => document.querySelectorAll(".is-typed").length);
  await page.waitForTimeout(600);
  const afterStop = await page.evaluate(() => document.querySelectorAll(".is-typed").length);
  check("real key press stops it", atStop === afterStop, await panelStatus(page));

  await page.keyboard.press("Alt+Shift+A");
  await page.waitForTimeout(800);
  const afterShortcut = await page.evaluate(() => document.querySelectorAll(".is-typed").length);
  check("Alt+Shift+A starts it again", afterShortcut > afterStop, `${afterStop} -> ${afterShortcut}`);
  await page.keyboard.press("Alt+Shift+A");
  await page.waitForTimeout(300);
  check("Alt+Shift+A stops it", (await page.locator("button.toggle").textContent()) === "Start");
  await context.close();
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
