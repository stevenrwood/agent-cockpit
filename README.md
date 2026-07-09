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

## Known open work (next slices)

- Tier-2 drivers (native non-Claude agents) — **parked** for now. Tier-1 (route a session to
  a local/OpenAI-compatible model via a gateway using per-session `baseURL`) already works;
  target for a local LLM on Apple Silicon via a LiteLLM Anthropic-passthrough proxy.
- Context-% is best-effort (last-turn input tokens vs model window); wire a truer measure.
- Auth/hardening: currently localhost-only, no auth; fine for a single local operator.
- Repo path must be the OS-native form (e.g. `C:/github/ioSender`), which is what the UI
  form expects — git is invoked with it directly.
- Integration worktrees are created lazily and kept across the process lifetime; they aren't
  auto-garbage-collected. Prune with `git worktree remove` + delete `cockpit/int/<base>` when
  done, or wire a cockpit teardown.
