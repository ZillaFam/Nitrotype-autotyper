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

const BASE = { wpmMin: 100, wpmMax: 100, accuracy: 100, variance: 25, nitros: 0, races: 1, offDays: false };

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
    [settings, ui ?? { advanced: true }],
  );
  if (before) await context.addInitScript(before);
  await context.addInitScript({ content: script });
  const page = await context.newPage();
  await page.goto(`https://www.nitrotype.com/race${query}`);
  await page.waitForSelector(".go");
  return { context, page };
}

// The race's own iframe (in the ?frame=1 layout), not e.g. the reCAPTCHA badge.
const raceFrame = (page) => page.frames().find((f) => f !== page.mainFrame() && f.url().includes("nitrotype.com/race")) ?? page.mainFrame();
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
    await page.waitForTimeout(800);
    check(`${name}: session ends after 1 race`, (await status(page)) === "Done: 1 race", await status(page));
    await context.close();
  });

  await test("GO without race status events", async (name) => {
    const { context, page } = await open("?status=none", { ...BASE, wpmMin: 120, wpmMax: 120 });
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    checkRace(name, r, { wpm: 120, accuracy: 100, accTol: 0 });
    check(`${name}: keeps trying the first key until GO`, r.earlyKeys > 0, `${r.earlyKeys} keys before GO`);
    await context.close();
  });

  // The rhythm of a person: slower on capitals and after sentences, with the
  // overall speed still on target.
  await test("human rhythm", async (name) => {
    const { context, page } = await open("?countdown=300", { ...BASE, wpmMin: 90, wpmMax: 90, variance: 10, races: 2, humanLevel: "natural" });
    await page.locator(".go").click();
    const results = await waitForResults(page, 2, 90000);
    const caps = [];
    const lower = [];
    const sentence = [];
    const spaces = [];
    const sameHand = [];
    const altHand = [];
    const LEFT = new Set("qwertasdfgzxcvb");
    for (const r of results) {
      checkRace(`${name} (race)`, r, { wpm: 90, accuracy: 100, accTol: 0 });
      const ok = r.keys.filter((k) => k.ok);
      for (let i = 1; i < ok.length; i++) {
        const gap = ok[i].t - ok[i - 1].t;
        const ch = r.text[i];
        const prev = r.text[i - 1];
        if (ch === " ") (/[.!?]/.test(prev) ? sentence : spaces).push(gap);
        else if (/[A-Z]/.test(ch)) caps.push(gap);
        else if (/[a-z]/.test(ch)) {
          lower.push(gap);
          if (/[a-z]/.test(prev) && prev !== ch) (LEFT.has(prev) === LEFT.has(ch) ? sameHand : altHand).push(gap);
        }
      }
    }
    // The first race may start before the script hears the countdown; the
    // second can't. (The mock's early-key count adds up over the page.)
    const early2 = results[1].earlyKeys - results[0].earlyKeys;
    check(`${name}: no keys before GO`, early2 === 0, `${early2} keys before GO in race 2`);
    check(`${name}: first key a human reaction time after GO`, results[1].firstKeyMs >= 180 && results[1].firstKeyMs <= 900, `${results[1].firstKeyMs} ms`);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    check(`${name}: capitals slower than lowercase`, avg(caps) > 1.15 * avg(lower), `${avg(caps).toFixed(0)} vs ${avg(lower).toFixed(0)} ms`);
    check(`${name}: a beat after a sentence`, avg(sentence) > 1.6 * avg(spaces), `${avg(sentence).toFixed(0)} vs ${avg(spaces).toFixed(0)} ms`);
    check(`${name}: alternating hands faster than one hand`, avg(altHand) < avg(sameHand), `${avg(altHand).toFixed(0)} vs ${avg(sameHand).toFixed(0)} ms`);
    const gaps = results[0].keys.filter((k) => k.ok).map((k, i, a) => (i ? k.t - a[i - 1].t : 0)).slice(1);
    const spread = Math.sqrt(avg(gaps.map((g) => (g - avg(gaps)) ** 2))) / avg(gaps);
    check(`${name}: uneven like a person (not a metronome)`, spread > 0.2, `spread ${spread.toFixed(2)}`);
    await context.close();
  });

  await test("human touch setting", async (name) => {
    const { context, page } = await open("", { ...BASE }, { advanced: false });
    check(`${name}: shown in simple mode, Natural by default`, (await page.locator(".seg [data-human].on").textContent()) === "Natural");
    await page.locator('.seg [data-human="strong"]').click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-settings")).humanLevel);
    check(`${name}: picking Strong saves it`, saved === "strong" && (await page.locator(".seg [data-human].on").textContent()) === "Strong", saved);
    check(`${name}: explains it`, (await page.locator(".human-hint").textContent()).startsWith("Very human"));
    check(`${name}: settings grouped`, (await page.locator(".g-head").allTextContents()).join(",") === "Speed & accuracy,Human touch,Session");
    check(`${name}: status badge says Idle`, (await page.locator(".badge").textContent()) === "Idle");
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-simple-groups.png") });
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
      stats.every(
        (r, i) =>
          r.official &&
          r.official.wpm === shown[i].wpm &&
          r.official.accuracy === shown[i].accuracy &&
          r.official.place === shown[i].place &&
          r.official.money === shown[i].money &&
          r.official.xp === shown[i].xp,
      ),
      JSON.stringify(stats.map((r) => r.official)),
    );
    check(`${name}: header widget (avg WPM) not mistaken for results`, stats.every((r) => r.official?.wpm !== 88));
    check(`${name}: money card adds up`, (await page.locator(".s-money").textContent()) === `$${shown.reduce((a, r) => a + r.money, 0).toLocaleString()}`, await page.locator(".s-money").textContent());
    check(`${name}: no estimate marks`, (await page.locator(".footnote").textContent()) === "");

    const points = await page.locator(".chart-svg polyline").getAttribute("points");
    check(`${name}: chart plots 3 races`, points?.trim().split(" ").length === 3, points);
    const chartBox = await page.locator(".chart:not(.days)").boundingBox();
    await page.mouse.move(chartBox.x + chartBox.width - 10, chartBox.y + chartBox.height / 2);
    const tip = await page.locator(".chart:not(.days) .tip").textContent();
    check(`${name}: chart tooltip on hover`, (await page.locator(".chart:not(.days) .tip").isVisible()) && /\d+ WPM · [\d.]+% · /.test(tip), tip);
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-stats.png") });
    await context.close();
  });

  await test("other racers: live standings and the result card", async (name) => {
    const { context, page } = await open("?countdown=500", { ...BASE, wpmMin: 120, wpmMax: 120, races: 1 }, {});
    await page.locator(".go").click();
    await page.waitForTimeout(3000);
    const rows = await page.locator(".live-people .p-row").allTextContents();
    check(`${name}: live standings list all 4 racers`, rows.length === 4 && rows.some((r) => r.includes("You")) && rows.some((r) => r.includes("Speedy")), rows.join(" | "));
    check(`${name}: dots for the 3 others on the track`, (await page.locator(".box .rivals i").count()) === 3);
    check(`${name}: Speedy (160 WPM) leads Slowpoke`, rows.findIndex((r) => r.includes("Speedy")) < rows.findIndex((r) => r.includes("Slowpoke")), rows.join(" | "));
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "people-live.png") });

    await page.locator(".focus-btn").click();
    check(`${name}: focus view shows standings too`, (await page.locator(".f-people .p-row").count()) === 4);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "people-focus.png") });
    await page.keyboard.press("Escape");

    const [r] = await waitForResults(page, 1);
    await page.waitForTimeout(2500); // results screen shows ~0.6 s after the finish
    const card = page.locator(".result-card");
    const want = r.shown;
    const suffix = ["st", "nd", "rd"][want.place - 1] ?? "th";
    check(`${name}: result card after the race`, await card.isVisible());
    check(`${name}: place badge`, (await card.locator(".rc-place").textContent()) === `${want.place}${suffix}`, await card.locator(".rc-place").textContent());
    const main = await card.locator(".rc-main").textContent();
    check(`${name}: your official WPM and accuracy`, main === `${want.wpm} wpm · ${want.accuracy.toFixed(1)}%`, main);
    const sub = await card.locator(".rc-sub").textContent();
    check(`${name}: money and XP`, sub.includes(`$${want.money.toLocaleString()}`) && sub.includes(`+${want.xp} XP`), sub);
    const finals = await card.locator(".p-row").allTextContents();
    check(`${name}: final standings`, finals.length === 4 && finals.some((x) => x.startsWith(`${want.place}${suffix}You`)), finals.join(" | "));
    check(`${name}: no live standings after the race`, (await page.locator(".live-people .p-row").count()) === 0);
    const boxRect = await page.locator(".box").boundingBox();
    check(`${name}: the whole panel stays on screen`, boxRect.y >= 0 && boxRect.y + boxRect.height <= 800 && (await page.locator(".go").isVisible()), JSON.stringify(boxRect));
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "people-result.png") });
    await context.close();
  });

  await test("results without race state: your row, not the winner's", async (name) => {
    const { context, page } = await open("?state=none&countdown=500", { ...BASE, wpmMin: 120, wpmMax: 120, races: 1 });
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    await page.waitForTimeout(3000);
    const [st] = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-stats")));
    const o = st.official ?? {};
    check(
      `${name}: WPM, accuracy, place, money, XP from the results table`,
      o.wpm === r.shown.wpm && o.accuracy === r.shown.accuracy && o.place === r.shown.place && o.money === r.shown.money && o.xp === r.shown.xp,
      JSON.stringify({ got: { ...o, racers: undefined }, want: r.shown }),
    );
    check(`${name}: everyone's names from the table`, (o.racers ?? []).map((x) => x.name).join(",") === r.shown.names.join(","), JSON.stringify(o.racers?.map((x) => x.name)));
    await context.close();
  });

  await test("results from a plain results box", async (name) => {
    const { context, page } = await open("?state=none&results=plain&countdown=500", { ...BASE, wpmMin: 120, wpmMax: 120, races: 1 });
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    await page.waitForTimeout(3000);
    const [st] = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-stats")));
    const o = st.official ?? {};
    check(`${name}: still finds WPM, place, money, XP`, o.wpm === r.shown.wpm && o.place === r.shown.place && o.money === r.shown.money && o.xp === r.shown.xp, JSON.stringify(o));
    await context.close();
  });

  await test("off race", async (name) => {
    const { context, page } = await open("", { ...BASE, wpmMin: 120, wpmMax: 120, offDays: true }, null, () => (window.__ntAutotyperOffDay = "off"));
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    check(`${name}: slower than the range (80-90% of it)`, r.wpm > 120 * 0.74 && r.wpm < 120 * 0.95, `got ${r.wpm.toFixed(1)}`);
    await page.waitForTimeout(800);
    const [st] = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-stats")));
    check(`${name}: noted in the stats`, st.offDay === "off", JSON.stringify(st.offDay));
    await page.locator('nav button[data-tab="stats"]').click();
    check(`${name}: tagged in the history`, (await page.locator(".history .tag").textContent()) === "off");
    await context.close();
  });

  await test("slow start", async (name) => {
    const { context, page } = await open("", { ...BASE, wpmMin: 100, wpmMax: 100, variance: 10, offDays: true }, null, () => (window.__ntAutotyperOffDay = "slow"));
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    const ok = r.keys.filter((k) => k.ok);
    const gaps = ok.slice(1).map((k, i) => k.t - ok[i].t);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const n = Math.round(gaps.length * 0.1);
    const early = avg(gaps.slice(2, n)); // skip the first keys' warm-up
    const later = avg(gaps.slice(Math.round(gaps.length * 0.4)));
    check(`${name}: the start is slower`, early > 1.2 * later, `${early.toFixed(0)} vs ${later.toFixed(0)} ms`);
    await page.waitForTimeout(800);
    const [st] = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-stats")));
    check(`${name}: noted in the stats`, st.offDay === "slow", JSON.stringify(st.offDay));
    await context.close();
  });

  await test("off races switched off", async (name) => {
    const { context, page } = await open("", { ...BASE, wpmMin: 120, wpmMax: 120, offDays: false }, null, () => (window.__ntAutotyperOffDay = "off"));
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1);
    check(`${name}: normal speed`, Math.abs(r.wpm - 120) / 120 <= 0.1, `got ${r.wpm.toFixed(1)}`);
    await context.close();
  });

  await test("stats: today, wins, per hour, by day, export", async (name) => {
    const now = Date.now();
    const day = 86400000;
    const race = (at, place, money, xp, extra = {}) => ({ wpm: 100, accuracy: 97, target: 100, accTarget: 97, nitros: 1, chars: 160, ms: 20000, at, official: { wpm: 100, accuracy: 97, place, money, xp }, ...extra });
    // Today: three races a minute apart; yesterday two; five days ago one.
    const stats = [
      race(now - 5 * day, 4, 1000, 400),
      race(now - day - 120000, 2, 1100, 450),
      race(now - day - 60000, 1, 1200, 500, { offDay: "slow" }),
      race(now - 120000, 1, 1300, 600),
      race(now - 60000, 3, 1400, 700),
      race(now - 1000, 5, 1500, 800, { offDay: "off" }),
    ];
    const tenDaysAgo = new Date(now - 10 * day);
    const key = `${tenDaysAgo.getFullYear()}-${String(tenDaysAgo.getMonth() + 1).padStart(2, "0")}-${String(tenDaysAgo.getDate()).padStart(2, "0")}`;
    const { context, page } = await open("", { ...BASE }, { advanced: true, tab: "stats" });
    // Seed the stats, then reload so the script reads them.
    await page.evaluate(([st, k]) => {
      localStorage.setItem("nt-autotyper-stats", JSON.stringify(st));
      localStorage.setItem("nt-autotyper-days", JSON.stringify({ [k]: { races: 4, wpm: 360, acc: 380, money: 4000, xp: 1600, wins: 1 } }));
    }, [stats, key]);
    await page.reload();
    await page.waitForSelector(".go");
    await page.locator('nav button[data-tab="stats"]').click();
    await page.waitForTimeout(300);
    const today = await page.locator(".today").textContent();
    check(`${name}: today's line`, today.includes("3 races") && today.includes("+$4,200") && today.includes("+2,100 XP") && today.includes("1 win"), today);
    check(`${name}: wins and win rate`, (await page.locator(".s-wins").textContent()) === "2" && (await page.locator(".s-winrate").textContent()) === "33% of races");
    check(`${name}: top 3`, (await page.locator(".s-podium").textContent()) === "67%", await page.locator(".s-podium").textContent());
    // per hour: 3 stretches (20 s; 20 s + 60 s; 20 s + 60 s + 59 s) = 239 s for $7,500 = $112,971/h
    const rate = await page.locator(".s-rate").textContent();
    check(`${name}: money per hour of racing`, rate === "$113K", rate);
    check(`${name}: by day: 14 bars`, (await page.locator(".days-svg rect").count()) === 14);
    check(`${name}: today's bar stands out`, (await page.locator(".days-svg rect.now").count()) === 1 && !(await page.locator(".days-svg rect.now").getAttribute("class")).includes("zero"));
    check(`${name}: old day totals included`, (await page.locator(".days-svg rect:not(.zero)").count()) === 4, `${await page.locator(".days-svg rect:not(.zero)").count()} days with races`);
    await page.locator(".chart.days").scrollIntoViewIfNeeded();
    const box = await page.locator(".chart.days").boundingBox();
    await page.mouse.move(box.x + box.width - 8, box.y + 40);
    const tip = await page.locator(".chart.days .tip").textContent();
    check(`${name}: by-day tooltip`, tip.startsWith("Today: 3 races · 100 WPM · $4,200 · 2,100 XP"), tip);
    await page.locator('.day-metric [data-day="money"]').click();
    check(`${name}: switch to money`, (await page.locator('.day-metric [data-day="money"]').getAttribute("class")) === "on");
    await page.locator('.metric [data-metric="acc"]').click();
    check(`${name}: per-race chart shows accuracy`, (await page.locator(".chart-svg text").allTextContents()).some((t) => t === "avg 97%"));
    check(`${name}: off races marked on the chart`, (await page.locator(".chart-svg .c-off").count()) === 2);
    check(`${name}: money column`, (await page.locator(".history tr").first().locator("td").last().textContent()) === "$1,500");
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-stats.png") });
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".export-stats").click()]);
    const csv = readFileSync(await download.path(), "utf8").trim().split("\n");
    check(`${name}: CSV export`, download.suggestedFilename().startsWith("nitro-type-races-") && csv.length === 7 && csv[0].startsWith("date,time,wpm,accuracy,place,money,xp"), `${csv.length} lines: ${csv[0]}`);
    check(`${name}: CSV notes off races`, csv.filter((l) => l.endsWith(",off race") || l.endsWith(",slow start")).length === 2, csv.slice(1).join(" | "));
    await context.close();
  });

  await test("stats: old races go into day totals", async (name) => {
    const old = Date.now() - 3 * 86400000;
    const stats = Array.from({ length: 300 }, (_, i) => ({ wpm: 90, accuracy: 96, chars: 160, at: old + i * 1000, official: { wpm: 90, accuracy: 96, place: 2, money: 100, xp: 50 } }));
    const { context, page } = await open("", { ...BASE, wpmMin: 200, wpmMax: 200 });
    await page.evaluate((st) => localStorage.setItem("nt-autotyper-stats", JSON.stringify(st)), stats);
    await page.reload();
    await page.waitForSelector(".go");
    await page.locator(".go").click();
    await waitForResults(page, 1);
    await page.waitForTimeout(800);
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-stats")).length);
    const days = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-days")));
    const totals = Object.values(days ?? {});
    check(`${name}: keeps 300 races`, kept === 300, `${kept}`);
    check(`${name}: the oldest one is in its day's totals`, totals.length === 1 && totals[0].races === 1 && totals[0].money === 100, JSON.stringify(days));
    await context.close();
  });

  await test("mini status window", async (name) => {
    const { context, page } = await open("?countdown=800", { ...BASE, wpmMin: 120, wpmMax: 120, races: 1 }, { advanced: false }, () => {
      // A stand-in for Chrome's always-on-top window: an iframe on the page.
      const fake = {
        async requestWindow(opts) {
          window.__pipOpts = opts;
          const f = document.createElement("iframe");
          f.id = "fake-pip";
          f.style.cssText = "position:fixed;right:0;top:0;width:240px;height:40px;border:0;z-index:2147483647";
          document.body.appendChild(f);
          const w = f.contentWindow;
          w.close = () => {
            w.dispatchEvent(new Event("pagehide"));
            f.remove();
          };
          return w;
        },
      };
      // (the real one is read-only)
      Object.defineProperty(window, "documentPictureInPicture", { value: fake, configurable: true });
    });
    const pipText = () => page.frameLocator("#fake-pip").locator(".m span").textContent();
    const pipClass = () => page.evaluate(() => document.getElementById("fake-pip").contentDocument.body.className);
    await page.locator(".mini-btn").click();
    await page.waitForTimeout(300);
    const opts = await page.evaluate(() => window.__pipOpts);
    check(`${name}: opens small`, opts && opts.width <= 260 && opts.height <= 60, JSON.stringify(opts));
    check(`${name}: idle`, (await pipText()) === "Idle");
    await page.locator(".go").click();
    await page.waitForTimeout(400);
    check(`${name}: waiting for race`, (await pipText()) === "Waiting for race", await pipText());
    await page.waitForTimeout(2500);
    check(`${name}: racing`, (await pipText()) === "Racing" && (await pipClass()) === "typing", await pipText());
    check(`${name}: shows which account`, (await page.frameLocator("#fake-pip").locator(".m b").textContent()) === "racer_me");
    if (shotDir) await page.locator("#fake-pip").screenshot({ path: path.join(shotDir, "mini-racing.png") });
    await waitForResults(page, 1);
    await page.waitForTimeout(1500);
    check(`${name}: done`, (await pipText()) === "Done", await pipText());
    check(`${name}: remembered as open`, (await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-ui")).mini)) === true);
    // Reload: the window goes with the page; the next click brings it back.
    await page.reload();
    await page.waitForSelector(".go");
    check(`${name}: gone after a reload`, (await page.locator("#fake-pip").count()) === 0);
    await page.mouse.click(600, 300);
    await page.waitForTimeout(400);
    check(`${name}: back after the next click`, (await page.locator("#fake-pip").count()) === 1 && (await pipText()) === "Idle", await pipText().catch(() => "none"));
    // Closed by you: stays closed.
    await page.locator(".mini-btn").click();
    await page.waitForTimeout(200);
    check(`${name}: ⧉ closes it`, (await page.locator("#fake-pip").count()) === 0 && (await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-ui")).mini)) === false);
    await context.close();
  });

  await test("mini status window: logged out and break", async (name) => {
    const { context, page } = await open("?logout=after1&countdown=300", { ...BASE, wpmMin: 180, wpmMax: 180, races: 3 }, null, () => {
      // A stand-in for Chrome's always-on-top window: an iframe on the page.
      const fake = {
        async requestWindow(opts) {
          window.__pipOpts = opts;
          const f = document.createElement("iframe");
          f.id = "fake-pip";
          f.style.cssText = "position:fixed;right:0;top:0;width:240px;height:40px;border:0;z-index:2147483647";
          document.body.appendChild(f);
          const w = f.contentWindow;
          w.close = () => {
            w.dispatchEvent(new Event("pagehide"));
            f.remove();
          };
          return w;
        },
      };
      // (the real one is read-only)
      Object.defineProperty(window, "documentPictureInPicture", { value: fake, configurable: true });
    });
    await page.locator(".mini-btn").click();
    await page.locator(".go").click();
    // It ends up on the login page (the window closes with the old page); a click brings it back.
    const said = await waitForStatus(page, "Stopped: you're logged out", 60000);
    await page.mouse.click(600, 300);
    await page.waitForTimeout(500);
    check(`${name}: says Logged out, flashing red`, said.startsWith("Stopped") && (await page.frameLocator("#fake-pip").locator(".m span").textContent()) === "Logged out" && (await page.evaluate(() => document.getElementById("fake-pip").contentDocument.body.className)) === "paused");
    await context.close();
  });

  await test("desktop helper: reports name and status", async (name) => {
    const { context, page } = await open("?countdown=800", { ...BASE, wpmMin: 120, wpmMax: 120, races: 1, helper: true }, { advanced: true, tab: "panel" });
    const posts = [];
    // A stand-in for the helper app on 127.0.0.1.
    await context.route("http://127.0.0.1:47321/**", (route) => {
      posts.push(JSON.parse(route.request().postData() || "{}"));
      route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: '{"ok":true}' });
    });
    await page.waitForTimeout(2500);
    check(`${name}: says it's connected`, (await page.locator(".helper-state").textContent()) === "Helper: connected ✓", await page.locator(".helper-state").textContent());
    await page.locator(".go").click();
    await page.waitForTimeout(3500);
    const racing = posts.filter((p) => p.status === "Racing");
    check(`${name}: sends the account and its status`, racing.length > 0 && racing[0].name === "racer_me" && racing[0].tone === "typing" && /^[a-z0-9]{6,}$/.test(racing[0].id), JSON.stringify(posts.slice(-2)));
    await waitForResults(page, 1);
    await page.waitForTimeout(3000);
    check(`${name}: then Done`, posts[posts.length - 1].status === "Done", JSON.stringify(posts[posts.length - 1]));
    check(`${name}: the same id every time`, new Set(posts.map((p) => p.id)).size === 1);
    await context.close();
  });

  // The helper app itself (its server part; the window needs a screen).
  await test("desktop helper app", async (name) => {
    const { spawn } = await import("node:child_process");
    const helper = spawn("python3", [path.join(root, "helper/nt-status.pyw"), "--headless"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const post = (body, origin = "https://www.nitrotype.com") =>
        fetch("http://127.0.0.1:47321/status", { method: "POST", headers: { "Content-Type": "text/plain", Origin: origin }, body: JSON.stringify(body) });
      const ok = await post({ id: "a1", name: "account_one", status: "Racing", tone: "typing" });
      await post({ id: "b2", name: "account_two", status: "Taking a break", tone: "break" });
      const evil = await post({ id: "x", name: "x", status: "x" }, "https://example.com");
      const rows = await (await fetch("http://127.0.0.1:47321/statuses")).json();
      check(`${name}: takes reports from Nitro Type pages`, ok.status === 200 && rows.length === 2 && rows[0].name === "account_one" && rows[0].status === "Racing" && rows[1].status === "Taking a break", JSON.stringify(rows));
      check(`${name}: refuses other sites`, evil.status === 403);
      // Sounds: an alarm when an account needs you, a soft one when one finishes.
      const out = [];
      helper.stdout.on("data", (d) => out.push(String(d)));
      await new Promise((r) => setTimeout(r, 1500)); // the helper has seen account_two on a break
      await post({ id: "a1", name: "account_one", status: "Logged out", tone: "paused" });
      await post({ id: "b2", name: "account_two", status: "Done", tone: "done" });
      await new Promise((r) => setTimeout(r, 2500));
      const log = out.join("");
      check(`${name}: alarm when one needs you`, log.includes("sound: alert account_one"), log.slice(-300));
      check(`${name}: soft sound when one finishes`, log.includes("sound: soft account_two"), log.slice(-300));
      check(`${name}: alarm only once (repeats a minute later)`, log.split("sound: alert account_one").length === 2);
    } finally {
      helper.kill();
    }
  });

  await test("desktop helper: not running", async (name) => {
    const { context, page } = await open("", { ...BASE, helper: true }, { advanced: true, tab: "panel" });
    await context.route("http://127.0.0.1:47321/**", (route) => route.abort("connectionrefused"));
    await page.waitForTimeout(2500);
    check(`${name}: says so`, (await page.locator(".helper-state").textContent()).startsWith("Helper: not found"), await page.locator(".helper-state").textContent());
    await context.close();
  });

  // Two Chrome profiles (contexts) sharing one folder: one mini window shows both.
  await test("one mini window for all accounts (shared folder)", async (name) => {
    const disk = new Map(); // the folder on "this computer", shared by both profiles
    const fakeFolder = `(() => {
      const op = (...a) => window.__fsOp(...a);
      const file = (n) => ({
        kind: "file",
        name: n,
        async getFile() { const t = await op("read", n); return { text: async () => t }; },
        async createWritable() { let buf = ""; return { write: async (d) => { buf += d; }, close: async () => op("write", n, buf) }; },
      });
      const dir = {
        kind: "directory",
        name: "NT status",
        async queryPermission() { return "granted"; },
        async requestPermission() { return "granted"; },
        async getFileHandle(n) { return file(n); },
        async removeEntry(n) { await op("delete", n); },
        async *entries() { for (const n of await op("list")) yield [n, file(n)]; },
      };
      window.showDirectoryPicker = async () => dir;
      window.__ntAutotyperStaleMs = 5000;
      const fake = {
        async requestWindow(opts) {
          window.__pipOpts = opts;
          const f = document.createElement("iframe");
          f.id = "fake-pip";
          f.style.cssText = "position:fixed;right:0;top:0;width:240px;height:" + opts.height + "px;border:0;z-index:2147483647";
          document.body.appendChild(f);
          const w = f.contentWindow;
          w.close = () => { w.dispatchEvent(new Event("pagehide")); f.remove(); };
          return w;
        },
      };
      Object.defineProperty(window, "documentPictureInPicture", { value: fake, configurable: true });
    })()`;
    const fsOp = (_source, op, n, data) => {
      if (op === "write") disk.set(n, data);
      if (op === "delete") disk.delete(n);
      if (op === "read") return disk.get(n) ?? "";
      if (op === "list") return [...disk.keys()];
      return null;
    };
    const a = await open("?user=account_one&countdown=800", { ...BASE, wpmMin: 120, wpmMax: 120, races: 1 }, { advanced: true, tab: "panel" }, fakeFolder);
    await a.context.exposeBinding("__fsOp", fsOp);
    const b = await open("?user=account_two&countdown=800", { ...BASE }, { advanced: true, tab: "panel" }, fakeFolder);
    await b.context.exposeBinding("__fsOp", fsOp);
    try {
      await a.page.locator(".share-pick").click();
      await b.page.locator(".share-pick").click();
      await b.page.waitForTimeout(4500);
      const state = await b.page.locator(".share-state").textContent();
      check(`${name}: sharing, sees the other account`, state.startsWith('Sharing ✓ through the folder "NT status", with 1 other account'), state);
      await b.page.locator(".mini-btn").click();
      await b.page.waitForTimeout(600);
      const rows = () => b.page.evaluate(() => [...document.getElementById("fake-pip").contentDocument.querySelectorAll(".m")].map((m) => `${m.children[1].textContent}: ${m.children[2].textContent} (${m.className})`));
      check(`${name}: room for both`, (await b.page.evaluate(() => window.__pipOpts.height)) >= 60, JSON.stringify(await b.page.evaluate(() => window.__pipOpts)));
      check(`${name}: both accounts in one window`, JSON.stringify(await rows()) === JSON.stringify(["account_two: Idle (m idle)", "account_one: Idle (m idle)"]), JSON.stringify(await rows()));
      await a.page.locator(".go").click();
      await b.page.waitForTimeout(5000);
      check(`${name}: the other account's racing shows up`, (await rows())[1] === "account_one: Racing (m typing)", JSON.stringify(await rows()));
      if (shotDir) await b.page.locator("#fake-pip").screenshot({ path: path.join(shotDir, "mini-shared.png") });
      // Account one's browser closes: it stops updating.
      await a.context.close();
      await b.page.waitForTimeout(8000);
      check(`${name}: a closed one says Not running`, (await rows())[1] === "account_one: Not running (m gone)", JSON.stringify(await rows()));
      await b.page.locator(".share-stop").click();
      await b.page.waitForTimeout(500);
      check(`${name}: stop sharing`, (await rows()).length === 1 && (await b.page.locator(".share-state").textContent()) === "Not sharing.");
    } finally {
      await b.context.close();
      await a.context.close().catch(() => {});
    }
  });

  await test("sound blocked after a reload: the warning bar says so", async (name) => {
    const { context, page } = await open("", { ...BASE, notify: true, levelRace: "low" }, { advanced: false }, () => {
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor() {}
        close() {}
      };
      window.AudioContext = class {
        constructor() {
          this.state = "suspended";
          this.currentTime = 0;
          this.destination = {};
        }
        resume() {
          if (window.__activated) this.state = "running";
          return Promise.resolve();
        }
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x };
        }
        createOscillator() {
          return { frequency: {}, connect: (x) => x, start() {}, stop() {} };
        }
      };
    });
    await page.waitForTimeout(1500);
    const text = await page.locator(".nw-text").textContent();
    check(`${name}: shown right away, before any sound is needed`, (await page.locator(".note-warn").isVisible()) && text.startsWith("🔇 No sound right now"), text);
    await page.evaluate(() => (window.__activated = true));
    await page.mouse.click(700, 400);
    await page.waitForTimeout(1200);
    check(`${name}: a click on the page fixes it`, !(await page.locator(".note-warn").isVisible()));
    await context.close();
  });

  await test("mini status window: not in this browser", async (name) => {
    const { context, page } = await open("", { ...BASE }, null, () => delete Window.prototype.documentPictureInPicture && delete window.documentPictureInPicture);
    await page.locator(".mini-btn").click();
    await page.waitForTimeout(300);
    const toasts = await page.locator(".toast").allTextContents();
    check(`${name}: says what it needs`, toasts.some((t) => t.startsWith("Mini window not available")), toasts.join(" | "));
    await context.close();
  });

  await test("looks: themes and accent colours", async (name) => {
    const { context, page } = await open("", { ...BASE }, { advanced: true, tab: "panel" });
    const host = () => page.evaluate(() => {
      const h = [...document.querySelectorAll("body > div")].find((d) => d.shadowRoot?.querySelector(".box"));
      return { theme: h.dataset.theme, accent: h.dataset.accent };
    });
    const bg = () => page.locator(".box").evaluate((el) => getComputedStyle(el).backgroundColor);
    check(`${name}: dark by default`, (await host()).theme === "dark" && (await bg()) === "rgb(20, 27, 51)", await bg());
    await page.locator('[data-theme-pick="light"]').click();
    check(`${name}: light theme`, (await host()).theme === "light" && (await bg()) === "rgb(255, 255, 255)", await bg());
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-light.png") });
    await page.locator('[data-accent-pick="mint"]').click();
    const go = await page.locator(".go").evaluate((el) => getComputedStyle(el).backgroundColor);
    check(`${name}: accent colour on the Start button`, go === "rgb(52, 211, 153)", go);
    await page.locator('[data-theme-pick="midnight"]').click();
    check(`${name}: midnight theme`, (await bg()) === "rgb(12, 14, 21)", await bg());
    await page.reload();
    await page.waitForSelector(".go");
    check(`${name}: remembered after a reload`, JSON.stringify(await host()) === JSON.stringify({ theme: "midnight", accent: "mint" }), JSON.stringify(await host()));
    await page.locator(".reset-panel").click();
    check(`${name}: reset position keeps the colours`, (await host()).accent === "mint");
    await page.locator('[data-theme-pick="auto"]').click();
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(100);
    check(`${name}: auto follows the system (light)`, (await host()).theme === "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(100);
    check(`${name}: auto follows the system (dark)`, (await host()).theme === "dark");
    await context.close();
  });

  await test("captcha: pauses, carries on once solved, never touches it", async (name) => {
    const { context, page } = await open("?captcha=1&countdown=500", { ...BASE, wpmMin: 150, wpmMax: 150, races: 3, notify: true }, null, () => {
      window.__notes = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          (window.__noteOpts ||= []).push({ title, ...opts });
        }
      };
    });
    await page.evaluate(() => {
      // Count alarm beeps instead of making noise.
      window.__beeps = 0;
      window.AudioContext = class {
        constructor() {
          this.currentTime = 0;
          this.destination = {};
        }
        resume() {}
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x };
        }
        createOscillator() {
          return { frequency: {}, connect: (x) => x, start: () => window.__beeps++, stop() {} };
        }
      };
      document.title = "Nitro Type";
    });
    await page.waitForTimeout(1200);
    check(`${name}: the always-on reCAPTCHA badge isn't a captcha`, (await page.locator(".go").textContent()) === "Start" && !(await status(page)).includes("Captcha"));
    await page.locator(".go").click();
    await page.waitForFunction(() => document.querySelector(".captcha-modal"), null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    const typed = () => page.evaluate(() => document.querySelectorAll(".is-typed").length);
    const t1 = await typed();
    await page.waitForTimeout(1500);
    check(`${name}: typing stops`, (await typed()) === t1, `${t1} letters`);
    check(
      `${name}: session paused (not stopped) with a message`,
      (await status(page)) === "Paused: solve the captcha and I'll carry on by myself" && (await page.locator(".go").textContent()) === "Stop",
      `${await status(page)} / ${await page.locator(".go").textContent()}`,
    );
    check(`${name}: badge says Captcha`, (await page.locator(".badge").textContent()) === "Captcha");
    const notes = await page.evaluate(() => window.__notes);
    check(`${name}: notification (even with the tab in view)`, notes.length === 1 && notes[0].startsWith("⚠ CAPTCHA: session paused · racer_me: "), JSON.stringify(notes));
    check(`${name}: never clicks the captcha`, (await page.evaluate(() => window.__captchaClicks)) === 0);
    const opts = (await page.evaluate(() => window.__noteOpts))[0];
    check(`${name}: urgent: stays on screen and re-alerts`, opts.requireInteraction === true && opts.renotify === true && !opts.silent, JSON.stringify(opts));
    check(`${name}: alarm beeps`, (await page.evaluate(() => window.__beeps)) >= 3);
    check(`${name}: panel turns red`, (await page.locator(".box.alarm").count()) === 1);
    const titles = new Set();
    for (let i = 0; i < 4; i++) {
      titles.add((await page.title()).split(" · ")[0]);
      await page.waitForTimeout(500);
    }
    check(`${name}: tab title flashes`, titles.has("⚠ CAPTCHA") && titles.has("■ Captcha"), [...titles].join(" / "));
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "captcha-alarm.png") });
    // Still there a while later: stays paused.
    await page.waitForTimeout(4000);
    check(`${name}: stays paused while the captcha is there`, (await typed()) === t1 && (await status(page)).startsWith("Paused"), await status(page));
    // You solve the captcha. Nothing to press: it carries on by itself.
    await page.evaluate(() => window.__solveCaptcha());
    const solvedToast = await page
      .waitForFunction(() => [...document.querySelectorAll("body > div")].some((d) => d.shadowRoot?.querySelector(".toast")?.textContent.startsWith("Captcha solved")), null, { timeout: 10000 })
      .then(() => true, () => false);
    check(`${name}: says it's carrying on`, solvedToast);
    const toasts = await page.locator(".toast").allTextContents();
    check(`${name}: the captcha pop-up goes away`, !toasts.some((t) => t.startsWith("⚠ CAPTCHA")), toasts.join(" | "));
    const results = await waitForResults(page, 2, 60000);
    check(`${name}: finishes that race, then the next, by itself`, results.length >= 2, `${results.length} races`);
    check(`${name}: alarm over`, (await page.locator(".box.alarm").count()) === 0 && !(await page.title()).includes("CAPTCHA"), await page.title());
    check(`${name}: never clicked the captcha`, (await page.evaluate(() => window.__captchaClicks)) === 0);
    await context.close();
  });

  await test("captcha: Stop while paused", async (name) => {
    const { context, page } = await open("?captcha=1&countdown=500", { ...BASE, wpmMin: 150, wpmMax: 150, races: 3 });
    await page.locator(".go").click();
    await page.waitForFunction(() => document.querySelector(".captcha-modal"), null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.locator(".go").click();
    await page.waitForTimeout(500);
    check(`${name}: stopped, alarm off`, (await page.locator(".go").textContent()) === "Start" && (await page.locator(".box.alarm").count()) === 0, await status(page));
    await page.evaluate(() => window.__solveCaptcha());
    await page.waitForTimeout(4000);
    check(`${name}: doesn't carry on after a Stop`, (await page.evaluate(() => window.__results.length)) === 0 && (await page.locator(".go").textContent()) === "Start");
    await context.close();
  });

  // Each type at the level you pick: off, low (chime), normal (pop-up),
  // high (chime + pop-up), urgent (alarm + pop-up that stays).
  await test("notification levels", async (name) => {
    const settings = {
      ...BASE, wpmMin: 200, wpmMax: 200, races: 1, notify: true, notifyAlways: true,
      levelRace: "low", levelLevel: "normal", levelSeason: "off", levelMilestone: "high", levelSession: "urgent",
    };
    const { context, page } = await open("?levelup=1&season=1&countdown=300", settings, null, () => {
      window.__notes = [];
      window.__noteOpts = [];
      window.__sounds = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          window.__noteOpts.push({ title, ...opts });
          window.__sounds.push(`pop:${title}`);
        }
        close() {}
      };
      // Record chimes (sine) and alarm beeps (square) in order with the pop-ups.
      window.AudioContext = class {
        constructor() {
          this.currentTime = 0;
          this.destination = {};
        }
        resume() {}
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x };
        }
        createOscillator() {
          const osc = { frequency: {}, connect: (x) => x, stop() {} };
          osc.start = () => window.__sounds.push(osc.type === "sine" ? "chime" : "beep");
          return osc;
        }
      };
      if (!localStorage.getItem("nt-autotyper-stats")) {
        const old = Array.from({ length: 5 }, (_, i) => ({ wpm: 60, accuracy: 95, at: Date.now() - 86400000 + i, target: 60 }));
        localStorage.setItem("nt-autotyper-stats", JSON.stringify(old));
      }
    });
    await page.locator(".go").click();
    await waitForResults(page, 1);
    await page.waitForTimeout(8000);
    const notes = await page.evaluate(() => window.__notes);
    const opts = await page.evaluate(() => window.__noteOpts);
    const sounds = (await page.evaluate(() => window.__sounds)).join(" ");
    const byTitle = (t) => opts.find((o) => o.title === t);
    check(`${name}: race at Low: a chime, no pop-up`, !byTitle("Race finished · racer_me") && sounds.startsWith("chime chime"), sounds);
    check(`${name}: level up at Normal: a pop-up, no sound`, Boolean(byTitle("Level up! · racer_me")) && /chime chime pop:Level up!/.test(sounds) && !/(chime|beep) pop:Level up!/.test(sounds.replace(/^chime chime /, "")), sounds);
    check(`${name}: season pass at Off: nothing`, !notes.some((n) => n.startsWith("Season pass")));
    check(`${name}: milestone at High: chime + pop-up`, /chime chime pop:★ Milestone/.test(sounds) && !byTitle("★ Milestone · racer_me").requireInteraction, sounds);
    const session = byTitle("NT Autotyper session · racer_me");
    check(`${name}: session done at Urgent: alarm + pop-up that stays`, /beep beep beep pop:NT Autotyper session/.test(sounds) && session?.requireInteraction === true && session?.renotify === true, JSON.stringify(session));
    await context.close();
  });

  await test("notification levels: panel", async (name) => {
    const { context, page } = await open("", { ...BASE, notify: true, notifyRace: false }, null, () => {
      window.__notes = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          setTimeout(() => this.onshow?.(), 30);
        }
        close() {}
      };
    });
    await page.locator('nav button[data-tab="panel"]').click();
    const value = (k) => page.locator(`select[data-k="${k}"]`).inputValue();
    check(
      `${name}: defaults (old "after each race" switch off stays off)`,
      (await value("levelCaptcha")) === "urgent" && (await value("levelSession")) === "high" && (await value("levelMilestone")) === "high" &&
        (await value("levelLevel")) === "normal" && (await value("levelSeason")) === "normal" && (await value("levelRace")) === "off",
    );
    await page.locator('select[data-k="levelLevel"]').selectOption("high");
    await page.locator('.try[data-try="level"]').click();
    await page.waitForTimeout(400);
    check(`${name}: ▶ tries the chosen level`, (await page.locator(".notify-status").textContent()) === "Level up! at high: a chime and a pop-up.", await page.locator(".notify-status").textContent());
    check(`${name}: and sends the pop-up`, (await page.evaluate(() => window.__notes)).includes("Level up!: Test: this is the high level."));
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-levels.png") });
    await page.reload();
    await page.waitForSelector(".go", { state: "attached" });
    await page.locator('nav button[data-tab="panel"]').click();
    check(`${name}: choice remembered`, (await value("levelLevel")) === "high");
    await context.close();
  });

  await test("notifications every time, even when you're looking", async (name) => {
    const { context, page } = await open("?countdown=300", { ...BASE, wpmMin: 200, wpmMax: 200, races: 2, notify: true, levelRace: "normal" }, null, () => {
      window.__notes = [];
      window.__noteOpts = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          window.__noteOpts.push({ title, ...opts });
          setTimeout(() => this.onshow?.(), 30);
        }
        close() {}
      };
    });
    await page.locator(".go").click();
    await waitForResults(page, 2, 90000);
    await page.waitForTimeout(3000);
    const opts = (await page.evaluate(() => window.__noteOpts)).filter((o) => o.title === "Race finished · racer_me");
    check(`${name}: a pop-up for each race, with the tab in view`, opts.length === 2, JSON.stringify(opts.map((o) => o.body)));
    check(`${name}: your username in the title`, opts.length === 2 && opts.every((o) => o.title === "Race finished · racer_me"), JSON.stringify(opts.map((o) => o.title)));
    check(`${name}: a fresh tag each time (so none is silently replaced)`, opts.length === 2 && opts[0].tag !== opts[1].tag, JSON.stringify(opts.map((o) => o.tag)));
    const toasts = await page.locator(".toast").allTextContents();
    check(`${name}: also a pop-up on the page itself`, toasts.some((t) => t.startsWith("Race finished")), toasts.join(" | "));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "toasts.png"), clip: { x: 800, y: 0, width: 400, height: 260 } });
    await context.close();
  });

  await test("page pop-ups: normal goes away, urgent stays", async (name) => {
    const { context, page } = await open("", { ...BASE, notify: true, levelLevel: "normal" }, null, () => {
      window.__notes = [];
      window.__noteOpts = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          window.__noteOpts.push({ title, ...opts });
          setTimeout(() => this.onshow?.(), 30);
        }
        close() {}
      };
    });
    await page.locator('nav button[data-tab="panel"]').click();
    await page.locator('.try[data-try="level"]').click();
    await page.locator(".test-alarm").click();
    await page.waitForTimeout(500);
    check(`${name}: both shown`, (await page.locator(".toast.normal").count()) === 1 && (await page.locator(".toast.urgent").count()) === 1);
    await page.waitForTimeout(9000);
    check(`${name}: normal gone after a few seconds, urgent still there`, (await page.locator(".toast.normal").count()) === 0 && (await page.locator(".toast.urgent").count()) === 1);
    await page.locator(".toast.urgent button").click();
    check(`${name}: urgent closes with ✕`, (await page.locator(".toast.urgent").count()) === 0);
    await context.close();
  });

  await test("sound blocked after a reload: says so, a click fixes it", async (name) => {
    const { context, page } = await open("", { ...BASE, notify: true, levelRace: "low" }, null, () => {
      // Like a browser before any click on the page: audio stays suspended.
      window.__chimes = 0;
      window.AudioContext = class {
        constructor() {
          this.state = "suspended";
          this.currentTime = 0;
          this.destination = {};
        }
        resume() {
          if (window.__activated) this.state = "running";
          return Promise.resolve();
        }
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x };
        }
        createOscillator() {
          return { frequency: {}, connect: (x) => x, start: () => window.__chimes++, stop() {} };
        }
      };
    });
    await page.locator('nav button[data-tab="panel"]').click();
    // Pressed without the browser allowing sound yet:
    await page.evaluate(() => {
      const shadow = [...document.querySelectorAll("body > div")].find((d) => d.shadowRoot?.querySelector(".box")).shadowRoot;
      shadow.querySelector('.try[data-try="race"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(1200);
    check(`${name}: no sound yet`, (await page.evaluate(() => window.__chimes)) === 0);
    const toasts = await page.locator(".toast").allTextContents();
    check(`${name}: a pop-up says to click once`, toasts.some((t) => t.startsWith("Sound is off for now")), toasts.join(" | "));
    check(`${name}: the panel says so too`, (await page.locator(".sound-state").textContent()).startsWith("Sound: blocked"), await page.locator(".sound-state").textContent());
    // A real click on the page:
    await page.evaluate(() => (window.__activated = true));
    await page.mouse.click(700, 400);
    await page.locator('.try[data-try="race"]').click();
    await page.waitForTimeout(800);
    check(`${name}: after a click, the chime plays`, (await page.evaluate(() => window.__chimes)) === 2);
    check(`${name}: and the panel says sound is on`, (await page.locator(".sound-state").textContent()) === "Sound: on.", await page.locator(".sound-state").textContent());
    await context.close();
  });

  for (const [perm, expect, fix] of [
    ["default", "Desktop pop-ups are off: Chrome reset", true],
    ["denied", "Desktop pop-ups are blocked", false],
  ]) {
    await test(`pop-ups not getting through: permission ${perm}`, async (name) => {
      const { context, page } = await open("", { ...BASE, notify: true, levelSession: "high" }, { advanced: false }, `(() => {
        window.__asked = 0;
        window.Notification = class {
          static permission = ${JSON.stringify(perm)};
          static requestPermission = async () => { window.__asked++; window.Notification.permission = "granted"; return "granted"; };
          constructor() {}
        };
      })()`);
      await page.waitForTimeout(500);
      const text = await page.locator(".nw-text").textContent();
      check(`${name}: a warning bar in the panel (simple mode too)`, (await page.locator(".note-warn").isVisible()) && text.startsWith(expect), text);
      check(`${name}: ${fix ? "an Allow button" : "steps to unblock (no button)"}`, (await page.locator(".nw-fix").isVisible()) === fix);
      if (fix) {
        await page.locator(".nw-fix").click();
        await page.waitForTimeout(300);
        check(`${name}: Allow asks Chrome, then the bar goes`, (await page.evaluate(() => window.__asked)) === 1 && !(await page.locator(".note-warn").isVisible()));
      } else {
        await page.locator(".nw-x").click();
        check(`${name}: can be hidden`, !(await page.locator(".note-warn").isVisible()));
      }
      await context.close();
    });
  }

  await test("pop-ups not getting through: Chrome reports an error", async (name) => {
    const { context, page } = await open("", { ...BASE, notify: true, levelLevel: "normal" }, { advanced: true, tab: "panel" }, () => {
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor() {
          setTimeout(() => this.onerror?.(new Event("error")), 30);
        }
        close() {}
      };
    });
    check(`${name}: no bar while all is well`, !(await page.locator(".note-warn").isVisible()));
    await page.locator('.try[data-try="level"]').click();
    await page.waitForTimeout(600);
    const text = await page.locator(".nw-text").textContent();
    check(`${name}: warning bar`, (await page.locator(".note-warn").isVisible()) && text.startsWith("Chrome couldn't show the last pop-up"), text);
    const toasts = await page.locator(".toast").allTextContents();
    check(`${name}: and an on-page pop-up`, toasts.some((t) => t.startsWith("Desktop pop-ups aren't getting through")), toasts.join(" | "));
    check(`${name}: last pop-up line`, (await page.locator(".notify-last").textContent()).includes("error"), await page.locator(".notify-last").textContent());
    await context.close();
  });

  await test("pop-ups getting through: no warning, last pop-up noted", async (name) => {
    const { context, page } = await open("", { ...BASE, notify: true, levelLevel: "normal" }, { advanced: true, tab: "panel" }, () => {
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor() {
          setTimeout(() => this.onshow?.(), 30);
        }
        close() {}
      };
    });
    await page.locator('.try[data-try="level"]').click();
    await page.waitForTimeout(600);
    check(`${name}: no warning bar`, !(await page.locator(".note-warn").isVisible()));
    check(`${name}: says Chrome showed it`, (await page.locator(".notify-last").textContent()).includes("Chrome says it showed it"), await page.locator(".notify-last").textContent());
    await context.close();
  });

  await test("captcha alert test button", async (name) => {
    const { context, page } = await open("", { ...BASE, notify: true }, null, () => {
      window.__notes = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
        }
        close() {}
      };
    });
    await page.locator('nav button[data-tab="panel"]').click();
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-notify-priorities.png") });
    await page.locator(".test-alarm").click();
    await page.waitForTimeout(300);
    const notes = await page.evaluate(() => window.__notes);
    check(`${name}: sends the urgent test alert`, notes.length === 1 && notes[0] === "⚠ CAPTCHA: session paused · racer_me: TEST: this is what a captcha alert looks like.", JSON.stringify(notes));
    check(`${name}: panel turns red`, (await page.locator(".box.alarm").count()) === 1);
    await page.waitForTimeout(6500);
    check(`${name}: stops by itself`, (await page.locator(".box.alarm").count()) === 0);
    await context.close();
  });

  await test("notifications: race, level, season, milestone, session", async (name) => {
    const { context, page } = await open(
      "?levelup=1&season=1&countdown=500",
      { ...BASE, wpmMin: 150, wpmMax: 150, accuracy: 97, races: 2, notify: true, levelRace: "normal" },
      null,
      () => {
        // A background tab, with five earlier races at 60 WPM (so 150 is a personal best).
        Object.defineProperty(document, "hidden", { get: () => true });
        Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
        window.__notes = [];
        window.Notification = class {
          static permission = "granted";
          static requestPermission = async () => "granted";
          constructor(title, opts) {
            window.__notes.push(`${title}: ${opts?.body}`);
          (window.__noteOpts ||= []).push({ title, ...opts });
          }
        };
        if (!localStorage.getItem("nt-autotyper-stats")) {
          const old = Array.from({ length: 5 }, (_, i) => ({ wpm: 60, accuracy: 95, at: Date.now() - 86400000 + i, target: 60 }));
          localStorage.setItem("nt-autotyper-stats", JSON.stringify(old));
        }
      },
    );
    await page.locator(".go").click();
    const rs = await waitForResults(page, 2, 60000);
    await page.waitForTimeout(5000);
    const notes = await page.evaluate(() => window.__notes);
    const raceNotes = notes.filter((n) => n.startsWith("Race finished · racer_me: "));
    const want = rs[0].shown;
    const suffix = ["st", "nd", "rd"][want.place - 1] ?? "th";
    check(
      `${name}: race note with place, WPM, accuracy, money, XP`,
      raceNotes.length === 2 && raceNotes[0] === `Race finished · racer_me: ${want.place}${suffix} · ${want.wpm} WPM · ${want.accuracy.toFixed(1)}% · +$${want.money.toLocaleString()} · +${want.xp} XP`,
      JSON.stringify(raceNotes),
    );
    check(`${name}: level up`, notes.includes(`Level up! · racer_me: You reached level ${rs[0].shown_level}!`) && notes.includes(`Level up! · racer_me: You reached level ${rs[1].shown_level}!`), JSON.stringify(notes));
    check(`${name}: season pass`, notes.includes(`Season pass · racer_me: Season pass tier ${rs[0].shown_season} unlocked`), JSON.stringify(notes));
    check(`${name}: personal best`, notes.some((n) => /^★ Milestone · racer_me: New personal best: \d+ WPM!$/.test(n)), JSON.stringify(notes));
    const summary = notes[notes.length - 1];
    const money = rs.reduce((a, r) => a + r.shown.money, 0);
    check(`${name}: session summary last, with totals`, summary.startsWith("NT Autotyper session · racer_me: 2 races · avg ") && summary.includes(`+$${money.toLocaleString()}`) && summary.includes("XP"), summary);
    await context.close();
  });

  await test("stop when the screen locks", async (name) => {
    const { context, page } = await open("?countdown=500", { ...BASE, wpmMin: 60, wpmMax: 60, races: 3 }, null, () => {
      // Chrome's Idle Detection, stubbed: the test locks the "screen".
      window.IdleDetector = class extends EventTarget {
        static requestPermission = async () => "granted";
        constructor() {
          super();
          this.screenState = "unlocked";
          this.userState = "active";
          window.__idle = this;
        }
        async start() {}
      };
    });
    await page.locator('nav button[data-tab="panel"]').click();
    await page.locator('input[data-k="stopOnLock"]').check();
    await page.waitForTimeout(300);
    check(`${name}: switch stays on (permission granted)`, await page.locator('input[data-k="stopOnLock"]').isChecked());
    await page.locator(".go").click();
    await page.waitForTimeout(1500);
    check(`${name}: typing`, (await page.locator(".go").textContent()) === "Stop");
    await page.evaluate(() => {
      window.__idle.screenState = "locked";
      window.__idle.dispatchEvent(new Event("change"));
    });
    await page.waitForTimeout(500);
    check(`${name}: screen lock stops the session`, (await status(page)) === "Stopped: your screen locked" && (await page.locator(".go").textContent()) === "Start", await status(page));
    await context.close();
  });

  await test("restored tab after shutdown: doesn't resume", async (name) => {
    const { context, page } = await open("?countdown=300", { ...BASE, races: 5 }, null, () => {
      // Chrome restored the tab: the session was on, last heartbeat 2 min ago.
      if (!sessionStorage.getItem("restored")) {
        sessionStorage.setItem("restored", "1");
        sessionStorage.setItem("nt-autotyper-session", JSON.stringify({ active: true, total: 5, done: 2, beat: Date.now() - 120000 }));
      }
    });
    await page.waitForTimeout(2500);
    check(`${name}: session not resumed`, (await page.locator(".go").textContent()) === "Start" && (await page.evaluate(() => document.querySelectorAll(".is-typed").length)) === 0);
    check(`${name}: says why`, (await status(page)).startsWith("Stopped: the browser was closed or the computer was off"), await status(page));
    await context.close();
  });

  await test("computer asleep mid-race: stops", async (name) => {
    const { context, page } = await open("?countdown=300", { ...BASE, wpmMin: 60, wpmMax: 60, races: 3 });
    await page.locator(".go").click();
    await page.waitForTimeout(2000);
    // The lid closes for a minute: the clock jumps when it wakes up.
    await page.evaluate(() => {
      const real = Date.now;
      Date.now = () => real() + 60000;
    });
    await page.waitForTimeout(1500);
    const typed = () => page.evaluate(() => document.querySelectorAll(".is-typed").length);
    const t1 = await typed();
    await page.waitForTimeout(1000);
    check(`${name}: stops typing`, (await typed()) === t1);
    check(`${name}: session stopped with a message`, (await status(page)) === "Stopped: your computer was asleep" && (await page.locator(".go").textContent()) === "Start", await status(page));
    await context.close();
  });

  await test("disqualified once: notifies and moves on", async (name) => {
    const { context, page } = await open("?dq=1&countdown=300", { ...BASE, wpmMin: 150, wpmMax: 150, races: 1, notify: true, notifyAlways: true }, null, () => {
      window.__notes = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          (window.__noteOpts ||= []).push({ title, ...opts });
        }
      };
    });
    await page.locator(".go").click();
    await page.waitForFunction(() => document.getElementById("dq"), null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    check(`${name}: says so`, (await status(page)) === "Disqualified. Next race soon…", await status(page));
    const notes = await page.evaluate(() => window.__notes);
    check(`${name}: notification`, notes.includes("Disqualified · racer_me: Disqualified for inactivity. Going on to the next race."), JSON.stringify(notes));
    const [r] = await waitForResults(page, 1, 60000);
    check(`${name}: pressed Race Again (not the garage) and raced`, r.correct > 100 && (await page.evaluate(() => window.__garageClicks)) === 0);
    await page.waitForTimeout(1500);
    check(`${name}: the disqualified race didn't count`, (await status(page)) === "Done: 1 race", await status(page));
    await context.close();
  });

  await test("currently in a race mid-session: waits, notifies, carries on", async (name) => {
    const { context, page } = await open("?inrace=next&countdown=300", { ...BASE, wpmMin: 180, wpmMax: 180, races: 2, notify: true }, null, () => {
      window.__notes = [];
      window.__garageClicks = 0;
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
        }
      };
    });
    await page.locator(".go").click();
    await page.waitForFunction(() => document.getElementById("inrace"), null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    const said = await status(page);
    check(`${name}: says what's going on (not a failure)`, said.startsWith("Currently in a race: Nitro Type still has you in your last race. Pressing Try Again in"), said);
    check(`${name}: session still on`, (await page.locator(".go").textContent()) === "Stop");
    let notes = await page.evaluate(() => window.__notes);
    check(`${name}: notification`, notes.some((n) => n.startsWith("Currently in a race · racer_me: Nitro Type still has you in your last race.")), JSON.stringify(notes));
    // Waits it out, presses Try Again, then Race Again on the disqualified popup.
    const [, r] = await waitForResults(page, 2, 90000);
    check(`${name}: pressed Try Again once`, (await page.evaluate(() => window.__tryAgainClicks)) === 1);
    check(`${name}: then raced again`, r.correct > 100 && (await page.evaluate(() => window.__garageClicks)) === 0);
    notes = await page.evaluate(() => window.__notes);
    check(`${name}: disqualified from the old race: its own notification`, notes.some((n) => n.startsWith("Disqualified · racer_me: From the race you were still in")), JSON.stringify(notes));
    check(`${name}: never 'failed' or stopped`, !notes.some((n) => /didn't start|Stopped|twice/.test(n)), JSON.stringify(notes));
    check(`${name}: one 'currently in a race' notification`, notes.filter((n) => n.startsWith("Currently in a race")).length === 1);
    await page.waitForTimeout(1500);
    check(`${name}: finishes the session`, (await status(page)) === "Done: 2 races", await status(page));
    await context.close();
  });

  await test("disqualified twice in a row: stops", async (name) => {
    const { context, page } = await open("?dq=all&countdown=300", { ...BASE, wpmMin: 150, wpmMax: 150, races: 5, notify: true, notifyAlways: true }, null, () => {
      window.__notes = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          (window.__noteOpts ||= []).push({ title, ...opts });
        }
      };
    });
    await page.locator(".go").click();
    await page.waitForFunction(() => window.__notes.some((n) => n.includes("twice in a row")), null, { timeout: 60000 });
    check(`${name}: session stopped`, (await status(page)) === "Stopped: disqualified twice in a row" && (await page.locator(".go").textContent()) === "Start", await status(page));
    check(`${name}: never went to the garage`, (await page.evaluate(() => window.__garageClicks)) === 0);
    await context.close();
  });

  await test("logged out: reloads once to reconnect, then stops", async (name) => {
    const { context, page } = await open("?loggedout=1&countdown=300", { ...BASE, races: 3 });
    await page.locator(".go").click();
    await page.waitForTimeout(1500);
    check(`${name}: tries a fresh page first`, (await status(page)).startsWith("Nitro Type shows you as logged out. Reloading the race page"), await status(page));
    const stopped = await page
      .waitForFunction(() => {
        const host = [...document.querySelectorAll("body > div")].find((d) => d.shadowRoot?.querySelector(".box"));
        return host?.shadowRoot.querySelector(".status")?.textContent.startsWith("Stopped: you're logged out");
      }, null, { timeout: 30000 })
      .then(() => true, () => false);
    check(`${name}: still logged out after the reload: stops`, stopped && (await status(page)) === "Stopped: you're logged out of Nitro Type. Log back in, then press Start.", await status(page));
    check(`${name}: with the urgent alarm (red panel)`, (await page.locator(".box.alarm").count()) === 1);
    check(`${name}: reloaded once`, (await page.evaluate(() => window.__loads)) === 2);
    check(`${name}: nothing typed`, (await page.evaluate(() => document.querySelectorAll(".is-typed").length)) === 0);
    await context.close();
  });

  // Waits for a status line on whatever page the tab ends up on.
  async function waitForStatus(page, start, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const s = await status(page).catch(() => "");
      if (s.startsWith(start)) return s;
      await page.waitForTimeout(500);
    }
    return status(page).catch(() => "");
  }

  await test("logged out (sent to the login page): urgent alarm", async (name) => {
    const { context, page } = await open("?logout=after1&countdown=300", { ...BASE, wpmMin: 180, wpmMax: 180, races: 3, notify: true }, null, () => {
      window.__notes = [];
      window.__noteOpts = [];
      window.__beeps = 0;
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          window.__noteOpts.push({ title, ...opts });
          setTimeout(() => this.onshow?.(), 30);
        }
        close() {}
      };
      window.AudioContext = class {
        constructor() {
          this.currentTime = 0;
          this.destination = {};
        }
        resume() {}
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x };
        }
        createOscillator() {
          return { frequency: {}, connect: (x) => x, start: () => window.__beeps++, stop() {} };
        }
      };
    });
    await page.evaluate(() => (document.title = "Nitro Type"));
    await page.locator(".go").click();
    const said = await waitForStatus(page, "Stopped: you're logged out", 60000);
    check(`${name}: noticed on the login page, tried the race page again, then stopped`, said === "Stopped: you're logged out of Nitro Type. Log back in, then press Start.", said);
    check(`${name}: ended up on the login page`, new URL(page.url()).pathname === "/login", page.url());
    await page.waitForTimeout(1000);
    const opts = await page.evaluate(() => window.__noteOpts);
    const alert = opts.find((o) => o.title === "⚠ LOGGED OUT · racer_me");
    check(`${name}: urgent notification (stays on screen, re-alerts)`, alert && alert.requireInteraction === true && alert.renotify === true, JSON.stringify(opts));
    check(`${name}: alarm beeps`, (await page.evaluate(() => window.__beeps)) >= 3);
    check(`${name}: red panel, badge says Logged out`, (await page.locator(".box.alarm").count()) === 1 && (await page.locator(".badge").textContent()) === "Logged out");
    const titles = new Set();
    for (let i = 0; i < 4; i++) {
      titles.add((await page.title()).split(" · ")[0]);
      await page.waitForTimeout(500);
    }
    check(`${name}: tab title flashes`, titles.has("⚠ LOGGED OUT") && titles.has("■ Logged out"), [...titles].join(" / "));
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "logged-out-alarm.png") });
    await context.close();
  });

  await test("logged out alert test button", async (name) => {
    const { context, page } = await open("", { ...BASE, notify: true }, { advanced: true, tab: "panel" }, () => {
      window.__notes = [];
      window.__noteOpts = [];
      window.__beeps = 0;
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
          window.__noteOpts.push({ title, ...opts });
          setTimeout(() => this.onshow?.(), 30);
        }
        close() {}
      };
      window.AudioContext = class {
        constructor() {
          this.currentTime = 0;
          this.destination = {};
        }
        resume() {}
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x };
        }
        createOscillator() {
          return { frequency: {}, connect: (x) => x, start: () => window.__beeps++, stop() {} };
        }
      };
    });
    check(`${name}: its own row, Urgent by default`, (await page.locator('select[data-k="levelLoggedOut"]').inputValue()) === "urgent");
    await page.locator('.try[data-try="loggedOut"]').click();
    await page.waitForTimeout(400);
    const notes = await page.evaluate(() => window.__notes);
    check(`${name}: urgent test alert`, notes.length === 1 && notes[0] === "⚠ LOGGED OUT · racer_me: TEST: this is what the logged-out alert looks like.", JSON.stringify(notes));
    check(`${name}: panel turns red`, (await page.locator(".box.alarm").count()) === 1);
    await page.waitForTimeout(6500);
    check(`${name}: stops by itself`, (await page.locator(".box.alarm").count()) === 0);
    await context.close();
  });

  await test("stuck somewhere with no race: back to the race page", async (name) => {
    const { context, page } = await open("?strand=after1&countdown=300", { ...BASE, wpmMin: 180, wpmMax: 180, races: 2, notify: true }, null, () => (window.__ntAutotyperStallMs = 6000));
    await page.locator(".go").click();
    const said = await waitForStatus(page, "No race for 5 minutes", 40000);
    check(`${name}: notices nothing's happening`, said.startsWith("No race for 5 minutes. Loading the race page again"), said);
    const done = await waitForStatus(page, "Done", 60000);
    check(`${name}: back on the race page, session finished`, done === "Done: 2 races" && new URL(page.url()).pathname === "/race", `${done} @ ${page.url()}`);
    await context.close();
  });

  await test("disconnected between races: reconnects and carries on", async (name) => {
    const { context, page } = await open("?idlekick=once&countdown=300", { ...BASE, wpmMin: 180, wpmMax: 180, races: 2, notify: true }, null, () => {
      window.__notes = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          window.__notes.push(`${title}: ${opts?.body}`);
        }
      };
    });
    await page.locator(".go").click();
    await page.waitForFunction(() => window.__kicked, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    check(`${name}: says it's reconnecting`, (await status(page)).startsWith("Nitro Type dropped the connection. Reloading"), await status(page));
    const notes = await page.evaluate(() => window.__notes);
    check(`${name}: notification`, notes.some((n) => n.startsWith("Reconnecting · racer_me: Nitro Type dropped the connection")), JSON.stringify(notes));
    const rs = await waitForResults(page, 2, 60000);
    check(`${name}: raced again after a fresh page`, rs.length === 2 && (await page.evaluate(() => window.__loads)) === 2, `loads ${await page.evaluate(() => window.__loads)}`);
    await page.waitForTimeout(1500);
    check(`${name}: session finished`, (await status(page)) === "Done: 2 races", await status(page));
    await context.close();
  });

  // The test button reports what the browser did with the notification.
  for (const [outcome, expectStart] of [
    ["shown", "Chrome says it showed the notification"],
    ["error", "Chrome couldn't show it"],
    ["silence", "Chrome didn't confirm it showed the notification"],
  ]) {
    await test(`notification test button: ${outcome}`, async (name) => {
      const { context, page } = await open("", { ...BASE, notify: true }, null, `(${(o) => {
        window.__notes = [];
        window.Notification = class {
          static permission = "granted";
          static requestPermission = async () => "granted";
          constructor(title, opts) {
            window.__notes.push(`${title}: ${opts?.body}`);
            setTimeout(() => (o === "shown" ? this.onshow?.() : o === "error" ? this.onerror?.(new Event("error")) : null), 50);
          }
          close() {}
        };
      }})(${JSON.stringify(outcome)})`);
      await page.locator('nav button[data-tab="panel"]').click();
      check(`${name}: shows the permission state`, (await page.locator(".notify-status").textContent()).startsWith("Your browser allows notifications"), await page.locator(".notify-status").textContent());
      await page.locator(".test-notify").click();
      await page.waitForTimeout(outcome === "silence" ? 4500 : 600);
      const notes = await page.evaluate(() => window.__notes);
      check(`${name}: sends one`, notes.length === 1 && notes[0] === "NT Autotyper: Test: notifications are working.", JSON.stringify(notes));
      const text = await page.locator(".notify-status").textContent();
      check(`${name}: says what happened and where to look`, text.startsWith(expectStart), text);
      await context.close();
    });
  }

  for (const [label, query] of [
    ["from the race update (no rewards box)", "?rewards=hidden&countdown=300"],
    ["from the saved state (no race updates)", "?rewards=hidden&server=none&countdown=300"],
  ]) {
    await test(`money & XP ${label}`, async (name) => {
      const { context, page } = await open(query, { ...BASE, wpmMin: 150, wpmMax: 150, races: 1 });
      await page.locator(".go").click();
      const [r] = await waitForResults(page, 1);
      await page.waitForTimeout(8000);
      const [st] = await page.evaluate(() => JSON.parse(localStorage.getItem("nt-autotyper-stats")));
      const o = st.official ?? {};
      check(`${name}: money and XP match`, o.money === r.shown.money && o.xp === r.shown.xp, JSON.stringify({ got: [o.money, o.xp], want: [r.shown.money, r.shown.xp] }));
      await page.waitForTimeout(500);
      const sub = await page.locator(".result-card .rc-sub").textContent();
      check(`${name}: shown on the result card`, sub.includes(`$${r.shown.money.toLocaleString()}`) && sub.includes(`+${r.shown.xp} XP`), sub);
      await context.close();
    });
  }

  await test("mini map", async (name) => {
    const { context, page } = await open("?countdown=500&nitros=3", { ...BASE, wpmMin: 120, wpmMax: 120, races: 1, nitros: 1 });
    await page.locator(".go").click();
    await page.waitForTimeout(2500);
    check(`${name}: Nitro Type's track canvas hidden`, await page.locator("canvas.race-track").evaluate((c) => c.style.display === "none"));
    const map = page.locator(".nta-minimap");
    check(`${name}: mini map in its place`, (await map.count()) === 1 && (await map.evaluate((el) => el.nextElementSibling?.matches("canvas.race-track"))));
    const cars = map.locator(".car");
    check(`${name}: a block per racer`, (await cars.count()) === 4);
    const labels = await map.locator(".label").allTextContents();
    check(`${name}: labelled`, labels.includes("You") && labels.includes("Speedy"), labels.join(", "));
    const mine = map.locator(".car.me");
    const lane = await mine.evaluate((el) => el.style.top);
    check(`${name}: your block in your lane`, lane === "40%", lane);
    const p1 = Number(await mine.evaluate((el) => el.style.getPropertyValue("--p")));
    const x1 = (await mine.boundingBox()).x;
    if (shotDir) await map.screenshot({ path: path.join(shotDir, "minimap-racing.png") });
    await page.waitForTimeout(1500);
    const p2 = Number(await mine.evaluate((el) => el.style.getPropertyValue("--p")));
    const x2 = (await mine.boundingBox()).x;
    check(`${name}: your block moves`, p2 > p1 && x2 > x1, `p ${p1} -> ${p2}`);
    const bots = await map.locator(".car.bot").evaluateAll((els) => els.map((el) => Number(el.style.getPropertyValue("--p"))));
    check(`${name}: bots move too`, bots.length === 3 && bots.every((v) => v > 0), bots.join(", "));
    await waitForResults(page, 1);
    await page.waitForTimeout(1000);
    check(`${name}: nitro streak shown`, Number(await map.evaluate((el) => el.dataset.boosts || 0)) >= 1);
    const finalLabels = await map.locator(".label").allTextContents();
    check(`${name}: places at the finish`, finalLabels.some((l) => /^\d(st|nd|rd|th) · You$/.test(l)), finalLabels.join(", "));
    if (shotDir) await map.screenshot({ path: path.join(shotDir, "minimap-finish.png") });

    await page.locator('nav button[data-tab="panel"]').click();
    await page.locator('input[data-k="miniMap"]').uncheck();
    await page.waitForTimeout(2000);
    check(`${name}: turning it off brings the track back`, (await map.count()) === 0 && (await page.locator("canvas.race-track").isVisible()));
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

  // Regression: the page must never be reloaded or left while you're in a
  // race, its lobby or its countdown (Nitro Type then locks you out with
  // "Currently in a Race").
  await test("slow lobby: never reloads or leaves early", async (name) => {
    // 14 s before GO each race: longer than the old 12 s reload fallback.
    const { context, page } = await open("?countdown=14000", { ...BASE, wpmMin: 200, wpmMax: 200, races: 2 });
    await page.locator(".go").click();
    const rs = await waitForResults(page, 2, 90000);
    check(`${name}: both races finished`, rs.length === 2);
    check(`${name}: page never reloaded`, (await page.evaluate(() => window.__loads)) === 1, `loads ${await page.evaluate(() => window.__loads)}`);
    check(`${name}: site menu "New Race" link never clicked`, (await page.evaluate(() => window.__decoyClicks)) === 0);
    await page.waitForTimeout(1000);
    check(`${name}: session finished`, (await status(page)) === "Done: 2 races", await status(page));
    await context.close();
  });

  await test("letters redrawn mid-race", async (name) => {
    const { context, page } = await open("?rerender=1&countdown=500", { ...BASE, wpmMin: 120, wpmMax: 120, races: 1 });
    await page.locator(".go").click();
    const [r] = await waitForResults(page, 1, 60000);
    check(`${name}: keeps typing the same race to the end`, r.correct > 100 && r.wrong === 0, `correct ${r.correct}, wrong ${r.wrong}`);
    check(`${name}: page never reloaded`, (await page.evaluate(() => window.__loads)) === 1);
    check(`${name}: no other link clicked`, (await page.evaluate(() => window.__decoyClicks)) === 0);
    await page.waitForTimeout(1000);
    check(`${name}: session finished`, (await status(page)) === "Done: 1 race", await status(page));
    await context.close();
  });

  await test('"Currently in a Race" popup', async (name) => {
    const { context, page } = await open("?inrace=1&countdown=500", { ...BASE, wpmMin: 200, wpmMax: 200, races: 1 });
    await page.locator(".go").click();
    await page.waitForTimeout(1500);
    const msg = await status(page);
    check(`${name}: explains it's waiting`, /still has you in your last race\. Pressing Try Again in \d+s/.test(msg), msg);
    await page.waitForTimeout(5000);
    check(`${name}: doesn't click too soon, or "Go To Your Garage"`, (await page.locator("#inrace").count()) === 1 && (await page.evaluate(() => window.__garageClicks)) === 0);
    const [r] = await waitForResults(page, 1, 60000);
    check(`${name}: presses Try Again after the wait and races`, r.correct > 100, `wpm ${r.wpm.toFixed(1)}`);
    check(`${name}: page never reloaded`, (await page.evaluate(() => window.__loads)) === 1);
    await context.close();
  });

  await test("no Race Again button: reload fallback", async (name) => {
    const { context, page } = await open("?again=none&countdown=800", { ...BASE, wpmMin: 200, wpmMax: 200, races: 2 });
    await page.locator(".go").click();
    const rs = await waitForResults(page, 2, 60000);
    check(`${name}: second race after reload`, rs.length === 2);
    check(`${name}: reloaded once, from the results screen`, (await page.evaluate(() => window.__loads)) === 2, `loads ${await page.evaluate(() => window.__loads)}`);
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
        (window.__noteOpts ||= []).push({ title, ...opts });
      }
    };
  }

  await test("background tab (throttled page timers)", async (name) => {
    const { context, page } = await open("?countdown=500", { ...BASE, wpmMin: 120, wpmMax: 120, accuracy: 97, races: 2, nitros: 0, notify: true, levelRace: "normal" }, null, simulateBackgroundTab);
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
    await page.waitForTimeout(2000);
    const notes = await page.evaluate(() => window.__notes);
    check(
      `${name}: a note per race, then the session summary`,
      notes.filter((n) => n.startsWith("Race finished · racer_me: ")).length === 2 && /^NT Autotyper session · racer_me: 2 races · avg \d+ WPM/.test(notes[notes.length - 1]),
      JSON.stringify(notes),
    );
    await context.close();
  });

  // A minimised window, as Chrome treats it: hidden, no screen refreshes at
  // all, timeouts slowed to 1 s and long-running timers to once a minute.
  function simulateMinimised() {
    const realSetTimeout = window.setTimeout;
    const realSetInterval = window.setInterval;
    window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.max(1000, ms || 0), ...args);
    window.setInterval = (fn, ms, ...args) => realSetInterval(fn, Math.max(60000, ms || 0), ...args);
    let frameIds = 0;
    window.requestAnimationFrame = () => ++frameIds; // never fires
    window.cancelAnimationFrame = () => {};
    Object.defineProperty(document, "hidden", { get: () => true });
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
  }

  await test("minimised without keep-alive: the mock really goes idle", async (name) => {
    const { context, page } = await open("?afk=1&countdown=500", { ...BASE, wpmMin: 100, wpmMax: 100, races: 1, keepAlive: false }, null, simulateMinimised);
    await page.locator(".go").click();
    await page.waitForFunction(() => window.__afkDq, null, { timeout: 30000 }).catch(() => {});
    check(`${name}: disqualified for inactivity (reproduces the problem)`, await page.evaluate(() => window.__afkDq === true));
    await context.close();
  });

  await test("minimised with keep-alive: races normally", async (name) => {
    const { context, page } = await open("?afk=1&countdown=500", { ...BASE, wpmMin: 100, wpmMax: 100, races: 2 }, null, simulateMinimised);
    await page.locator(".go").click();
    const rs = await waitForResults(page, 2, 120000).catch(() => []);
    check(`${name}: never disqualified`, (await page.evaluate(() => window.__afkDq)) === false);
    check(`${name}: both races finished`, rs.length === 2, `${rs.length} race(s)`);
    for (const r of rs) check(`${name}: speed still right`, Math.abs(r.wpm - 100) / 100 < 0.1, `got ${r.wpm.toFixed(1)}`);
    check(`${name}: bots kept moving too`, rs.every((r) => r.shown?.place >= 1));
    await context.close();
  });

  // A server that drops connections idle for 5 s, during a 9 s break.
  const BREAK = { breakEvery: 1, breakLenMin: 0.15, breakLenMax: 0.15 };
  await test("minimised through a break, keep-alive off: connection dropped (reproduces it)", async (name) => {
    const { context, page } = await open("?idlekick=1&countdown=300", { ...BASE, wpmMin: 180, wpmMax: 180, races: 2, keepAlive: false, ...BREAK }, null, simulateMinimised);
    await page.locator(".go").click();
    // (it then reloads to reconnect, so look in sessionStorage)
    let kicks = null;
    for (let i = 0; i < 40 && !kicks; i++) {
      await page.waitForTimeout(1000);
      kicks = await page.evaluate(() => sessionStorage.getItem("mock-kicks")).catch(() => null);
    }
    check(`${name}: disconnected`, Number(kicks) >= 1, `kicks ${kicks}`);
    await context.close();
  });

  await test("minimised through a break: keep-alive holds the connection", async (name) => {
    const { context, page } = await open("?idlekick=1&countdown=300", { ...BASE, wpmMin: 180, wpmMax: 180, races: 2, ...BREAK }, null, simulateMinimised);
    await page.locator(".go").click();
    const rs = await waitForResults(page, 2, 120000).catch(() => []);
    check(`${name}: both races, with the break in between`, rs.length === 2, `${rs.length} race(s)`);
    check(`${name}: never disconnected`, (await page.evaluate(() => sessionStorage.getItem("mock-kicks"))) === null && (await page.evaluate(() => window.__kicked)) === false);
    await context.close();
  });

  await test("long break: next race from a fresh page", async (name) => {
    const { context, page } = await open("?countdown=300", { ...BASE, wpmMin: 180, wpmMax: 180, races: 2, breakEvery: 1, breakLenMin: 0.1, breakLenMax: 0.1 }, null, () => (window.__ntAutotyperLongBreakMs = 3000));
    await page.locator(".go").click();
    const rs = await waitForResults(page, 2, 90000);
    check(`${name}: reloaded once, after the break`, rs.length === 2 && (await page.evaluate(() => window.__loads)) === 2, `loads ${await page.evaluate(() => window.__loads)}`);
    await page.waitForTimeout(1500);
    check(`${name}: session finished`, (await status(page)) === "Done: 2 races", await status(page));
    await context.close();
  });

  await test("keep-alive stays out of the way when visible", async (name) => {
    const { context, page } = await open("?countdown=300", { ...BASE });
    const info = await page.evaluate(() => {
      const id = setTimeout(() => {}, 10);
      const iv = setInterval(() => {}, 1000);
      clearInterval(iv);
      return { timeoutId: id, intervalIsOurs: iv >= 2 ** 30 };
    });
    check(`${name}: visible timeouts go straight to the browser`, info.timeoutId < 2 ** 30, JSON.stringify(info));
    let frames = await page.evaluate(() => new Promise((res) => { let n = 0; const f = () => (++n < 10 ? requestAnimationFrame(f) : res(n)); requestAnimationFrame(f); }));
    check(`${name}: frames still run normally`, frames === 10);
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

  await test("simple mode (default) and the Advanced switch", async (name) => {
    const { context, page } = await open("?countdown=500", { ...BASE, wpmMin: 150, wpmMax: 150 }, {});
    const visible = (sel) => page.locator(sel).first().isVisible();
    check(
      `${name}: simple shows speed, accuracy, nitros, races, track, Start`,
      (await visible('input[type=number][data-k="wpmMin"]')) && (await visible('input[type=number][data-k="accMax"]')) &&
        (await visible('input[data-k="nitros"]')) && (await visible('input[data-k="races"]')) && (await visible(".track")) && (await visible(".go")),
    );
    check(
      `${name}: simple hides tabs, sliders, timing variation, breaks`,
      !(await visible(".box nav")) && !(await visible('input[type=range][data-k="wpmMin"]')) && !(await visible('[data-k="variance"]')) && !(await visible('[data-k="breakEvery"]')),
    );
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-simple.png") });

    // The car drives along the track during the race.
    await page.locator(".go").click();
    await page.waitForTimeout(2500);
    const p1 = Number(await page.locator(".box .track").evaluate((el) => el.style.getPropertyValue("--p")));
    const x1 = (await page.locator(".box .track .car").boundingBox()).x;
    await page.waitForTimeout(1500);
    const p2 = Number(await page.locator(".box .track").evaluate((el) => el.style.getPropertyValue("--p")));
    const x2 = (await page.locator(".box .track .car").boundingBox()).x;
    check(`${name}: the car moves along the track`, p2 > p1 && p1 > 0 && x2 > x1, `p ${p1} -> ${p2}, x ${x1.toFixed(0)} -> ${x2.toFixed(0)}`);
    if (shotDir) await page.locator(".box").screenshot({ path: path.join(shotDir, "panel-simple-typing.png") });
    await waitForResults(page, 1);

    await page.locator(".adv-switch").check({ force: true });
    check(`${name}: Advanced brings back tabs and every setting`, (await visible(".box nav")) && (await visible('[data-k="variance"]')) && (await visible('[data-k="breakEvery"]')));
    await page.reload();
    await page.waitForSelector(".go", { state: "attached" });
    check(`${name}: Advanced remembered`, await visible(".box nav"));
    await context.close();
  });

  await test("focus view", async (name) => {
    const { context, page } = await open("?countdown=500", { ...BASE, wpmMin: 120, wpmMax: 120, races: 2 }, {});
    await page.locator(".focus-btn").click();
    const box = await page.locator(".focus").boundingBox();
    check(`${name}: covers the whole window`, box && box.width === 1200 && box.height === 800, JSON.stringify(box));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "focus-idle.png") });

    await page.locator(".f-go").click();
    await page.waitForTimeout(3000);
    const num = Number(await page.locator(".f-num").textContent());
    check(`${name}: big live WPM while typing`, num > 60 && num < 200, String(num));
    check(`${name}: shows the race count`, (await page.locator(".f-count").textContent()) === "race 1 of 2", await page.locator(".f-count").textContent());
    const p = Number(await page.locator(".f-track").evaluate((el) => el.style.getPropertyValue("--p")));
    check(`${name}: track shows progress`, p > 0 && p < 1, String(p));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "focus-typing.png") });

    const typed = () => page.evaluate(() => document.querySelectorAll(".is-typed").length);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const t1 = await typed();
    await page.waitForTimeout(800);
    check(`${name}: Esc closes it`, !(await page.locator(".focus").isVisible()));
    check(`${name}: ...without stopping the typing`, (await typed()) > t1 && (await page.locator(".go").textContent()) === "Stop");

    await page.locator(".focus-btn").click();
    await page.mouse.click(600, 120); // background, not a button
    check(`${name}: clicking the background closes it`, !(await page.locator(".focus").isVisible()));
    await page.locator(".focus-btn").click();
    await page.keyboard.press("x");
    await page.waitForTimeout(400);
    check(`${name}: any other key still stops typing`, (await page.locator(".f-go").textContent()) === "Start", await page.locator(".f-status").textContent());
    await context.close();
  });

  await test("Low-FPS mode", async (name) => {
    const { context, page } = await open("?countdown=500", { ...BASE, wpmMin: 150, wpmMax: 150, races: 1, lite: true }, {});
    check(`${name}: panel in Low-FPS mode`, await page.locator(".box.lite").count() === 1);
    await page.locator(".go").click();
    await page.waitForTimeout(2500);
    check(`${name}: no live standings or track dots`, !(await page.locator(".live-people").isVisible()) && !(await page.locator(".box .rivals").isVisible()));
    const anims = await page.locator(".box .track .car").evaluate((el) => getComputedStyle(el).transitionDuration);
    check(`${name}: no animations`, anims === "0s", anims);
    check(`${name}: status still updates`, (await status(page)) === "Typing…", await status(page));
    const [r] = await waitForResults(page, 1);
    check(`${name}: still races normally`, r.correct > 100 && Math.abs(r.wpm - 150) / 150 < 0.1, `wpm ${r.wpm.toFixed(1)}`);
    await page.waitForTimeout(1500);
    check(`${name}: result card still shows`, await page.locator(".result-card").isVisible());
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
