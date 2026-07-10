# Agent Cockpit — guide for Claude

You are being asked to deploy, run, or extend **Agent Cockpit**. This file is your operating
manual. Read it first, then `README.md` for the full HTTP API and design rationale.

## What this is

A local, single-operator **mission-control web app** for running several Claude Code sessions
in parallel. A human dispatches work; each session runs in its **own git worktree**, and the
cockpit shows a live card per session (status, tokens, cost, a color-coded context meter) that
**flashes when a session needs a permission decision**. It also sequences merging the parallel
branches back together through an isolated integration branch.

It is built on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), TypeScript, run with
`tsx` (no build step). It is **not** the Messages API and not Managed Agents.

## Prerequisites

- **Node 22+** and npm.
- **Claude Code authentication present** on the machine (the Agent SDK uses ambient auth — the
  same login `claude` uses). If `claude` runs interactively here, the cockpit can spawn sessions.
- **git 2.x** (2.34+ is fine; the merge preflight does not require 2.38 `merge-tree`).
- A code editor on PATH for the "Open in VS Code" button — `code` by default (`COCKPIT_EDITOR`
  overrides). Optional.

## Deploy / run

```sh
npm install
npm start            # → http://127.0.0.1:8770   (set COCKPIT_PORT to change)
```

That's it — there is no build, no database, no external service. It binds to `127.0.0.1` only
and has **no authentication** (single local operator by design — do not expose it to a network).

To verify it's up without a browser:

```sh
curl -s http://127.0.0.1:8770/api/state      # → []  (empty session list)
```

## How to use it

Open `http://127.0.0.1:8770`, or drive the HTTP API directly (see `README.md` for the full
table). The core loop:

1. **Spawn a session** — give a *goal* and a *repo path in OS-native form* (e.g.
   `C:/github/ioSender` on Windows, `/home/me/proj` on Unix). The cockpit creates a worktree on
   a new branch `cockpit/<id>` off the repo's current HEAD and starts a Claude session in it.
   `POST /api/sessions {repo, goal, model?, baseURL?}`.
2. **Answer permission flashes** — when a session's card turns red and shows a tool + input, the
   agent is blocked waiting on you. Allow or Deny.
   `POST /api/sessions/:id/permission {permissionId, allow, message?}`.
3. **Follow up / interrupt / take over** — send more messages, interrupt, or **⧉ VS Code** to
   open that worktree and work by hand.
4. **Merge sequencing** — **↻ Check all merges** computes each branch's status vs the base
   (ahead/behind, dirty, and a real conflict preflight). **Merge → \<integration\>** merges a
   branch into a cockpit-owned integration branch `cockpit/int/<base>` (in its own worktree —
   your main checkout is never touched), then recomputes every sibling so downstream conflicts
   surface. Resolve conflicts via **⧉ Open integration** + **Abort merge**. **Promote → \<base\>**
   fast-forwards the real base up to the reviewed integration branch.
5. **Shutdown** — **⏻ Shutdown** (or `POST /api/shutdown`, or Ctrl+C) tears down all cockpit
   worktrees but **keeps all branches** (work survives).

## Provider-agnostic (Tier-1 model swap)

To route a session to a non-default or local model **without changing anything else**, pass a
per-session `baseURL` (and `apiKey` if the gateway needs one). The Claude Code harness speaks the
**Anthropic** API shape, so point `baseURL` at a translating gateway:

- **Local LLM** (Ollama / LM Studio, which are OpenAI-shaped): run a **LiteLLM** proxy with an
  Anthropic `/v1/messages` passthrough → your local model, and set `baseURL` to the LiteLLM URL.
- All cockpit features (telemetry, permission flash, worktrees, merge) keep working because the
  harness is unchanged — only the model endpoint moves.

Native non-Anthropic agents (a real GPT/Gemini agent, or CLI agents like aider) would be a
**Tier-2 driver** — a new class implementing `SessionDriver`. None ship yet.

## Code map

- `src/types.ts` — the **`SessionDriver` interface** and state/snapshot types. The whole app
  talks to this; nothing in the shell is Claude-specific.
- `src/drivers/claudeAgent.ts` — the Claude Agent SDK driver: streaming input queue (kept open so
  `canUseTool` can fire), permission routing, telemetry, context meter.
- `src/sessionManager.ts` — worktree lifecycle, session registry, SSE fan-out, and all merge
  sequencing (integration worktree, merge/abort/promote, teardown).
- `src/git.ts` — non-throwing git helpers (ahead/behind, trial-merge conflict preflight,
  merge/ff/abort, worktree discovery).
- `src/server.ts` — `node:http` server: static UI + REST + SSE (`/api/events`) + shutdown/signals.
- `public/index.html` — the single-file vanilla-JS UI (cards, flash, meters, merge controls).

## Extending: add a provider driver

Implement `SessionDriver` (see `src/types.ts`) in `src/drivers/<name>.ts`: `start(opts)`,
`sendMessage`, `answerPermission`, `interrupt`, `dispose`, `getState()`, calling the constructor's
`onChange` whenever state changes. Then branch on `provider` in `SessionManager.create`. Keep the
shell untouched — it already renders any `DriverState`.

## Gotchas (read before debugging)

- **Repo paths must be OS-native** (`C:/github/x`, not MSYS `/c/github/x`) — git is invoked with
  the path verbatim.
- **`canUseTool` needs streaming input** — the driver feeds the prompt through an open async
  queue; a plain string prompt would close the stream before the permission callback could fire.
- **Merges never touch the main checkout** — they land on `cockpit/int/<base>` in a dedicated
  worktree. **Promote** is the only step that moves the real base, and it's a guarded
  fast-forward (main must be clean and on base).
- **Windows file locks** — a worktree open in an editor may resist deletion on shutdown; the git
  worktree is unregistered regardless, and the empty dir clears once the editor releases it.
- **Auth** — if sessions immediately error, the machine likely isn't logged into Claude Code.

## Self-verify a change

Don't claim a change works from a clean typecheck. Drive it: `npm start`, then via `curl` create
a session against a throwaway `git init` repo with a goal that forces a tool (e.g. "Run the shell
command `cat README.md`"), watch it reach `awaiting-input`, POST the permission allow, and confirm
it completes. For merge changes, script two sessions with conflicting commits and check that
merging one flips the other to `conflict`. Run git verification with `git -C <path>` — never `cd`
into a worktree.
