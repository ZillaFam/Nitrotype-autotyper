#!/usr/bin/env python3
"""
NT Autotyper status helper: one small always-on-top box in the corner of your
screen with a row per Nitro Type account, for when you run several (one per
Chrome profile). Each profile's NT Autotyper sends its status here every couple
of seconds (turn on "Send status to the desktop helper" in its Panel tab).

Everything stays on this computer: the helper only listens on 127.0.0.1.

It also makes the sounds (no browser rules about clicking first here): an
alarm when an account needs you (captcha, logged out, stuck), repeated every
minute up to 5 times, and a soft sound when one finishes or stops running.

Run it: double-click this file (Windows, with Python installed), or
    python3 nt-status.pyw
Drag the box to move it; right-click it for sound on/off, back to the corner, quit.
Without a screen (tests): python3 nt-status.pyw --headless
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 47321
STALE_S = 20  # no word from an account for this long: "Not running"

statuses = {}  # profile id -> {"name", "status", "tone", "at"}
lock = threading.Lock()


def snapshot():
    """The rows to show, oldest-seen name first, with stale ones marked."""
    now = time.time()
    with lock:
        rows = []
        for key, s in statuses.items():
            gone = now - s["at"] > STALE_S
            rows.append(
                {
                    "id": key,
                    "name": s["name"],
                    "status": "Not running" if gone else s["status"],
                    "tone": "gone" if gone else s["tone"],
                    "muted": False if gone else s.get("muted", False),
                    "age": round(now - s["at"]),
                }
            )
    return sorted(rows, key=lambda r: r["name"].lower())


def allowed_origin(origin):
    # Only Nitro Type pages (or tools without an Origin, like curl) may report.
    if not origin:
        return True
    return origin.startswith("https://") and (origin.endswith("://nitrotype.com") or origin.endswith(".nitrotype.com"))


class Handler(BaseHTTPRequestHandler):
    def _send(self, code=200, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        if self.path.startswith("/statuses"):
            self._send(200, json.dumps(snapshot()).encode())
        else:
            self._send(200, b"NT Autotyper status helper is running", "text/plain")

    def do_POST(self):
        if not self.path.startswith("/status"):
            return self._send(404)
        if not allowed_origin(self.headers.get("Origin", "")):
            return self._send(403)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 4096:
            return self._send(413)
        try:
            data = json.loads(self.rfile.read(length))
            key = str(data.get("id") or "")[:64]
        except (ValueError, AttributeError):
            return self._send(400)
        if not key:
            return self._send(400)
        tone = str(data.get("tone") or "idle")[:12]
        with lock:
            statuses[key] = {
                "name": str(data.get("name") or "Nitro Type")[:40],
                "status": str(data.get("status") or "")[:40],
                "tone": tone if tone in TONES else "idle",
                "muted": bool(data.get("muted")),
                "at": time.time(),
            }
        self._send(200, b'{"ok":true}')

    def log_message(self, *args):
        pass  # quiet


# dot colour per tone; "paused" = needs you (captcha, logged out, stuck)
TONES = {
    "typing": "#3ddc84",
    "waiting": "#f5c451",
    "break": "#9cc3ff",
    "done": "#3ddc84",
    "idle": "#6b7aa8",
    "paused": "#ff5c6c",
    "gone": "#4a5170",
}
BG = "#10152a"
ALERT_BG = "#4a1520"


# ---- sounds ---------------------------------------------------------------
ALERT_REPEAT_S = 60
ALERT_MAX = 5
sound = {"on": True, "bell": None}  # bell: the window's beep, where there's no system sound
said = {}  # account id -> {"tone", "alerts", "last"}


def play(kind, name=""):
    """kind: "alert" (needs you) or "soft" (done, stopped running)."""
    if not sound["on"]:
        return
    if "--headless" in sys.argv:
        print(f"sound: {kind} {name}", flush=True)
        return
    try:
        if sys.platform.startswith("win"):
            import winsound

            winsound.MessageBeep(winsound.MB_ICONHAND if kind == "alert" else winsound.MB_ICONASTERISK)
        elif sys.platform == "darwin":
            import subprocess

            subprocess.Popen(["afplay", "/System/Library/Sounds/" + ("Sosumi.aiff" if kind == "alert" else "Glass.aiff")])
        elif sound["bell"]:
            sound["bell"]()
    except Exception:
        pass


def sounds_for(rows):
    """Called every second with the current rows: plays what changed."""
    now = time.time()
    for r in rows:
        if r.get("id") is None:
            continue
        before = said.get(r["id"])
        tone = r["tone"]
        if tone == "paused":
            if not before or before["tone"] != "paused":
                said[r["id"]] = {"tone": tone, "alerts": 1, "last": now}
                play("alert", r["name"])
            elif before["alerts"] < ALERT_MAX and now - before["last"] >= ALERT_REPEAT_S:
                before.update(alerts=before["alerts"] + 1, last=now)
                play("alert", r["name"])
            continue
        if before and before["tone"] != tone and tone in ("done", "gone"):
            play("soft", r["name"])
        said[r["id"]] = {"tone": tone, "alerts": 0, "last": now}


def start_server():
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        return None  # already running (or the port is taken)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_headless():
    print(f"NT Autotyper status helper on http://127.0.0.1:{PORT} (no window)", flush=True)
    while True:
        time.sleep(1)
        rows = snapshot()
        sounds_for(rows)
        for r in rows:
            print(f"{r['name']:<24} {r['status']}", flush=True)


def run_window():
    import tkinter as tk

    root = tk.Tk()
    root.title("NT status")
    root.overrideredirect(True)  # no title bar: just the box
    root.attributes("-topmost", True)  # above every other window
    root.configure(bg=BG)
    font_name = ("Segoe UI", 10)
    font_status = ("Segoe UI", 10, "bold")
    frame = tk.Frame(root, bg=BG, padx=10, pady=6)
    frame.pack(fill="both", expand=True)
    rows = []  # (row frame, dot canvas, name label, status label)
    state = {"moved": False, "flash": False, "drag": None}

    def place():
        root.update_idletasks()
        if state["moved"]:
            return
        w, h = root.winfo_reqwidth(), root.winfo_reqheight()
        x = root.winfo_screenwidth() - w - 12
        y = root.winfo_screenheight() - h - 56  # above the taskbar
        root.geometry(f"+{x}+{y}")

    sound["bell"] = root.bell

    def refresh():
        data = snapshot()
        sounds_for(data)
        data = data or [{"name": "Waiting for Nitro Type…", "status": "", "tone": "idle"}]
        state["flash"] = not state["flash"]
        if len(rows) != len(data):
            for r in rows:
                r[0].destroy()
            rows.clear()
            for _ in data:
                row = tk.Frame(frame, bg=BG)
                row.pack(fill="x", pady=2)
                dot = tk.Canvas(row, width=10, height=10, bg=BG, highlightthickness=0)
                dot.create_oval(1, 1, 9, 9, fill="#6b7aa8", outline="", tags="d")
                dot.pack(side="left", padx=(0, 8))
                name = tk.Label(row, font=font_name, fg="#8e9cc9", bg=BG, anchor="w")
                name.pack(side="left")
                status = tk.Label(row, font=font_status, fg="#e8edff", bg=BG, anchor="e")
                status.pack(side="right", padx=(16, 0))
                for widget in (row, dot, name, status):
                    bind_drag(widget)
                rows.append((row, dot, name, status))
        for (row, dot, name, status), r in zip(rows, data):
            alert = r["tone"] == "paused"
            bg = ALERT_BG if alert and state["flash"] else BG
            for widget in (row, dot, name, status):
                widget.configure(bg=bg)
            dot.itemconfigure("d", fill=TONES.get(r["tone"], TONES["idle"]))
            name.configure(text=r["name"], fg="#ffd0d5" if alert else ("#5a6283" if r["tone"] == "gone" else "#8e9cc9"))
            # 🔇: that profile's page can't make sound until it's clicked (this box still can)
            status.configure(text=("🔇 " if r.get("muted") else "") + r["status"], fg="#7d86a6" if r["tone"] == "gone" else "#e8edff")
        # Grew or shrank (a new account, a longer status): back into the corner.
        root.update_idletasks()
        size = (root.winfo_reqwidth(), root.winfo_reqheight())
        if size != state.get("size"):
            state["size"] = size
            place()
        root.after(1000, refresh)

    def bind_drag(widget):
        widget.bind("<ButtonPress-1>", lambda e: state.update(drag=(e.x_root - root.winfo_x(), e.y_root - root.winfo_y())))
        widget.bind("<B1-Motion>", on_drag)
        widget.bind("<Button-3>", show_menu)
        widget.bind("<Button-2>", show_menu)  # right-click on some Macs

    def on_drag(e):
        if not state["drag"]:
            return
        dx, dy = state["drag"]
        state["moved"] = True
        root.geometry(f"+{e.x_root - dx}+{e.y_root - dy}")

    menu = tk.Menu(root, tearoff=0)
    sound_on = tk.BooleanVar(value=True)
    menu.add_checkbutton(label="Sound", variable=sound_on, command=lambda: sound.update(on=sound_on.get()))
    menu.add_command(label="Back to the corner", command=lambda: (state.update(moved=False), place()))
    menu.add_command(label="Quit", command=root.destroy)

    def show_menu(e):
        menu.tk_popup(e.x_root, e.y_root)

    bind_drag(frame)
    refresh()
    root.mainloop()


def main():
    if start_server() is None:
        print(f"Port {PORT} is busy: the helper is probably already running.", flush=True)
        if "--headless" not in sys.argv:
            try:
                import tkinter.messagebox as mb

                mb.showinfo("NT status", "The NT Autotyper status helper is already running.")
            except Exception:
                pass
        return
    if "--headless" in sys.argv:
        run_headless()
    else:
        run_window()


if __name__ == "__main__":
    main()
