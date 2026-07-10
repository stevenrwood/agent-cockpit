import { ClaudeAgentDriver } from './drivers/claudeAgent.js';
import type { ChatEntry, DriverState } from './types.js';

// The base repo the dispatcher (and terminal) work in. The dispatcher is
// conversational — it reads/plans in this tree but spawns no worktree.
export const BASE_REPO = process.env.COCKPIT_REPO ?? 'c:\\github\\ioSender';

// Reset the underlying model context once it crosses this fraction of the
// window. One logical permanent session, but its context is recycled so it
// never slows down; the visible transcript survives across resets.
const RESET_AT = Number(process.env.COCKPIT_CTX_RESET ?? 0.8);

const DISPATCHER_SYSTEM =
  'You are the dispatcher for Agent Cockpit — the operator\'s mission-control brain. ' +
  'You help plan, decompose, and track work across parallel agent sessions, and you can read the repo to answer questions. ' +
  'You do NOT spawn or drive the worker sessions yourself — instead you PROPOSE them. ' +
  'When you propose a concrete piece of work to delegate, output the full brief as a fenced code block tagged `spawn`, like:\n' +
  '```spawn\n<a complete, self-contained brief for one worker: what to do, the key files/areas, constraints, acceptance criteria, and to read CLAUDE.md first>\n```\n' +
  'Put ONLY the worker\'s instructions inside the block — the operator gets a one-click Spawn button rendered from it, so never tell them to copy/paste. ' +
  'Use one `spawn` block per session you propose. Keep everything else concise and direct.';

/**
 * One persistent conversational session the operator chats with. Survives
 * browser refreshes; recycles its model context at the threshold (keeping the
 * on-screen transcript) so it stays fast over a long session.
 */
export class Dispatcher {
  private driver: ClaudeAgentDriver;
  private carry: ChatEntry[] = []; // transcript from prior (pre-reset) generations
  private resetting = false;
  private model?: string;

  constructor(private onChange: () => void, model?: string) {
    this.model = model;
    this.driver = this.spawn();
  }

  private spawn(primeText?: string): ClaudeAgentDriver {
    const d = new ClaudeAgentDriver(() => this.handleChange());
    // Assign BEFORE start(): start() synchronously fires onChange → handleChange,
    // which reads this.driver. Without this, the first tick hits an undefined driver.
    this.driver = d;
    d.start({
      cwd: BASE_REPO,
      model: this.model,
      primeText,
      permissionMode: 'default',
      // Conversational brain — auto-approve so the chat never stalls on a flash.
      permissionPolicy: 'bypass',
      // A custom system prompt (not the claude_code preset) keeps it lean and on-role.
      // (systemPrompt is threaded through in the driver's query options.)
      systemPrompt: DISPATCHER_SYSTEM,
    });
    return d;
  }

  private handleChange() {
    this.onChange();
    if (!this.driver) return;
    const st = this.driver.getState();
    if (
      !this.resetting &&
      st.status === 'idle' &&
      st.contextWindow &&
      st.contextUsed &&
      st.contextUsed / st.contextWindow >= RESET_AT
    ) {
      void this.autoReset();
    }
  }

  /** Recycle the model context: fold the old transcript into `carry`, seed a fresh session. */
  private async autoReset(): Promise<void> {
    this.resetting = true;
    const old = this.driver.getTranscript();
    const seed = summarize(old);
    try {
      this.driver.dispose();
    } catch {
      /* ignore */
    }
    this.carry.push(...old);
    this.driver = this.spawn(seed);
    this.resetting = false;
    this.onChange();
  }

  /** Manual reset ("New chat") — same context recycle, operator-triggered. */
  reset(): void {
    void this.autoReset();
  }

  getState(): DriverState {
    return this.driver.getState();
  }

  getTranscript(): ChatEntry[] {
    return [...this.carry, ...this.driver.getTranscript()];
  }

  sendMessage(text: string): void {
    this.driver.sendMessage(text);
  }

  dispose(): void {
    try {
      this.driver.dispose();
    } catch {
      /* ignore */
    }
  }
}

// Build a compact continuity seed from the tail of the conversation so a fresh
// session keeps the thread without re-inflating context with the whole log.
function summarize(entries: ChatEntry[]): string {
  const text = entries
    .filter((e) => (e.role === 'user' || e.role === 'assistant') && e.text)
    .slice(-8)
    .map((e) => `${e.role === 'user' ? 'Operator' : 'You'}: ${clip(e.text!, 600)}`)
    .join('\n');
  return (
    'This is a continuation of an ongoing conversation whose context was recycled to stay fast. ' +
    'Here is a summary of the recent exchange for continuity — do not re-answer it, just carry it forward silently and reply "Ready." only:\n\n' +
    text
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
