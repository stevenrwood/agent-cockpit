import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  DriverState,
  DriverStartOptions,
  PermissionDecision,
  SessionDriver,
} from '../types.js';

// Minimal push-based async input queue. Keeping the input stream OPEN is what
// lets `canUseTool` fire (a finite string prompt closes the stream before the
// callback can run) and lets us feed follow-up messages into a live session.
class InputQueue {
  private buffered: any[] = [];
  private resolver: ((r: IteratorResult<any>) => void) | null = null;
  private closed = false;

  push(text: string) {
    const msg = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    if (this.resolver) {
      this.resolver({ value: msg, done: false });
      this.resolver = null;
    } else {
      this.buffered.push(msg);
    }
  }

  close() {
    this.closed = true;
    if (this.resolver) {
      this.resolver({ value: undefined, done: true });
      this.resolver = null;
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.buffered.length) {
        yield this.buffered.shift();
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<any>>((res) => (this.resolver = res));
      if (r.done) return;
      yield r.value;
    }
  }
}

type PendingResolver = (result: any) => void;

export class ClaudeAgentDriver implements SessionDriver {
  readonly provider = 'claude';

  private state: DriverState = {
    provider: 'claude',
    status: 'starting',
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  private input = new InputQueue();
  private q: Query | null = null;
  private abort = new AbortController();
  private permCounter = 0;
  private pending = new Map<string, PendingResolver>();
  private policy: 'ask' | 'acceptEdits' | 'bypass' = 'ask';
  private cumOutput = 0; // running sum of output tokens across the session (live)

  constructor(private onChange: () => void) {}

  getState(): DriverState {
    return { ...this.state };
  }

  private set(patch: Partial<DriverState>) {
    this.state = { ...this.state, ...patch };
    this.onChange();
  }

  start(opts: DriverStartOptions): void {
    // Tier-1 provider swap: point the Claude Code harness at a gateway without
    // touching global process.env — `env` is per-query in the SDK.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (opts.baseURL) env.ANTHROPIC_BASE_URL = opts.baseURL;
    if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;

    this.policy = opts.permissionPolicy ?? 'ask';

    this.q = query({
      prompt: this.input as any,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        env,
        permissionMode: opts.permissionMode ?? 'default',
        // Load nothing from disk — the cockpit is the source of truth for
        // permissions, so every non-trivial tool routes through canUseTool.
        settingSources: [],
        includePartialMessages: false,
        canUseTool: (toolName: string, input: Record<string, unknown>) =>
          this.requestPermission(toolName, input),
        abortController: this.abort,
      } as any,
    });

    this.input.push(opts.goal);
    this.set({ status: 'running', model: opts.model });
    this.consume().catch((err) => {
      this.set({ status: 'error', error: String(err?.message ?? err) });
    });
  }

  private requestPermission(toolName: string, input: Record<string, unknown>): Promise<any> {
    // Cockpit-side auto-approval: keep canUseTool active (so the cockpit is the
    // sole permission authority) but answer edit-class (or all) tools ourselves
    // instead of flashing. Everything else still routes to the operator.
    if (this.shouldAutoApprove(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const id = `p${++this.permCounter}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.set({
        status: 'awaiting-input',
        pending: { id, toolName, input, createdAt: Date.now() },
      });
    });
  }

  private shouldAutoApprove(toolName: string): boolean {
    if (this.policy === 'bypass') return true;
    if (this.policy === 'acceptEdits') return EDIT_TOOLS.has(toolName);
    return false;
  }

  answerPermission(permissionId: string, decision: PermissionDecision): boolean {
    const resolve = this.pending.get(permissionId);
    if (!resolve) return false;
    this.pending.delete(permissionId);
    if (decision.allow) {
      resolve({ behavior: 'allow', updatedInput: this.state.pending?.input ?? {} });
    } else {
      resolve({ behavior: 'deny', message: decision.message ?? 'Denied by operator.' });
    }
    this.set({ status: 'running', pending: undefined });
    return true;
  }

  sendMessage(text: string): void {
    this.input.push(text);
    this.set({ status: 'running' });
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch {
      /* ignore */
    }
    this.set({ status: 'interrupted', pending: undefined });
  }

  dispose(): void {
    this.input.close();
    try {
      this.abort.abort();
    } catch {
      /* ignore */
    }
    // The Query object has no public close(); aborting the controller (above)
    // and closing the input stream tears it down.
    if (this.state.status !== 'error' && this.state.status !== 'interrupted') {
      this.set({ status: 'done', pending: undefined });
    }
  }

  private async consume(): Promise<void> {
    if (!this.q) return;
    for await (const msg of this.q) {
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            // Provisional window from the model id so the meter shows on turn 1;
            // the exact value from modelUsage overrides it on the first result.
            this.set({
              providerSessionId: msg.session_id,
              model: msg.model,
              contextWindow: this.state.contextWindow ?? windowForModel(msg.model),
            });
          } else if (msg.subtype === 'compact_boundary') {
            // Context was summarized — occupancy drops; the next turn's usage
            // reflects it. Note it so the operator isn't surprised by the dip.
            this.set({ lastText: '↺ context compacted' });
          }
          break;

        case 'assistant': {
          const text = extractText(msg.message?.content);
          const usage = msg.message?.usage;
          // Live telemetry: a `result` only lands at end-of-turn, so update the
          // token/context figures off every assistant message — otherwise a long
          // "still thinking" turn shows 0 tokens the whole time. Output is a
          // running sum (each call emits new output); input is the latest call's
          // prompt size (summing it would double-count the growing context).
          const contextUsed = usage
            ? (usage.input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0)
            : this.state.contextUsed;
          if (usage?.output_tokens) this.cumOutput += usage.output_tokens;
          this.set({
            status: 'running',
            lastText: text || this.state.lastText,
            contextUsed,
            inputTokens: usage?.input_tokens ?? this.state.inputTokens,
            outputTokens: this.cumOutput || this.state.outputTokens,
          });
          break;
        }

        case 'result': {
          const modelName = Object.keys(msg.modelUsage ?? {})[0];
          const mu = modelName ? msg.modelUsage[modelName] : undefined;
          const finalText = msg.subtype === 'success' ? msg.result : undefined;
          // turns/cost/window are authoritative here; token counts are left as
          // the live cumulative from assistant messages (don't clobber them).
          this.set({
            status: 'idle', // turn complete; session stays alive for follow-ups
            turns: msg.num_turns,
            costUsd: msg.total_cost_usd,
            contextWindow: mu?.contextWindow ?? this.state.contextWindow,
            lastText: finalText || this.state.lastText,
            resultText: finalText || this.state.resultText,
            finishedAt: Date.now(),
            error: msg.subtype !== 'success' ? msg.subtype : this.state.error,
          });
          break;
        }
      }
    }
    // Input stream closed and generator finished.
    if (this.state.status !== 'error' && this.state.status !== 'interrupted') {
      this.set({ status: 'done', pending: undefined });
    }
  }
}

// File-mutating tools the 'acceptEdits' policy auto-approves. Bash is
// deliberately excluded — it can do anything, so it still flashes.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Best-known context windows for current models (authoritative value still
// arrives from the SDK's modelUsage on the first result and overrides this).
function windowForModel(model?: string): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (/opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(m)) return 1_000_000;
  if (/opus-4-5|sonnet-4-5|haiku/.test(m)) return 200_000;
  return 200_000;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('')
    .trim();
}
