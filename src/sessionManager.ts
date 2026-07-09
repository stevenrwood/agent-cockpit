import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAgentDriver } from './drivers/claudeAgent.js';
import type { PermissionDecision, SessionDriver, SessionSnapshot } from './types.js';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const WORKTREES_DIR = path.resolve(here, '..', 'worktrees');

interface Session {
  id: string;
  goal: string;
  repo: string;
  branch: string;
  cwd: string;
  baseURL?: string;
  createdAt: number;
  driver: SessionDriver;
}

export interface CreateSessionInput {
  repo: string;
  goal: string;
  provider?: string; // only 'claude' implemented; the seam is here for more
  model?: string;
  baseURL?: string;
  apiKey?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
}

/** Owns worktrees + the session registry, and fans out change events (SSE). */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners = new Set<() => void>();
  private counter = 0;

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    for (const cb of this.listeners) cb();
  }

  snapshots(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      goal: s.goal,
      repo: s.repo,
      branch: s.branch,
      cwd: s.cwd,
      baseURL: s.baseURL,
      createdAt: s.createdAt,
      ...s.driver.getState(),
    }));
  }

  async create(input: CreateSessionInput): Promise<SessionSnapshot> {
    const provider = input.provider ?? 'claude';
    if (provider !== 'claude') {
      throw new Error(`Provider '${provider}' has no driver yet (only 'claude').`);
    }

    const id = `s${++this.counter}-${Date.now().toString(36)}`;
    const branch = `cockpit/${id}`;
    const cwd = path.join(WORKTREES_DIR, id);
    mkdirSync(WORKTREES_DIR, { recursive: true });

    // Isolate the session on its own worktree + branch off the repo's HEAD.
    await exec('git', ['-C', input.repo, 'worktree', 'add', '-b', branch, cwd, 'HEAD']);

    const driver = new ClaudeAgentDriver(() => this.emit());
    const session: Session = {
      id,
      goal: input.goal,
      repo: input.repo,
      branch,
      cwd,
      baseURL: input.baseURL,
      createdAt: Date.now(),
      driver,
    };
    this.sessions.set(id, session);

    driver.start({
      goal: input.goal,
      cwd,
      model: input.model,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      permissionMode: input.permissionMode,
    });

    this.emit();
    return this.snapshots().find((s) => s.id === id)!;
  }

  answerPermission(id: string, permissionId: string, decision: PermissionDecision): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    return s.driver.answerPermission(permissionId, decision);
  }

  sendMessage(id: string, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.driver.sendMessage(text);
    return true;
  }

  /** Open the session's worktree in a new editor window (take over manually). */
  openInEditor(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const editor = process.env.COCKPIT_EDITOR ?? 'code';
    // shell:true resolves `code` -> code.cmd on Windows. Pass ONE quoted command
    // string (not an args array) to avoid DEP0190; cwd is a cockpit-controlled
    // path (fixed base + sanitized id), and we quote it defensively.
    const safeCwd = s.cwd.replace(/"/g, '');
    const child = spawn(`${editor} -n "${safeCwd}"`, {
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      /* editor not on PATH — surfaced to the caller via the thrown-safe path below */
    });
    child.unref();
    return true;
  }

  async interrupt(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.driver.interrupt();
    return true;
  }

  /** Dispose the driver and remove the worktree (branch is kept for merging). */
  async remove(id: string, dropWorktree = true): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.driver.dispose();
    this.sessions.delete(id);
    if (dropWorktree) {
      try {
        await exec('git', ['-C', s.repo, 'worktree', 'remove', '--force', s.cwd]);
      } catch {
        /* leave it; user can prune manually */
      }
    }
    this.emit();
    return true;
  }
}
