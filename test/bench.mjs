// How much main-thread time the userscript costs during a race, on a heavy
// page (the mock race plus ~4,000 extra elements, like Nitro Type's real
// page). Prints the Chrome performance counters over 10 seconds of racing.
//   npm run bench               panel, default settings
//   npm run bench -- focus      with the focus view open
//   npm run bench -- lite       in Low-FPS mode
//   npm run bench -- none       no userscript (just the page)
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "panel";
const script = mode === "none" ? null : readFileSync(path.join(root, "nitrotype-autotyper.user.js"), "utf8");
const filler = Array.from(
  { length: 800 },
  (_, i) => `<div class="card"><div><span>Player ${i}</span><span>${i % 150} WPM</span></div><div><b>${i}</b><i>Level ${i % 60}</i></div></div>`,
).join("");
const mock = readFileSync(path.join(root, "test/mock-nitrotype.html"), "utf8").replace("<body>", `<body><div id="filler">${filler}</div>`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route("https://www.nitrotype.com/**", (r) => r.fulfill({ contentType: "text/html", body: mock }));
await context.addInitScript((lite) => {
  localStorage.setItem("nt-autotyper-settings", JSON.stringify({ wpmMin: 120, wpmMax: 120, accMin: 97, accMax: 97, races: 1, lite }));
}, mode === "lite");
if (script) await context.addInitScript({ content: script });
const page = await context.newPage();
await page.goto("https://www.nitrotype.com/race?countdown=300");
await page.waitForTimeout(500);
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
if (mode === "focus") {
  await page.locator(".focus-btn").click();
  await page.locator(".f-go").click();
} else if (script) {
  await page.locator(".go").click();
}
const before = await metrics();
await page.waitForTimeout(10000);
const after = await metrics();
const d = (k) => after[k] - before[k];
console.log(
  `${mode}: main thread ${Math.round(d("TaskDuration") * 1000)} ms, script ${Math.round(d("ScriptDuration") * 1000)} ms, ` +
    `layout ${Math.round(d("LayoutDuration") * 1000)} ms (${d("LayoutCount")} passes), style ${Math.round(d("RecalcStyleDuration") * 1000)} ms (${d("RecalcStyleCount")})`,
);
await browser.close();
