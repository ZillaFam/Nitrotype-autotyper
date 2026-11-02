# Nitro Type Autotyper (Tampermonkey userscript)

A [Tampermonkey](https://www.tampermonkey.net/) userscript that types [Nitro Type](https://www.nitrotype.com) races for you, with human-like rhythm, typos and nitros, for as many races as you choose.

## Features

- **Speed range**: set a min and max WPM, and each race picks a random target inside it. Speed is checked against real progress on every key, so each race lands close to its target.
- **Human rhythm**: slower on capitals, numbers, punctuation and the first letter of each word; faster on double letters and common pairs like "th" and "er"; a warm-up at the start, a push at the end, and the odd short pause between words. Timing variation adds random gaps on top.
- **Target accuracy** (80–100%), with three kinds of typo: a neighbouring key, the next letter too early, or the previous key again. Like a person, it pauses and then presses the right key.
- **Nitros**: uses the number you choose per race on the longest words. If you run out, it just types the word.
- **Multi-race sessions**: set *Races to run*, press Start, and it types every race, clicks "Race Again" after a short random break, and stops when it's done. If there's no button, it reloads the race page.
- **Session stats**: race count, average and best WPM, average accuracy, and a history of recent races (WPM, target, accuracy, nitros). Saved between visits.
- **Panel**: drag it by the header, resize it from the corner, collapse it with ▾, and make it see-through when you're not hovering. It remembers all of this. It also shows live progress: a progress bar, the target, the current WPM and races done.
- **Controls**: `Alt+Shift+A` starts and stops it, and pressing any key yourself stops the whole session at once.

## Install

1. Install Tampermonkey. On Chrome, open the Tampermonkey card in `chrome://extensions` → **Details**, and turn on **Allow User Scripts** (older Chrome versions need **Developer mode** on instead).
2. Tampermonkey icon → **Create a new script…**, delete the template, paste in all of [`nitrotype-autotyper.user.js`](nitrotype-autotyper.user.js), and save (`Ctrl+S`).
3. Open nitrotype.com. The **NT Autotyper** panel appears at the bottom left.

To update, paste the new version over the old one in the Tampermonkey editor. Your settings and stats are kept.

## Use

1. On the **Race** tab, set the speed range, accuracy, nitros per race and races to run.
2. Press **Start** (or `Alt+Shift+A`) on the race page. It waits for GO, types, and moves on to the next race until the count is done.
3. The **Stats** tab shows how it went. The **Panel** tab has opacity and a reset for position and size.

## How it works

1. **Trusted events.** Nitro Type ignores keyboard and mouse events made by scripts (`event.isTrusted` is `false`). The script runs before Nitro Type's code (`@run-at document-start`, `@grant none`) and wraps `addEventListener` and the `on…` properties. When an event came from this script, Nitro Type's listeners see `isTrusted: true`. Your real input and the page's own events are untouched.
2. **Reading the race.** The text comes from the `.dash-letter` spans. The position comes from their classes (`is-waiting` marks the current letter, `is-correct`/`is-typed` mark finished ones).
3. **Typing.** Each letter is `keydown` → `keypress` → `input` → `keyup`, with Shift and the old `keyCode`/`charCode` values, like a real keyboard. A nitro is Enter at the start of a word. It re-reads the position before every key, so a missed key is re-sent and it never runs ahead of the page.
4. **Sessions.** The race count lives in `sessionStorage`, so a reload continues the session but a new tab never starts typing by itself. Settings, stats and panel layout live in `localStorage`.
5. **Iframes.** If the race is inside an iframe, the script types there, and the panel in the top page controls it with `postMessage`.

## Troubleshooting

- **"Waiting for the race to start…" forever, or "Can't read the race progress".** Nitro Type has probably renamed its letter classes. Inspect a letter in DevTools and update `readRace()` (the console logs `[NT Autotyper] letter classes: …` at verbose level).
- **Nitros never fire.** The script presses Enter at the start of a word. If Nitro Type changed the nitro key, update the `pressKey("\n")` call in the engine.
- **It doesn't go to the next race.** It looks for a button labelled "Race Again", "Next Race", "Play Again" or "New Race", and reloads the page if it can't find one within about 12 seconds. If Nitro Type's button says something else, add it to `findRaceAgainButton()`.
- **Nothing types at all.** Tampermonkey settings → Config mode: Advanced → Inject mode should be "Instant" or "Default". If the race is in an iframe on a domain other than `nitrotype.com`, add a `// @match` line for it.

## Fair use

Bots break Nitro Type's rules. Accounts with bot-like stats get flagged, have their races wiped, or get banned. Use an account you don't mind losing.

## Development

`test/mock-nitrotype.html` is a stand-in race page. It rejects untrusted events, has a countdown, stays on a letter after a mistake, supports nitros on Enter, and shows a "Race Again" button (or none, with `?again=none`). It can listen through `keypress`, `keydown`, `document.onkeypress` or `input` events, and run inside an iframe. The end-to-end test serves it at `https://www.nitrotype.com/race`, injects the userscript at document-start like Tampermonkey, and checks speed, the WPM range, accuracy, nitros, multi-race sessions (button and reload), stats, the shortcut, the safety stop, and dragging and collapsing the panel:

```bash
npm install
npx playwright install chromium
npm test            # all cases (about 3 minutes)
ONLY=nitros npm test  # just the cases whose name contains "nitros"
```
