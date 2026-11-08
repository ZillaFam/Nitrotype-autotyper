# Nitro Type Autotyper (Tampermonkey userscript)

A [Tampermonkey](https://www.tampermonkey.net/) userscript that types [Nitro Type](https://www.nitrotype.com) races for you, with human-like rhythm, typos and nitros, for as many races as you choose.

## Features

- **Speed range**: set a min and max WPM, and each race picks a random target inside it. Speed is checked against real progress on every key, so each race lands close to its target.
- **Human rhythm**: modelled on touch typing. Keys on alternating hands come fast; the same finger on a new key, or a reach to another row, is slower. Common words ("the", "and", "with") go on autopilot; capitals, numbers and punctuation are slower; there's a beat after each sentence, a shorter one after a comma, and a moment before long words. The speed also drifts up and down a little over each race, with a warm-up at the start and a push at the end.
- **Human reaction at GO**: when Nitro Type's race server says GO, the first key comes a human reaction time later (about 0.2–0.5 s). If the script can't hear that signal, it keeps trying the first key until the race takes it, as before.
- **Off races now and then** (on by default): once in a while a race comes out slower and a bit sloppier (80–90% of the speed it picked), or starts slow and eases into its pace. More often at Strong, less at Light. They're tagged in the stats.
- **Human touch** (Light, Natural, Strong): how strong all of this is. Strong means bigger speed swings, longer pauses and a slower start. Timing variation (Advanced) adds random gaps on top. The race still averages your chosen speed.
- **Accuracy range** (80–100%): each race picks its own accuracy inside the range. Four kinds of typo: a neighbouring key, Shift missed on a capital, the next letter too early, or the previous key again. Like a person, it pauses and then presses the right key, slows down for a few keys, and is a bit more likely to slip again right after a mistake (typos come in little bursts).
- **Nitros**: uses the number you choose per race on the longest words. If you run out, it just types the word.
- **Multi-race sessions**: set *Races to run*, press Start, and it types every race, clicks "Race Again" after a short random pause, and stops when it's done. If there's no button, it reloads the race page.
- **Long breaks**: optionally take a 1–3 minute (or whatever you set) break roughly every N races. The count varies a little each time. A countdown shows in the panel and the tab title (`❚❚ 8/20 · …`).
- **Stats with Nitro Type's own results**: after each race it takes your official WPM, accuracy and place from Nitro Type's race state (the same data other Nitro Type userscripts read). **Money and XP** are your totals after the race minus before it: the totals Nitro Type sends with the finishing race update (`rewards.current`), or its saved state (`persist:nt`); the results screen's rewards box is only a fallback. Your login token is never used. Without the race state it reads your own row (`.is-self`) in the results table.
- **Stats tab**: a "Today" line (races, WPM, money, XP, wins); cards for races, average WPM and accuracy, best WPM, wins and win rate, top-3 rate, money, XP, and **money and XP per hour of racing** (breaks over 10 minutes don't count); a per-race chart of WPM or accuracy (off races are hollow dots); a **by day** chart of races, money or XP for the last 14 days (races older than the last 300 are kept as day totals, for up to a year); the race history with money and place; and **Export CSV** for your last 300 races.
- **Mini map** (on by default; Panel tab to switch off): a light five-lane map in place of Nitro Type's race track. A block per racer (you in coral, players blue, bots grey, the Wampus orange), start and finish lines, an orange streak when someone uses a nitro, and places at the finish. Nitro Type's track is only hidden, and comes back when you switch the map off. The idea comes from Toonidy's MIT-licensed "Nitro Type - Racing Mini Map" userscript; this is a separate, dependency-free implementation. If it can't find them, it falls back to its own estimate, marked with `~`. Cards for races, average/best WPM, average accuracy, total money and XP; a history table; and a **chart** of WPM per race (hover a point for details). Saved between visits.
- **Notifications with a level per type** (Panel tab). Pick a level for each type:
  - **Off**: nothing.
  - **Low**: a chime, no pop-up.
  - **Normal**: a pop-up.
  - **High**: a chime and a pop-up.
  - **Urgent**: an alarm beep and a pop-up that stays on screen and re-alerts.

  Defaults: captcha **Urgent**; problems (Currently in a race, disqualified, logged out, computer asleep, keys not accepted), session done and milestones **High**; level ups and season-pass rewards **Normal**; after each race **Low**. The types: after each race (place, WPM, accuracy, money, XP); level ups and season-pass rewards; milestones (personal-best WPM, 3 wins in a row, every 5th win); session done (races, average WPM and accuracy, wins, money, XP); problems; captcha (the session pauses; at Urgent it rings every minute, up to 5 times, with a flashing `⚠ CAPTCHA` tab title and a red panel until you come back). Each row has a ▶ button to try its level.

  Titles carry your Nitro Type username, e.g. **"Race finished · yourname"** (read from the race data, or Nitro Type's saved state, and remembered). They fire **every time**, whether or not you're looking at the tab, and each one is a new notification (so the system never quietly replaces the last one). When the page is on screen, including in full screen where the system may hide its own pop-ups, they also appear as **pop-ups on the page** (top right): normal and high ones go away after a few seconds, urgent ones stay until you close them. Sounds need one click on the page after it loads (a browser rule); if sound is still blocked, a pop-up says so and the Panel tab shows `Sound: blocked` until you click anywhere on the page.
  Clicking a notification brings you to the race tab.
- **Captcha pause**: if Nitro Type asks for a captcha, typing stops, the session **pauses** and you get a notification (even with the tab in view). The script never touches the captcha: you solve it. Once it has been gone for a few seconds, the session carries on by itself: it finishes the race you were in, or types the next one (yours or one it starts from the results screen). Press Stop to end the session instead. The always-on "protected by reCAPTCHA" badge is ignored.
- **Safety stops**: a session ends (with a notification) instead of carrying on when:
  - the computer was asleep or shut down (a big jump in the clock mid-session, or Chrome restoring the tab afterwards: the session is not resumed);
  - you're still logged out right after a fresh page (see **Reconnects** below). This one is **urgent**, like a captcha: alarm beeps, a pop-up that stays and repeats every minute (up to 5 times), a flashing `⚠ LOGGED OUT` tab title and a red panel. It's noticed anywhere in a session, breaks included, also when Nitro Type sends you to the login page or shows a login box. Its level is the **Logged out / stuck** row (Urgent by default);
  - nothing happens for 10 minutes (no race at all, not on a break or a captcha pause), even after reloading the race page at 5 minutes: same urgent alarm, as `⚠ SESSION STUCK`;
  - Nitro Type drops the connection more than 4 times in 30 minutes;
  - you're disqualified twice in a row. After a single "Disqualified!" it notifies you and presses that popup's **Race Again** (never "Go To Your Garage").
- **Reconnects**: if Nitro Type shows you as logged out, or shows a "disconnected" / "session expired" popup between races, the script reloads the race page to reconnect (your login lives in the browser; the script never touches it) and carries on, with a **"Reconnecting"** notification. Never in the middle of a race.
- **Long breaks end with a fresh page**: after a break of 2 minutes or more, the next race starts from a freshly loaded race page instead of Race Again, since a page that sat idle that long may have lost its connection.
- **Stop when the screen locks** (Panel tab): uses Chrome's Idle Detection, which asks for permission once, so a session doesn't keep running when you lock your computer and walk away.
- **Themes**: Dark, Midnight, Light, or Auto (follows your system), plus six accent colours, in the Panel tab. The pop-ups and charts follow them too.
- **Simple by default**: the panel shows just speed, accuracy, the Human touch, nitros, races to run, the mini track and Start, in three small groups. A badge next to the status says what's going on at a glance: Idle, Waiting, Typing, Break, Captcha or Done. Flip the **Advanced** switch at the bottom for every other setting plus the Stats and Panel tabs.
- **Mini track**: a little car drives along a lane to a checkered finish as the race goes on, with a dot for each other racer.
- **Other racers**: while racing, live standings (position, name, progress, WPM) under the track. After the race, a **result card**: your place badge (gold, silver or bronze), WPM, accuracy, money, XP and nitros, plus the final standings. Both show in the focus view too.
- **Mini status window**: the ⧉ button opens a tiny window that stays on top of every other app (Chrome/Edge 116+, "Picture-in-Picture"). Drag it to a corner of your screen. It shows the account's Nitro Type username and its status (Chrome allows one such window at a time, across all profiles). A 🔇 next to the status means the page can't make sound right now (see below). The status is one of **Racing**, **Waiting for race**, **Taking a break**, **Captcha!**, **Logged out**, **Stuck**, **Done**, **Stopped** or **Idle**, with a coloured dot, and flashes red when something needs you. It belongs to the Nitro Type tab: it closes if that page reloads (after a long break or a reconnect), and comes back with your next click anywhere on the page. ⧉ again (or its own close button) closes it.
- **No sound after the page reloads.** Chrome blocks a page's sound until you click on that page once, and the script reloads the page now and then (after a long break, to reconnect). When that's the case the panel shows a yellow **🔇 No sound right now** bar: click anywhere on the page.
- **Focus view**: the ⛶ button opens a calm full-screen view: a big WPM number, the race count, a large track and Start/Stop. ⛶ inside it switches the browser to real full screen. **Esc** or a click on the background closes it without stopping the typing; any other key stops typing as usual. Animations are off if your system asks for reduced motion.
- **Panel**: drag it by the header, resize it from the corner, collapse it with ▾, switch to **compact mode** with ⊟ (just the status, a progress bar and Start/Stop), and make it see-through when you're not hovering. It remembers all of this. It also shows live progress: a progress bar, the target, the current WPM and races done.
- **Debug view**: shows what the script sees on the page (race text, position, letter classes, keys sent, nitros, the Race Again button, Nitro Type's results, timer mode). **Copy debug info** puts it on your clipboard to send over when something breaks.
- **Auto-update**: Tampermonkey checks GitHub for new versions and updates the script by itself.
- **Controls**: `Alt+Shift+A` starts and stops it, and pressing any key yourself stops the whole session at once.
- **Runs in a background tab**: start it, switch to another tab, and it keeps typing at full speed. The tab title shows progress (`▶ 2/5 · …`), then `✓ Done: 5 races · …` when it's finished.

## Running in the background

Start a session, then switch to another tab, or **minimise the window**. It keeps going:

- The script's own typing runs on a Web Worker clock, which Chrome doesn't slow down in background tabs.
- **Keep Nitro Type running when minimised** (on by default, Panel tab): in a minimised or hidden window Chrome stops screen refreshes and slows the page's timers to once a second, then once a minute. That freezes Nitro Type's own page, so your progress stops reaching the server and you get *disqualified due to inactivity*. While the window is hidden **and** a session is on (including its breaks, captcha pauses and the gaps between races, so the connection never sits idle), the script gives Nitro Type's page ~15 frames a second and runs its timers on the worker clock. While visible, or without a session, nothing changes. If Chrome does put the tab to sleep, the panel says so when you come back.

Watch the tab title for progress, and turn on notifications to hear about each race.

- **The tab has to stay open.** A closed tab can't run anything, so it can't type either.
- **Stop Chrome from putting the tab to sleep.** Go to `chrome://settings/performance` → Memory Saver → **Always keep these sites active** → add `nitrotype.com`. Otherwise Chrome may discard the tab after a while in the background.
- Prefer racing in a separate browser (e.g. Edge with Tampermonkey) if you want Chrome free for everything else; the script works the same there, and that window can stay minimised.
- If Nitro Type blocks Web Workers, the script falls back to normal timers. A background tab then gets slowed down, so keep it visible.

## Performance

The script is built to stay out of the way of Nitro Type's frame rate:

- It never reads the whole page's text (that forces the browser to lay out the entire page). Popups and captchas are checked only inside dialogs and captcha widgets, every 1.5 s.
- The race text is cached; each keystroke only asks the browser where the cursor is.
- The panel is isolated from the page (CSS containment), updates at most once per frame, never while the tab is hidden, and only changes what changed. The car and dots move with GPU transforms, and the focus view's background drifts as one GPU layer.
- **Low-FPS mode** (Panel tab) goes further for slow computers: no animations, no live standings or track dots, and the panel updates once a second.

Measured with `npm run bench` (10 s of racing at 120 WPM on a page with ~4,000 extra elements): main-thread time went from about 2,000 ms (v3.3) to about 900 ms (v3.4), and 730 ms in Low-FPS mode. Typing alone, with no panel, costs about 700 ms, almost all of it the page redrawing the letters.

## Install

1. Install Tampermonkey. On Chrome, open the Tampermonkey card in `chrome://extensions` → **Details**, and turn on **Allow User Scripts** (older Chrome versions need **Developer mode** on instead).
2. Open this link: **[install the script](https://raw.githubusercontent.com/ZillaFam/Nitrotype-autotyper/HEAD/nitrotype-autotyper.user.js)**. Tampermonkey shows an install page; click **Install** (or **Update** if you already had it).
3. Open nitrotype.com. The **NT Autotyper** panel appears at the bottom left.

**Updates are automatic** from then on: Tampermonkey checks the link above about once a day. To check right away: Tampermonkey icon → **Utilities** → **Check for userscript updates**. Your settings and stats are kept.

If you had pasted an older version in by hand, open the install link once; Tampermonkey recognises it as the same script and updates it in place.

## Use

1. On the **Race** tab, set the speed and accuracy ranges, nitros per race, races to run, and long breaks if you want them.
2. Press **Start** (or `Alt+Shift+A`) on the race page. It waits for GO, types, and moves on to the next race until the count is done.
3. The **Stats** tab shows how it went. The **Panel** tab has the theme and accent colour, opacity, a reset for position and size, notifications, and the debug view.

## How it works

1. **Trusted events.** Nitro Type ignores keyboard and mouse events made by scripts (`event.isTrusted` is `false`). The script runs before Nitro Type's code (`@run-at document-start`, `@grant none`) and wraps `addEventListener` and the `on…` properties. When an event came from this script, Nitro Type's listeners see `isTrusted: true`. Your real input and the page's own events are untouched.
2. **Reading the race.** The text comes from the `.dash-letter` spans. The position comes from their classes (`is-waiting` marks the current letter, `is-correct`/`is-typed` mark finished ones).
3. **Typing.** Each letter is `keydown` → `keypress` → `input` → `keyup`, with Shift and the old `keyCode`/`charCode` values, like a real keyboard. A nitro is Enter at the start of a word. It re-reads the position before every key, so a missed key is re-sent and it never runs ahead of the page.
4. **Background timing.** Every delay (between keys, between races, the checks for a new race) uses timers inside a Web Worker, so they aren't throttled when the tab is hidden.
5. **Sessions.** The race count lives in `sessionStorage`, so a reload continues the session but a new tab never starts typing by itself. Settings, stats and panel layout live in `localStorage`.
6. **Iframes.** If the race is inside an iframe, the script types there, and the panel in the top page controls it with `postMessage`.

## Troubleshooting

- **First, turn on the debug view** (Panel tab) and press **Copy debug info**. It shows exactly what the script found on the page, which usually pinpoints the problem.
- **"Waiting for the race to start…" forever, or "Can't read the race progress".** Nitro Type has probably renamed its letter classes. Inspect a letter in DevTools and update `readRace()` (the console logs `[NT Autotyper] letter classes: …` at verbose level).
- **Nitros never fire.** The script presses Enter at the start of a word. If Nitro Type changed the nitro key, update the `pressKey("\n")` call in the engine.
- **It doesn't go to the next race.** It looks for a button labelled "Race Again", "Next Race", "Play Again" or "New Race", and reloads the page if it can't find one within about 12 seconds. If Nitro Type's button says something else, add it to `findRaceAgainButton()`.
- **Panel says "Loaded late, so it may not type".** Tampermonkey ran the script after the page had loaded, so it couldn't get in ahead of Nitro Type. Tampermonkey Dashboard → Settings (set Config mode to Advanced if you can't see it) → **Content Script API** → **UserScripts API Dynamic**, then reload the page. It's the only mode with real document-start support in Chrome.
- **Stats show `~` estimates instead of Nitro Type's results.** The script looks for a small block of text after the finish that mentions both "WPM" and accuracy. The debug view's `results:` line shows whether it found one. If Nitro Type's results screen is worded differently, send the debug info and a screenshot of the results.
- **Only the sound, no pop-up.** First check the level: **Low** is a chime only (the default for *After each race*); pick Normal or higher for a pop-up. If pop-ups stop getting through, the panel shows a yellow bar saying why: Chrome can switch a site's notifications off by itself (for example after many notifications that nobody clicks); then it has an **Allow** button, or tells you to click the icon left of the address bar → Notifications → Allow. The Panel tab's *Last pop-up* line says whether Chrome showed the last one; if it did and you saw nothing, your computer is hiding it (Focus / Do Not Disturb, or the system's notification settings for Chrome). Keeping *After each race* at Low makes long sessions much less noisy, so Chrome is less likely to switch them off.
- **No notifications.** In the Panel tab, press **Send a test notification**. It asks the browser what happened and tells you: *Chrome says it showed the notification* (then your computer is hiding it: steps below), *Chrome couldn't show it* (check `chrome://settings/content/notifications`), or *Chrome didn't confirm it*. With **Chime for milestones and session done** on, you hear a chime even when the pop-up is hidden (the captcha has its own alarm). If nothing pops up, notifications are being blocked further down:
  1. Browser: padlock icon in the address bar → Notifications → **Allow** for nitrotype.com.
  2. Windows: Settings → System → Notifications → turn on notifications **and** **Google Chrome** (or Edge) in the app list; turn off **Do not disturb**, and check its automatic rules (they turn it on in full screen, e.g. the focus view's full-screen button, and while gaming). Missed ones are in the notification centre (Win+N). macOS: System Settings → Notifications → **Google Chrome** → Allow, style Banners or Alerts, and check Focus.
  3. By default they only appear when you're **not** looking at the Nitro Type tab; tick **Also when I'm looking at the tab** to get them always.
- **"Disqualified due to inactivity".** Nitro Type stopped seeing your car move. Most often the tab was minimised or fully hidden: check that **Keep Nitro Type running when minimised** is on (the debug view's `keepAlive:` line says `ACTIVE` while the window is hidden during a session). If it still happens, keep the window visible and send the debug info. Two in a row stop the session.
- **"Currently in a Race" popup.** Nitro Type shows this when you leave a race before it ends; it makes you wait until that race disqualifies you. If it appears during a session, the script waits 20–30 seconds and presses **Try Again** for you (never "Go To Your Garage"). The script itself never reloads or leaves the page during a race, its lobby or its countdown: it only moves on from a results screen.
- **Nothing types at all.** Check that Tampermonkey's Content Script API setting is "UserScripts API Dynamic" (see above). If the race is in an iframe on a domain other than `nitrotype.com`, add a `// @match` line for it.

## Fair use

Bots break Nitro Type's rules. Accounts with bot-like stats get flagged, have their races wiped, or get banned. Use an account you don't mind losing.

## Development

`test/mock-nitrotype.html` is a stand-in race page. It rejects untrusted events, has a countdown, stays on a letter after a mistake, supports nitros on Enter, and shows a "Race Again" button (or none, with `?again=none`). It can listen through `keypress`, `keydown`, `document.onkeypress` or `input` events, and run inside an iframe. The end-to-end test serves it at `https://www.nitrotype.com/race`, injects the userscript at document-start like Tampermonkey, and checks speed, the WPM and accuracy ranges, nitros, multi-race sessions (button and reload), long breaks, reading the results screen (and ignoring a profile "average WPM" widget), stats and the chart, a simulated background tab (page timers throttled to 1 second, page hidden) with a desktop notification, the fallback when workers are blocked, the auto-update header, the shortcut, the safety stop, the debug view, compact mode, dragging and collapsing the panel, simple mode and the Advanced switch, the mini track, and the focus view:

```bash
npm install
npx playwright install chromium
npm test            # all cases (about 15 minutes)
npm run bench       # main-thread cost during a race (also: -- focus, -- lite, -- none)
ONLY=nitros npm test  # just the cases whose name contains "nitros"
```
