# Nitro Type Autotyper (Tampermonkey userscript)

A [Tampermonkey](https://www.tampermonkey.net/) userscript that types [Nitro Type](https://www.nitrotype.com) races for you. You set the speed and accuracy, and it types with human-like timing, hitting neighbouring keys by mistake and then the right one.

## Features

- **Target WPM** (10–300). Speed is checked against real race progress on every key, so it lands close to the target.
- **Target accuracy** (80–100%). Typos are neighbouring keys. Like a person, it pauses and then presses the right key (Nitro Type doesn't move on after a wrong key, so there's no backspacing).
- **Timing variation**: random gaps between keys.
- **Auto-start**: starts typing as soon as a race loads, and presses the first key the moment it says GO.
- **Control panel** at the bottom left of nitrotype.com. Settings save and apply live, mid-race.
- **Shortcut**: `Alt+Shift+A` starts and stops it.
- **Safety stop**: press any key yourself and it stops at once.

## Install

1. Install Tampermonkey for your browser. On Chrome, open the Tampermonkey card in `chrome://extensions` → **Details**, and turn on **Allow User Scripts** (older Chrome versions need **Developer mode** on instead).
2. Tampermonkey icon → **Create a new script…**, delete the template, paste in all of [`nitrotype-autotyper.user.js`](nitrotype-autotyper.user.js), and save (`Ctrl+S`).
3. Open (or reload) nitrotype.com. The **NT Autotyper** panel shows up at the bottom left.

## Use

- With **Start automatically each race** on (the default), just join a race. It waits for GO and types.
- With it off, press **Start** or `Alt+Shift+A` once the race page is open.
- It stops by itself at the finish line. Press any key or `Alt+Shift+A` to stop early. Click the panel header to collapse the panel.

## How it works

1. **Trusted keys.** Nitro Type ignores keyboard events made by scripts (`event.isTrusted` is `false`). The script runs before Nitro Type's code (`@run-at document-start`, `@grant none`) and wraps `addEventListener` and the `onkey…` properties. When an event came from this script, Nitro Type's listeners see `isTrusted: true`. Your real key presses and the page's own events are passed through untouched.
2. **Reading the race.** The text comes from the `.dash-letter` spans. The current position comes from their classes (`is-waiting` marks the current letter, `is-correct`/`is-typed` mark finished ones).
3. **Typing.** For each letter it sends `keydown` → `keypress` → `input` → `keyup`, with Shift for capitals and symbols and the old `keyCode`/`charCode` values filled in, just like a real keyboard. Before every key it re-reads the position. A key Nitro Type didn't take gets sent again, and it never runs ahead of the page.
4. **Iframes.** If the race runs inside an iframe, the script runs there too. The panel stays in the top page and controls the race with `postMessage`.

## Troubleshooting

I couldn't test this on the live site, so these are the likely failure points:

- **Panel says "Waiting for the race to start…" forever, or "Can't read the race progress".** Nitro Type has probably renamed its letter classes. Open DevTools on a race, look at a letter span's classes, and update `readRace()` in the script (the console logs `[NT Autotyper] letter classes: …` at verbose level).
- **Nothing types at all.** Check that the script runs at document-start. Tampermonkey settings → General → Config mode: Advanced → Inject mode should be "Instant" or "Default". If the race runs inside an iframe from a domain other than `nitrotype.com`, add a `// @match` line for that domain.
- **"Stopped: Nitro Type isn't accepting keys".** Nitro Type may be checking more than `isTrusted`. Open an issue with what the console shows.

## Fair use

Using bots breaks Nitro Type's rules. Accounts with bot-like stats get flagged, have their races wiped, or get banned. Use it on an account you don't mind losing.

## Development

`test/mock-nitrotype.html` is a stand-in race page. It rejects untrusted events, has a countdown, and stays on a letter after a mistake. It can listen through `keypress`, `keydown`, `document.onkeypress` or `input` events, and can run inside an iframe. The end-to-end test serves it at `https://www.nitrotype.com/race`, injects the userscript at document-start the way Tampermonkey does, and checks speed, accuracy, finishing, the shortcut and the safety stop:

```bash
npm install
npx playwright install chromium
npm test
```
