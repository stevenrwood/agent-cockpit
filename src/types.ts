// Provider-agnostic contracts for the cockpit.
//
// The cockpit shell (registry, telemetry cards, flash-on-input, worktrees) talks
// ONLY to the SessionDriver interface below. The Claude Agent SDK is one driver
// (src/drivers/claudeAgent.ts). Other providers (OpenAI-compatible gateways,
// native GPT/Gemini agents, CLI agents) become additional drivers later — nothing
// in the shell is Claude-specific.

export type SessionStatus =
  | 'starting' // spawning / first message in flight
  | 'running' // agent actively working
  | 'awaiting-input' // blocked on a human decision (THIS is the flash)
  | 'idle' // turn complete, session alive, awaiting next message
  | 'done' // input closed, finished
  | 'interrupted'
  | 'error';

export interface PendingPermission {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: number;
}

/** One line in a session's conversation log (chat window / future card transcript). */
export interface ChatEntry {
  role: 'user' | 'assistant' | 'tool' | 'system';
  ts: number;
  text?: string; // user/assistant/system prose
  tool?: string; // role === 'tool': the tool name
  toolInput?: Record<string, unknown>; // role === 'tool': its input (compact)
}

/** Live per-session state a driver exposes to the shell. */
export interface DriverState {
  provider: string;
  model?: string;
  providerSessionId?: string;
  permissionPolicy?: 'ask' | 'acceptEdits' | 'bypass'; // live, changeable per session
  status: SessionStatus;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  contextWindow?: number; // max tokens the model can hold
  contextUsed?: number; // best-effort: tokens in context on the last turn
  lastText?: string; // most recent assistant text (card preview)
  resultText?: string; // the agent's final result text (set when a turn completes)
  finishedAt?: number; // ms epoch of the last completed turn (enables the Results view)
  pending?: PendingPermission; // set iff status === 'awaiting-input'
  error?: string;
}

export interface DriverStartOptions {
  goal?: string; // initial user message; omit to open the session idle (chat dispatcher)
  primeText?: string; // silent priming message (logged as system) — used to seed a post-reset session
  cwd: string; // the git worktree this session works in
  model?: string;
  baseURL?: string; // Tier-1: point the harness at a gateway (LiteLLM/Ollama/...)
  apiKey?: string; // optional per-session key for that gateway
  systemPrompt?: string; // custom system prompt (dispatcher role); omit to use the default preset
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  // Cockpit-side auto-approval policy (independent of the SDK permissionMode).
  // canUseTool stays active so the cockpit remains the source of truth; this
  // just decides which requests the cockpit answers itself vs. flashes for you.
  //   'ask'         — flash + wait for Allow/Deny on everything (most oversight)
  //   'acceptEdits' — cockpit auto-approves file-edit tools; flashes for the rest
  //   'bypass'      — cockpit auto-approves everything (no flashing)
  permissionPolicy?: 'ask' | 'acceptEdits' | 'bypass';
}

export interface PermissionDecision {
  allow: boolean;
  message?: string; // guidance shown to the agent on deny
}

/**
 * A driver runs one agent session and reports state changes via the `onChange`
 * callback passed to its constructor. Everything is provider-agnostic.
 */
export interface SessionDriver {
  readonly provider: string;
  getState(): DriverState;
  /** The full conversation log accumulated so far (chat window). */
  getTranscript(): ChatEntry[];
  start(opts: DriverStartOptions): void;
  sendMessage(text: string): void;
  answerPermission(permissionId: string, decision: PermissionDecision): boolean;
  /** Change the auto-approval policy on a live session. */
  setPolicy(policy: 'ask' | 'acceptEdits' | 'bypass'): void;
  interrupt(): Promise<void>;
  /** Close the input stream and tear the session down. */
  dispose(): void;
}

export interface MergeStatus {
  baseBranch: string; // the ultimate base this session came off
  targetBranch: string; // where merges actually land: the integration branch (or base until it exists)
  ahead: number; // commits on this branch not yet in target
  behind: number; // commits in target not in this branch
  dirty: boolean; // uncommitted changes in the session worktree
  preview: 'clean' | 'conflict' | 'up-to-date' | 'unknown';
  conflictFiles: string[];
  checkedAt: number;
  merging: boolean; // a conflicted merge of THIS branch is live in the main tree
}

/** Shell-level record: worktree/meta + a live snapshot of the driver's state. */
export interface SessionSnapshot extends DriverState {
  id: string;
  goal: string;
  repo: string;
  branch: string;
  baseBranch: string;
  cwd: string;
  baseURL?: string;
  createdAt: number;
  merge?: MergeStatus;
}
