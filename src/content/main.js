// Content-script entry point: wires the typing engine to settings, the popup,
// the keyboard shortcut and the on-page status pill.
(() => {
  if (globalThis.__MTA_LOADED__) return;
  globalThis.__MTA_LOADED__ = true;

  const { load, normalize } = globalThis.MTA_SETTINGS;
  let settings = globalThis.MTA_SETTINGS.DEFAULTS;

  const overlay = createOverlay();
  const typer = new globalThis.MTA_Typer((status) => {
    overlay.render(status, settings);
    chrome.runtime.sendMessage({ type: "status", status }).catch(() => {
      // No listener (popup closed, worker asleep) is fine.
    });
  });

  load().then((s) => {
    settings = s;
    typer.setSettings(s);
    overlay.render(typer.status, settings);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const raw = { ...settings };
    for (const [key, { newValue }] of Object.entries(changes)) raw[key] = newValue;
    settings = normalize(raw);
    typer.setSettings(settings); // takes effect on the next keystroke
    overlay.render(typer.status, settings);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "start":
        typer.start();
        break;
      case "stop":
        typer.stop();
        break;
      case "toggle":
        typer.toggle();
        break;
      case "getStatus":
        break;
      default:
        return false;
    }
    sendResponse(typer.status);
    return false;
  });

  // Safety stop: any real key press from the user (Tab to restart, Esc,
  // typing yourself) takes back control. Our own events are untrusted, and
  // modifier combos are skipped so the start/stop shortcut doesn't trip it.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted || !typer.status.running) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (["Shift", "Alt", "Control", "Meta", "CapsLock"].includes(e.key)) return;
      typer.stop("Stopped: you pressed a key");
    },
    true,
  );

  function createOverlay() {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .pill {
          font: 12px/1.2 ui-sans-serif, system-ui, sans-serif;
          display: flex; align-items: center; gap: 6px;
          padding: 6px 10px; border-radius: 999px;
          background: rgba(20, 20, 24, 0.82); color: #e8e8ea;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
          opacity: 0.55; transition: opacity 150ms;
        }
        .pill.running { opacity: 1; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #777; }
        .running .dot { background: #4ade80; }
      </style>
      <div class="pill"><span class="dot"></span><span class="text"></span></div>`;
    const pill = root.querySelector(".pill");
    const text = root.querySelector(".text");
    let mounted = false;

    return {
      render(status, s) {
        if (!s.showOverlay) {
          if (mounted) host.remove();
          mounted = false;
          return;
        }
        if (!mounted) {
          document.documentElement.appendChild(host);
          mounted = true;
        }
        pill.classList.toggle("running", status.running);
        text.textContent = status.running
          ? `Autotyping · ${s.wpm} WPM · ${s.accuracy}%`
          : `Autotyper: ${status.message}`;
      },
    };
  }
})();
