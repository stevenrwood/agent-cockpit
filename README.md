# Agent Cockpit

Mission control for running **parallel Claude Code sessions** you can actually see and
steer. You converse with a **dispatcher chat** to plan the work, spawn worker sessions
that each run isolated in their own **git worktree**, and watch a live card per session
with token/cost/context telemetry that **flashes red when one needs your input** (a
tool-permission gate) — so running many agents is manageable instead of a blur. A
flyout **terminal** is a keystroke away (Ctrl+`) for the occasional manual command.

This is idea #3 of a three-part arc (after the WPF UI test server and the behavioral
log-mining). Both prerequisites are in place; this makes parallelism tolerable.

## Status — thin proof slice (self-verified 2026-07-09)

One session, end-to-end, driven entirely through the HTTP API against a live Claude
session:

- spawn → **git worktree** created off the target repo's HEAD on branch `cockpit/<id>`
- Claude Agent SDK session runs in that worktree (`cwd`), real Claude call
- agent hits a **Bash** permission gate → session enters `awaiting-input` → **card flashes**
- operator **Allow** via the API → session resumes → returns the seeded answer
- live telemetry: turns, tokens in/out, cost, model, `providerSessionId`, context used/window
- **follow-up messages** on a live session (streaming input stays open) → multi-turn
- **remove** → worktree torn down

## Architecture — a provider-agnostic seam

The **shell** (session registry, telemetry cards, flash-on-input, worktree isolation,
SSE) talks only to the `SessionDriver` interface (`src/types.ts`). Nothing in the shell
is Claude-specific.

- `src/drivers/claudeAgent.ts` — the Claude Agent SDK driver (shipped).
- **Tier-1 provider swap** works today: per-session `model` + `baseURL` point the same
  Claude Code harness at an OpenAI-compatible gateway (LiteLLM) or a local model (Ollama's
  Anthropic-compat endpoint), keeping every cockpit feature (telemetry, the permission
  flash, worktree isolation). `env` is set per-query, so concurrent sessions can target
  different providers.
- **Tier-2** (native GPT/Gemini agents, or CLI agents like aider) = additional drivers
  implementing the same interface. Not built yet.

```
Browser UI ──SSE/REST──▶ server.ts ──▶ SessionManager (worktrees + registry)
                                              │  onChange → SSE broadcast
                                              ▼
                                   SessionDriver (interface)
                                              │
                                   ClaudeAgentDriver  ── query() ── Claude Code harness
                                     canUseTool ──▶ pending permission ──▶ UI flash
```

## Run

Requires Node 22+ and a working Claude Code login (the Agent SDK uses ambient auth).

```sh
npm install
npm start                 # → http://127.0.0.1:8770   (COCKPIT_PORT to change)
```

The top area is the **dispatcher chat** (see below). Hit **＋ Spawn session** to drop the
spawn form, give a goal and a repo path (e.g. `c:\github\ioSender`); the session gets its
own worktree and appears as a card below. When a card flashes, click **Allow** / **Deny**.

## Dispatcher chat

The default top area is a persistent conversational **dispatcher** session you talk to —
your mission-control brain (`src/dispatcher.ts`). It runs in the base repo (no worktree),
scoped by a custom system prompt to **plan, decompose, and track** work: it drafts crisp
briefs you paste into **＋ Spawn session**, but it does **not** spawn or drive workers
itself (conversational-only by design). Its header shows the same telemetry as worker
cards (status, turns, tokens, cost, model, context meter).

- **One logical permanent session** that **auto-recycles its model context at ~80%**
  (`COCKPIT_CTX_RESET`) so it stays fast over a long session — the on-screen transcript
  survives, and the fresh context is seeded with a short continuity summary. **↺ New chat**
  recycles it manually.
- Runs with **bypass** permissions so the chat never stalls on a flash; it can Read/Grep
  the base repo to answer questions.

### Two-stage autocorrect submit

The chat input is a multiline box; **Enter inserts a newline** (it never submits on plain
Enter). Submitting is a two-step, typo-forgiving flow (`src/autocorrect.ts`, a fast Haiku
clean-only pass):

- **Single ↑ / Ctrl+Enter** → runs your draft through the autocorrect and **refills the box**
  with the cleaned text (typos/transposition/punctuation only — meaning, tone, and code
  tokens preserved; it never answers or acts on the text). Nothing is sent yet.
- **↑ again** → sends the cleaned text to the dispatcher. Editing after a clean reverts to
  "fresh" so a single ↑ re-cleans; the **↑ turns green** when the draft is ready to send.
- **Double-click ↑** → send as typed, skipping the autocorrect.

## Flyout terminal

A persistent shell in the base repo for the occasional manual command (`src/terminal.ts`) —
**not** a full PTY (no cursor addressing; ANSI/CR are stripped for the plain-text pane), but
a long-lived piped shell with persistent cwd + env and **zero native dependencies**.

- Toggle with the **▸_ Terminal** button or **Ctrl+`**; dismiss with **✕**, **Escape**, or
  the toggle. Hiding only slides it away — the shell keeps running and scrollback is kept.
- **Shell picker: cmd / bash / powershell** (default `cmd`, `COCKPIT_SHELL` overrides;
  remembered per browser). **↺ restart** kills and respawns the shell (also how you switch).
- Output is bottom-anchored above the input; **up/down** recall command history; typing is
  captured at the panel level so it's robust to focus.

## Build & Run — repo-defined via `.cockpit.json`

The cockpit has **no built-in notion** of what "build", "run", or "test" mean — it never
guesses a repo-specific command. A repo opts in by committing an arbitrary `{label: command}`
map as `.cockpit.json` at its root, e.g.:

```json
{
  "Test (Debug)":   "powershell -NoProfile -ExecutionPolicy Bypass -File .\\build.ps1 -Configuration Debug -Launch",
  "Test (Release)": "powershell -NoProfile -ExecutionPolicy Bypass -File .\\build.ps1 -Configuration Release -Launch"
}
```

Any number of entries (up to 8) with any labels are allowed — a repo defines exactly the
actions that make sense to it. The worker card shows one button per entry, in file order —
**no manifest, no buttons.** Read once from the session's **worktree** at spawn time (so a
branch that edits `.cockpit.json` is honored), clicking a button opens that session's own
terminal and runs its command there.

## Per-session terminal

Every worker card has **▸_ Term** — a persistent shell rooted in *that session's
worktree* (separate from the header's base-repo terminal). Same shell picker
(cmd/bash/powershell), same bottom-anchored output + history recall. Useful for
anything the manifest buttons don't cover, or for poking around a branch by hand.

## HTTP API

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/` | — | Cockpit UI |
| GET | `/api/state` | — | Snapshot of all sessions |
| GET | `/api/events` | — | SSE stream of snapshots |
| POST | `/api/sessions` | `{repo, goal, model?, baseURL?, apiKey?, permissionMode?}` | Spawn a session |
| POST | `/api/sessions/:id/permission` | `{permissionId, allow, message?}` | Answer a flash |
| POST | `/api/sessions/:id/message` | `{text}` | Follow-up message |
| POST | `/api/sessions/:id/interrupt` | — | Interrupt the agent |
| DELETE | `/api/sessions/:id` | — | Dispose + remove worktree |
| GET | `/api/terminal/:id/events` | — | SSE: terminal output `{chunk}` (`:id` = `base` or a session id) |
| POST | `/api/terminal/:id/input` | `{data}` | Run a line in that terminal |
| POST | `/api/terminal/:id/reset` | `{shell?}` | Restart that shell (optionally switch cmd/bash/powershell) |
| GET | `/api/chat/events` | — | SSE: dispatcher `{state, transcript}` |
| POST | `/api/chat/message` | `{text}` | Send a message to the dispatcher |
| POST | `/api/chat/autocorrect` | `{text}` | Clean-only typo pass → `{cleaned}` |
| POST | `/api/chat/reset` | — | Recycle the dispatcher context (transcript kept) |

## Merge sequencing (shipped)

N parallel branches WILL conflict, and merging one changes the base for the rest. The
cockpit makes this visible and drives it safely:

- **Per-session merge status** (`src/git.ts`): base branch, ahead/behind counts, whether
  the worktree is dirty, and an accurate **conflict preflight** — computed by checking out
  the base in a throwaway detached worktree and doing a real trial merge (works on any git;
  no 2.38 `merge-tree --write-tree` dependency), then discarded. Cached; recompute with
  **↻ Check all merges** or per-card.
- **Dedicated integration worktree**: merges never touch your main checkout. The cockpit
  owns a per-base **integration branch** `cockpit/int/<base>` in its own worktree
  (`worktrees/_int/…`), created at the base tip on first merge. **Merge → \<integration\>**
  merges a session's branch there, then **recomputes every sibling** — so a branch that was
  clean flips to `conflict` the moment an overlapping branch lands ahead of it (the whole
  point). Preflight and ahead/behind are measured against the integration branch once it
  exists, so sequencing shows through.
- **Conflict handling**: isolated in the integration worktree — your main tree stays clean
  and on its branch throughout. **Open integration** opens that worktree in VS Code to
  resolve; **Abort merge** rolls it back. A second merge is refused while a conflict is
  unresolved.
- **Promote → \<base\>**: when the integration branch looks good, fast-forward the real base
  up to it (guarded: main checkout must be clean and on the base). Because the integration
  branch is base + merge commits, this is a clean fast-forward.

Verified end-to-end: two branches clean alone → merge A into integration (**main tree
untouched** — base ref, files, and cleanliness all unchanged) → B auto-flips to conflict vs
the integration branch → merge B conflicts inside the integration worktree (main tree still
clean, not mid-merge) → second merge refused → Abort recovers → Promote fast-forwards the
base up to the merged result.

## Open in VS Code (shipped)

Per-session **⧉ VS Code** button opens that worktree in a new window (`code -n <worktree>`,
`COCKPIT_EDITOR` overrides) so you can dive in and take over manually.

## Teardown (shipped)

Graceful shutdown removes every cockpit worktree (session + integration) and deletes the
`worktrees/` directory, while **keeping all branches** (your work and any accumulated
integration merges survive). Triggered by:

- **⏻ Shutdown** button in the header, or `POST /api/shutdown`
- Ctrl+C / `SIGINT` / `SIGTERM` in the terminal running the server

A worktree still open in an external editor may resist deletion on Windows (an expected OS
lock) — the git worktree is unregistered regardless; the empty directory can be removed once
the editor releases it.

## Context meter

Each card shows a color-coded context meter (green < 70%, amber < 70–90%, red ≥ 90%). The
window is set immediately from the model on session init and overridden with the SDK's exact
`modelUsage.contextWindow` on the first result; occupancy is the most recent request's
input + cache tokens (current context, not cumulative billing), and a compaction (`↺`) drops
it naturally.

## Remote access from your phone (Tailscale)

The server only ever binds to loopback by default (`127.0.0.1`, no auth — see CLAUDE.md).
To check on sessions from your phone over your own [Tailscale](https://tailscale.com)
tailnet (never the public internet):

```sh
.\cockpit.ps1 -Tailscale        # binds to this PC's Tailscale IP instead of loopback
```

**One-time setup**, in an **elevated** PowerShell (Run as Administrator):

```powershell
New-NetFirewallRule -DisplayName 'Agent Cockpit (Tailscale)' -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8770 -InterfaceAlias 'Tailscale' -Profile Any
```

This scopes the allow rule to the Tailscale virtual adapter only — it does **not** open
anything on your real LAN/Wi-Fi NIC. Then, from your phone (with the Tailscale app signed
into the same account), browse to `http://<this-pc-tailscale-ip>:8770` (find the IP with
`tailscale ip -4` or `tailscale status`). To remove the rule later:
`Remove-NetFirewallRule -DisplayName 'Agent Cockpit (Tailscale)'`.

## Known open work (next slices)

- Tier-2 drivers (native non-Claude agents) — **parked** for now. Tier-1 (route a session to
  a local/OpenAI-compatible model via a gateway using per-session `baseURL`) already works;
  target for a local LLM on Apple Silicon via a LiteLLM Anthropic-passthrough proxy.
- Auth/hardening: currently localhost-only, no auth; fine for a single local operator.
- Repo path must be the OS-native form (e.g. `C:/github/ioSender`), which is what the UI
  form expects — git is invoked with it directly.
