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
const only = process.env.ONLY; // run one case by name substring

const browser = await chromium.launch();
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const BASE = { wpmMin: 100, wpmMax: 100, accuracy: 100, variance: 25, nitros: 0, races: 1 };

async function open(query, settings, ui, before) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.route("https://www.nitrotype.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: mock }),
  );
  await context.addInitScript(
    ([s, u]) => {
      if (window !== window.top || sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("nt-autotyper-settings", JSON.stringify(s));
      if (u) localStorage.setItem("nt-autotyper-ui", JSON.stringify(u));
    },
    [settings, ui],
  );
  if (before) await context.addInitScript(before);
  await context.addInitScript({ content: script });
  const page = await context.newPage();
  await page.goto(`https://www.nitrotype.com/race${query}`);
  await page.waitForSelector(".go");
  return { context, page };
}

const raceFrame = (page) => page.frames().find((f) => f !== page.mainFrame()) ?? page.mainFrame();
const results = (page) => raceFrame(page).evaluate(() => window.__results ?? []);
const status = (page) => page.locator(".status").textContent();

async function waitForResults(page, n, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if ((await results(page)).length >= n) return results(page);
    } catch {
      /* page reloading */
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`timed out waiting for ${n} race(s)`);
}

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    await fn(name);
  } catch (err) {
    check(`${name}: ran without error`, false, err.message.split("\n")[0]);
  }
}

// One race is only ~160 letters, so typo counts swing by a few either way.
function checkRace(name, r, { wpm, accuracy, accTol = 4.5 }) {
  check(`${name}: no events rejected as untrusted`, r.untrusted === 0, `untrusted ${r.untrusted}`);
  check(`${name}: speed within 10% of ${wpm}`, Math.abs(r.wpm - wpm) / wpm <= 0.1, `got ${r.wpm.toFixed(1)}`);
  check(`${name}: accuracy near ${accuracy}%`, Math.abs(r.accuracy - accuracy) <= accTol, `got ${r.accuracy.toFixed(1)}%, wrong ${r.wrong}`);
}

try {
  await test("auto-update header", async (name) => {
    const header = (key) => script.match(new RegExp(`^// @${key}\\s+(.+)$`, "m"))?.[1].trim();
    const raw = "https://raw.githubusercontent.com/ZillaFam/Nitrotype-autotyper/HEAD/nitrotype-autotyper.user.js";
    check(`${name}: @updateURL and @downloadURL point at the repo`, header("updateURL") === raw && header("downloadURL") === raw);
    check(`${name}: @version matches the version shown in the panel`, script.includes(`const VERSION = "${header("version")}"`), header("version"));
  });

  await test("single race (keypress)", async (name) => {
    const { context, page } = await open("?listen=keypress", { ...BASE, wpmMin: 120, wpmMax: 120 });
    check(`${name}: idle until Start`, (await page.evaluate(() => document.querySelectorAll(".is-typed").length)) === 0);
    check(`${name}: page's own synthetic events stay untrusted`, (await page.evaluate(() => window.__pageEventTrusted)) === false);
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    checkRace(name, r, { wpm: 120, accuracy: 100, accTol: 0 });
    check(`${name}: waited for GO`, r.earlyKeys > 0, `${r.earlyKeys} probe keys before GO`);
    await page.waitForTimeout(800);
    check(`${name}: session ends after 1 race`, (await status(page)) === "Done: 1 race", await status(page));
    await context.close();
  });

  for (const listen of ["keydown", "onkeypress", "input"]) {
    await test(`listener: ${listen}`, async (name) => {
      const { context, page } = await open(`?listen=${listen}`, { ...BASE, wpmMin: 110, wpmMax: 110, accuracy: 96 });
      await page.locator(".go").click();
      const [r] = await waitForResults(page, 1);
      checkRace(name, r, { wpm: 110, accuracy: 96 });
      await context.close();
    });
  }

  await test("nitros on the longest words", async (name) => {
    const { context, page } = await open("?nitros=5", { ...BASE, nitros: 2 });
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    // Longest words of the first text: "vexingly" (8) and "jumps"/"quick"/... -> first two by length.
    check(`${name}: used exactly 2`, r.nitroWords.length === 2, JSON.stringify(r.nitroWords));
    check(`${name}: on the longest words`, r.nitroWords[0] === "vexingly" || r.nitroWords.includes("vexingly"), JSON.stringify(r.nitroWords));
    check(`${name}: typing speed excludes the skip`, r.wpm > 100, `race WPM ${r.wpm.toFixed(1)} vs typing 100`);
    await context.close();
  });

  await test("nitros: none left", async (name) => {
    const { context, page } = await open("?nitros=0", { ...BASE, nitros: 3 });
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    check(`${name}: still finishes the race`, r.correct > 100 && r.nitroWords.length === 0, `wpm ${r.wpm.toFixed(1)}`);
    await context.close();
  });

  await test("3 races with Race Again + WPM/accuracy ranges + stats", async (name) => {
    const { context, page } = await open("?listen=keypress&countdown=800", { ...BASE, wpmMin: 90, wpmMax: 130, accMin: 94, accMax: 98, races: 3 });
    await page.locator(".go").click();
    await page.waitForTimeout(1500);
    check(`${name}: header shows race 1/3`, (await page.locator(".count").textContent()) === "race 1/3");
    const rs = await waitForResults(page, 3, 120000);
    check(`${name}: ran 3 races`, rs.length === 3);
    for (const r of rs) check(`${name}: race in 90–130 WPM band (±10%)`, r.wpm >= 81 && r.wpm <= 143, `got ${r.wpm.toFixed(1)}`);
    await page.waitForTimeout(8000);
    check(`${name}: stops after 3`, (await raceFrame(page).evaluate(() => window.__results.length)) === 3 && (await status(page)) === "Done: 3 races", await status(page));
    await page.locator('nav button[data-tab="stats"]').click();
    check(`${name}: stats show 3 races`, (await page.locator(".s-races").textContent()) === "3");
    check(`${name}: history has 3 rows`, (await page.locator(".history tr").count()) === 3);

    const stats = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-stats")));
    check(`${name}: each race picked an accuracy in 94–98%`, stats.every((r) => r.accTarget >= 94 && r.accTarget <= 98), stats.map((r) => r.accTarget).join(", "));
    const shown = rs.map((r) => r.shown);
    check(
      `${name}: Nitro Type's own results attached (WPM, place, money, XP)`,
      stats.every((r, i) => r.official && r.official.wpm === shown[i].wpm && r.official.place === shown[i].place && r.official.money === shown[i].money && r.official.xp === shown[i].xp),
      JSON.stringify(stats.map((r) => r.official)),
    );
    check(`${name}: header widget (avg WPM) not mistaken for results`, stats.every((r) => r.official?.wpm !== 88));
    check(`${name}: money card adds up`, (await page.locator(".s-money").textContent()) === `$${shown.reduce((a, r) => a + r.money, 0).toLocaleString()}`, await page.locator(".s-money").textContent());
    check(`${name}: no estimate marks`, (await page.locator(".footnote").textContent()) === "");

    const points = await page.locator(".chart-svg polyline").getAttribute("points");
    check(`${name}: chart plots 3 races`, points?.trim().split(" ").length === 3, points);
    const chartBox = await page.locator(".chart").boundingBox();
    await page.mouse.move(chartBox.x + chartBox.width - 10, chartBox.y + chartBox.height / 2);
    const tip = await page.locator(".chart .tip").textContent();
    check(`${name}: chart tooltip on hover`, (await page.locator(".chart .tip").isVisible()) && /\d+ WPM · [\d.]+% · /.test(tip), tip);
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-stats.png") });
    await context.close();
  });

  await test("long breaks between races", async (name) => {
    const { context, page } = await open("?countdown=500", { ...BASE, wpmMin: 200, wpmMax: 200, races: 2, breakEvery: 1, breakLenMin: 0.1, breakLenMax: 0.1 });
    await page.evaluate(() => (document.title = "Nitro Type"));
    await page.locator(".go").click();
    await waitForResults(page, 1);
    await page.waitForTimeout(1500);
    const msg = await status(page);
    check(`${name}: takes a break after the race`, /^On a break · 0:0\d left$/.test(msg), msg);
    check(`${name}: tab title shows the break`, (await page.title()).startsWith("❚❚ 1/2 · "), await page.title());
    const breakSeenAt = Date.now();
    const rs = await waitForResults(page, 2, 60000);
    check(`${name}: next race only after the break`, Date.now() - breakSeenAt > 3500 && rs.length === 2);
    await page.waitForTimeout(1000);
    check(`${name}: session finished`, (await status(page)) === "Done: 2 races", await status(page));
    await context.close();
  });

  await test("no Race Again button: reload fallback", async (name) => {
    const { context, page } = await open("?again=none&countdown=800", { ...BASE, wpmMin: 200, wpmMax: 200, races: 2 });
    await page.locator(".go").click();
    const rs = await waitForResults(page, 2, 60000);
    check(`${name}: second race after reload`, rs.length === 2);
    await page.waitForTimeout(1000);
    check(`${name}: session finished`, (await status(page)) === "Done: 2 races", await status(page));
    await context.close();
  });

  await test("race inside an iframe, 2 races", async (name) => {
    const { context, page } = await open("?frame=1&countdown=800", { ...BASE, wpmMin: 150, wpmMax: 150, accuracy: 97, races: 2, nitros: 1 });
    await page.locator(".go").click();
    const rs = await waitForResults(page, 2, 60000);
    check(`${name}: 2 races typed in the iframe`, rs.length === 2);
    checkRace(name, rs[0], { wpm: 150 * 1.07, accuracy: 97 }); // a nitro adds a few %
    check(`${name}: nitro used`, rs.every((r) => r.nitroWords.length === 1));
    await page.waitForTimeout(1000);
    check(`${name}: panel shows done`, (await status(page)) === "Done: 2 races", await status(page));
    await context.close();
  });

  // What Chrome does to a tab you're not looking at: page timers fire at most
  // about once a second, and the page reports itself hidden.
  function simulateBackgroundTab() {
    const realSetTimeout = window.setTimeout;
    const realSetInterval = window.setInterval;
    window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.max(1000, ms || 0), ...args);
    window.setInterval = (fn, ms, ...args) => realSetInterval(fn, Math.max(1000, ms || 0), ...args);
    Object.defineProperty(document, "hidden", { get: () => true });
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
    // Record desktop notifications instead of showing them.
    window.__notes = [];
    window.Notification = class {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title, opts) {
        window.__notes.push(`${title}: ${opts?.body}`);
      }
    };
  }

  await test("background tab (throttled page timers)", async (name) => {
    const { context, page } = await open("?countdown=500", { ...BASE, wpmMin: 120, wpmMax: 120, accuracy: 97, races: 2, nitros: 0, notify: true }, null, simulateBackgroundTab);
    await page.evaluate(() => {
      document.title = "Nitro Type";
    });
    await page.locator(".go").click();
    await page.waitForTimeout(2500);
    check(`${name}: tab title shows progress`, (await page.title()).startsWith("▶ 0/2 · "), await page.title());
    const rs = await waitForResults(page, 2, 60000);
    for (const r of rs) checkRace(name, r, { wpm: 120, accuracy: 97 });
    await page.waitForTimeout(1500);
    check(`${name}: title says done`, (await page.title()) === "✓ Done: 2 races · Nitro Type", await page.title());
    const notes = await page.evaluate(() => window.__notes);
    check(`${name}: desktop notification when done`, notes.length === 1 && notes[0] === "NT Autotyper: Done: 2 races", JSON.stringify(notes));
    await context.close();
  });

  await test("workers blocked: falls back to normal timers", async (name) => {
    const { context, page } = await open("", { ...BASE, wpmMin: 130, wpmMax: 130 }, null, () => {
      window.Worker = function () {
        throw new Error("blocked by CSP");
      };
    });
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    checkRace(name, r, { wpm: 130, accuracy: 100, accTol: 0 });
    await context.close();
  });

  // Tampermonkey doesn't always inject at document-start; the panel must
  // still appear (and work) when the script runs after the page has loaded.
  await test("injected after page load", async (name) => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.route("https://www.nitrotype.com/**", (route) => route.fulfill({ contentType: "text/html", body: mock }));
    await context.addInitScript((s) => localStorage.setItem("nt-autotyper-settings", JSON.stringify(s)), { ...BASE, wpmMin: 120, wpmMax: 120 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("https://www.nitrotype.com/race?countdown=2500");
    await page.evaluate(script);
    check(`${name}: no script errors`, errors.length === 0, errors.join(" | "));
    check(`${name}: panel shows up`, await page.locator(".go").isVisible());
    check(`${name}: warns it loaded late`, (await status(page)).startsWith("Loaded late"), await status(page));
    await context.close();
  });

  await test("controls: stop key, shortcut, drag, collapse", async (name) => {
    const { context, page } = await open("?countdown=300", { ...BASE, wpmMin: 60, wpmMax: 60, races: 3 });
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-race.png") });
    check(`${name}: setting labels filled in`, (await page.locator('[data-show="variance"]').textContent()) === "25" && (await page.locator(".accLabel").textContent()) === "100%");
    await page.locator(".go").click();
    await page.waitForTimeout(1500);
    const typed = () => page.evaluate(() => document.querySelectorAll(".is-typed").length);
    check(`${name}: Start types`, (await typed()) > 3);
    check(`${name}: live chips show target`, (await page.locator(".chips").textContent()).includes("target 60"), await page.locator(".chips").textContent());
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-typing.png") });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const atStop = await typed();
    await page.waitForTimeout(600);
    check(`${name}: real key press stops the session`, atStop === (await typed()) && (await page.locator(".go").textContent()) === "Start", await status(page));

    await page.keyboard.press("Alt+Shift+A");
    await page.waitForTimeout(900);
    check(`${name}: Alt+Shift+A starts again`, (await typed()) > atStop);
    await page.keyboard.press("Alt+Shift+A");
    await page.waitForTimeout(300);
    check(`${name}: Alt+Shift+A stops`, (await page.locator(".go").textContent()) === "Start");

    const before = await page.locator(".box").boundingBox();
    await page.mouse.move(before.x + 60, before.y + 15);
    await page.mouse.down();
    const dy = -Math.min(100, Math.floor(before.y));
    await page.mouse.move(before.x + 360, before.y + 15 + dy, { steps: 8 });
    await page.mouse.up();
    const after = await page.locator(".box").boundingBox();
    check(`${name}: drag moves the panel`, Math.abs(after.x - before.x - 300) < 3 && Math.abs(after.y - before.y - dy) < 3, `${before.x},${before.y} -> ${after.x},${after.y}`);

    // Debug view
    await page.locator('nav button[data-tab="panel"]').click();
    await page.locator('input[data-k="debug"]').check();
    await page.waitForTimeout(1500);
    const dbg = await page.locator("pre.debug").textContent();
    check(`${name}: debug view shows the race`, (await page.locator("pre.debug").isVisible()) && /race: \d+ letters, at \d+/.test(dbg) && dbg.includes("classes: dash-letter"), dbg.split("\n").slice(0, 12).join(" / "));
    check(`${name}: debug view shows timers and load timing`, dbg.includes("timers: worker") && dbg.includes("script loaded: on time"));
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-debug.png") });

    // Compact mode
    await page.locator(".compact-btn").click();
    const compact = await page.locator(".box").boundingBox();
    check(`${name}: compact mode is small but keeps Start`, compact.height < 150 && (await page.locator(".go").isVisible()) && !(await page.locator(".tabs").isVisible()), `height ${compact.height}`);
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-compact.png") });
    await page.reload();
    await page.waitForSelector(".go", { state: "attached" });
    check(`${name}: compact mode remembered`, (await page.locator(".box").boundingBox()).height < 150);
    await page.locator(".compact-btn").click();
    await page.locator('input[data-k="debug"]').uncheck();

    await page.locator(".collapse").click();
    const collapsed = await page.locator(".box").boundingBox();
    check(`${name}: collapse shrinks it`, collapsed.height < 60, `height ${collapsed.height}`);
    await page.reload();
    await page.waitForSelector(".go", { state: "attached" });
    const reloaded = await page.locator(".box").boundingBox();
    check(`${name}: position and collapse remembered`, Math.abs(reloaded.x - after.x) < 3 && reloaded.height < 60, `${reloaded.x},${reloaded.y} h${reloaded.height}`);
    await context.close();
  });
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
