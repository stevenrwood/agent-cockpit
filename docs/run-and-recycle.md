# Playbook — run & recycle Agent Cockpit

One entry point: **`.\cockpit.ps1`** (from the repo root).

| Command | Does |
|---|---|
| `.\cockpit.ps1` | Start the server if it isn't up, then open a **standalone Edge window** (`--app=`, no tabs/omnibox). |
| `.\cockpit.ps1 open` | Just open the standalone window (server already running). |
| `.\cockpit.ps1 restart` | Kill whatever is listening on the port, start fresh, reopen. |
| `.\cockpit.ps1 stop` | Kill the server on the port. |

Port = `$env:COCKPIT_PORT` or `8770`.

## The recycle rule (what to do after an edit)

The server reads `public/index.html` **fresh on every request**
([`src/server.ts`](../src/server.ts) `readFileSync` inside the handler), so:

- **Front-end change** — anything under `public/` (HTML/CSS/JS): **just hard-refresh the
  window** (`Ctrl+F5`). No server restart.
- **Backend change** — anything under `src/*.ts` (server, sessionManager, drivers, git):
  **`.\cockpit.ps1 restart`**. `tsx` has no hot-reload. (Alternatively run the server with
  `npm run dev` = `tsx watch` and it auto-restarts on `src/` changes.)

## Standalone window

`msedge --app=<url>` opens a chromeless app window — the closest thing to a native window
without packaging. If you'd rather use a normal browser tab, just open `http://127.0.0.1:8770`.
A true native shell (Electron/Tauri/WebView2) is a future option, not built.

## Spawn-form conveniences

- **Goal / instructions** is the big multi-line box — it's the literal prompt the session
  starts with. Paste the full brief there.
- **Repo path** defaults to the last repo you spawned into (remembered in `localStorage`),
  falling back to `c:\github\ioSender`.
- **Model** is a dropdown with a one-line "when it's best" hint per model; leaving it on
  *Default* inherits the cockpit's model.
