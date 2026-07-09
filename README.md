# Agent Cockpit

Mission control for running **parallel Claude Code sessions** you can actually see and
steer. Claude acts as a dispatcher — you spawn work sessions, each isolated in its own
**git worktree**, and the cockpit shows a live card per session with token/cost/context
telemetry that **flashes red when a session needs your input** (a tool-permission gate),
so running many agents is manageable instead of a blur.

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

Open the URL, then **Spawn session** with a goal and a repo path (e.g.
`c:\github\ioSender`). The session gets its own worktree; watch the card. When it flashes,
click **Allow** / **Deny**.

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

## Known open work (next slices)

- **Merge sequencing** — N parallel branches WILL conflict; the dispatcher must own
  sequencing merges back to the integration branch. The cockpit makes it visible but does
  not solve it yet. This is the genuinely hard part.
- "Open in VS Code" button per worktree (take over manually on demand).
- Tier-2 drivers (native non-Claude agents).
- Context-% is best-effort (last-turn input tokens vs model window); wire a truer measure.
- Auth/hardening: currently localhost-only, no auth; fine for a single local operator.
