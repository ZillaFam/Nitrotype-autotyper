# Monkeytype Autotyper

A Chrome / Edge extension (Manifest V3) that types [Monkeytype](https://monkeytype.com) tests for you. You set the speed and accuracy, and it types with human-like timing, making typos on purpose and fixing them with backspace.

## Features

- **Target WPM** (10–400). Speed is checked against actual progress on every keystroke, so the result lands close to the target even with typos.
- **Target accuracy** (80–100%). It hits a neighbouring key by mistake, sometimes types one more letter before "noticing", pauses, backspaces and fixes it.
- **Timing variation**: random gaps between keys and overlapping key presses, so it doesn't type like a metronome.
- **Popup UI** with live settings: changes apply on the next keystroke, even mid-test.
- **Start/stop shortcut**: `Alt+Shift+A` by default (change it at `chrome://extensions/shortcuts`).
- **Safety stop**: pressing any key on the page yourself (Tab to restart, Esc, …) stops it at once.
- Status pill on the page and an `ON` badge on the toolbar icon while it's typing.

## Install

1. Download or clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the repo folder (the one with `manifest.json`).
4. Reload any Monkeytype tab that was already open.

## Use

1. Open [monkeytype.com](https://monkeytype.com) and pick a mode (time, words, quote or custom).
2. Click the extension icon, set speed and accuracy, and press **Start**. Or press `Alt+Shift+A`.
3. It stops by itself when the test ends. Press the shortcut or any key to stop it early.

Keep the Monkeytype tab in front. Chrome slows down timers in background tabs, which would wreck the WPM.

## How it works

Monkeytype reads input from a hidden `<textarea id="wordsInput">`. Its value is always a space plus whatever is typed into the current word. For every key, the extension sends the same events a real keyboard does, in order: `keydown`, `beforeinput`, then the text change and `input`, then `keyup` (with Shift presses for capitals and symbols). It edits the textarea only when Monkeytype hasn't cancelled the `beforeinput`.

Before each key it re-reads the active word (`#words .word.active` and its `<letter>`s) and the textarea, then picks the next action: the next correct letter, a typo, a space, or a backspace. Because it never assumes a key worked, it stays in sync with settings like *stop on error*, *confidence mode* and *indicate typos*, and with you restarting the test.

| File | Role |
| --- | --- |
| `src/content/typer.js` | Typing engine: DOM reading, event synthesis, typo logic, pacing |
| `src/content/keys.js` | QWERTY key codes, Shift side, neighbouring keys for typos |
| `src/content/main.js` | Wires the engine to settings, messages, the safety stop and the status pill |
| `src/background/service-worker.js` | Keyboard shortcut and toolbar badge |
| `src/popup/` | Settings popup |
| `src/shared/settings.js` | Defaults, limits and storage (`chrome.storage.sync`) |

## Limitations

- **Layout emulation must be off.** If Monkeytype's *layout* setting isn't `default`, Monkeytype converts key presses into letters itself, and each letter gets typed twice. Funboxes that remap keys have the same problem.
- **Zen mode** isn't supported, since there are no target words to read.
- It relies on Monkeytype's page structure (`#wordsInput`, `.word.active`, `<letter>`). If Monkeytype changes it, the selectors in `typer.js` will need updating.

## Fair use

Monkeytype's rules don't allow submitting automated results, and its anti-cheat flags and bans accounts that do. Use this logged out, or turn off result saving (search "result saving" in Monkeytype's command line, `Esc`), so botted runs don't reach the leaderboards.

## Development

There's no build step: edit the files, then click the reload icon on the extension card in `chrome://extensions`.

The end-to-end test loads the extension into Chromium with Playwright. It serves `test/mock-monkeytype.html` (a stand-in that copies Monkeytype's input handling) at `https://monkeytype.com/` and checks speed, accuracy, finishing, stop-on-error, the safety stop and the popup:

```bash
npm install
npx playwright install chromium
npm test
```
