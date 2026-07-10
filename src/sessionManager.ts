import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAgentDriver } from './drivers/claudeAgent.js';
import * as g from './git.js';
import type { MergeStatus, PermissionDecision, SessionDriver, SessionSnapshot } from './types.js';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const WORKTREES_DIR = path.resolve(here, '..', 'worktrees');

interface Session {
  id: string;
  goal: string;
  repo: string;
  branch: string;
  baseBranch: string;
  cwd: string;
  baseURL?: string;
  createdAt: number;
  driver: SessionDriver;
  merge?: MergeStatus; // cached; recomputed on demand + after merges
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
      baseBranch: s.baseBranch,
      cwd: s.cwd,
      baseURL: s.baseURL,
      createdAt: s.createdAt,
      merge: s.merge,
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

    // The base branch this session will merge back into = the repo's HEAD branch
    // at spawn time.
    const baseBranch = (await g.currentBranch(input.repo)) || 'HEAD';

    // Isolate the session on its own worktree + branch off the repo's HEAD.
    await exec('git', ['-C', input.repo, 'worktree', 'add', '-b', branch, cwd, 'HEAD']);

    const driver = new ClaudeAgentDriver(() => this.emit());
    const session: Session = {
      id,
      goal: input.goal,
      repo: input.repo,
      branch,
      baseBranch,
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
    return this.launchEditor(s.cwd);
  }

  /** Open the base repo's main tree in an editor (e.g. to resolve a conflict). */
  openRepoInEditor(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    return this.launchEditor(s.repo);
  }

  private launchEditor(dir: string): boolean {
    const editor = process.env.COCKPIT_EDITOR ?? 'code';
    // shell:true resolves `code` -> code.cmd on Windows. Pass ONE quoted command
    // string (not an args array) to avoid DEP0190; the path is cockpit-controlled
    // and we strip quotes defensively.
    const safe = dir.replace(/"/g, '');
    const child = spawn(`${editor} -n "${safe}"`, {
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      /* editor not on PATH */
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

  // ---- merge sequencing ----

  /** Recompute one session's merge status (ahead/behind, dirty, conflict preflight). */
  async refreshMergeStatus(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    await this.computeMerge(s);
    this.emit();
    return true;
  }

  /** Recompute merge status for every session (e.g. after a merge lands). */
  async refreshAllMergeStatus(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.computeMerge(s)));
    this.emit();
  }

  // Merges land on a cockpit-owned integration branch in its OWN worktree, so
  // the user's main checkout is never touched. Keyed by repo+base.
  private integrations = new Map<string, { path: string; branch: string }>();
  private mergingBranch: string | null = null;

  private intBranchName(base: string): string {
    return `cockpit/int/${base}`;
  }

  /** Create-or-reuse the integration worktree for (repo, base). */
  private async ensureIntegration(repo: string, base: string): Promise<{ path: string; branch: string }> {
    const key = `${repo}::${base}`;
    const cached = this.integrations.get(key);
    if (cached) return cached;

    const branch = this.intBranchName(base);
    await exec('git', ['-C', repo, 'worktree', 'prune']).catch(() => {});

    let wtPath = await g.findWorktreeForBranch(repo, branch);
    if (!wtPath) {
      const safe = key.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60);
      wtPath = path.join(WORKTREES_DIR, '_int', safe);
      mkdirSync(path.join(WORKTREES_DIR, '_int'), { recursive: true });
      if (await g.refExists(repo, branch)) {
        await exec('git', ['-C', repo, 'worktree', 'add', wtPath, branch]);
      } else {
        // New integration branch starting at the base tip.
        await exec('git', ['-C', repo, 'worktree', 'add', '-b', branch, wtPath, base]);
      }
    }
    const rec = { path: wtPath, branch };
    this.integrations.set(key, rec);
    return rec;
  }

  private async computeMerge(s: Session): Promise<void> {
    try {
      const intBranch = this.intBranchName(s.baseBranch);
      const intPath = await g.findWorktreeForBranch(s.repo, intBranch);
      // Preflight/counts are vs the integration branch once it exists (so
      // sequencing shows through); until then, vs the base.
      const target = intPath ? intBranch : s.baseBranch;
      const [{ ahead, behind }, dirty, preview] = await Promise.all([
        g.aheadBehind(s.repo, target, s.branch),
        g.isClean(s.cwd).then((c) => !c),
        g.mergePreview(s.repo, target, s.branch),
      ]);
      const merging = intPath ? (await g.mergeInProgress(intPath)) && this.mergingBranch === s.branch : false;
      s.merge = {
        baseBranch: s.baseBranch,
        targetBranch: target,
        ahead,
        behind,
        dirty,
        preview: preview.preview,
        conflictFiles: preview.conflictFiles,
        checkedAt: Date.now(),
        merging,
      };
    } catch {
      s.merge = {
        baseBranch: s.baseBranch,
        targetBranch: s.baseBranch,
        ahead: 0,
        behind: 0,
        dirty: false,
        preview: 'unknown',
        conflictFiles: [],
        checkedAt: Date.now(),
        merging: false,
      };
    }
  }

  /** Merge a session's branch into the integration worktree (main tree untouched). */
  async merge(id: string): Promise<{ ok: boolean; result: any }> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, result: { status: 'error', reason: 'no such session' } };
    const int = await this.ensureIntegration(s.repo, s.baseBranch);
    if (await g.mergeInProgress(int.path)) {
      return { ok: false, result: { status: 'refused', reason: 'integration has an unresolved conflict — resolve or abort it first' } };
    }
    const result = await g.mergeInWorktree(int.path, s.branch);
    if (result.status === 'conflict') this.mergingBranch = s.branch;
    if (result.status === 'merged') this.mergingBranch = null;
    // Landing a merge advances the integration branch — recompute every sibling.
    await this.refreshAllMergeStatus();
    return { ok: result.status === 'merged' || result.status === 'conflict', result };
  }

  /** Abort an in-progress conflicted merge in the integration worktree. */
  async abortMerge(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    const int = await this.ensureIntegration(s.repo, s.baseBranch);
    const ok = await g.abortMerge(int.path);
    this.mergingBranch = null;
    await this.refreshAllMergeStatus();
    return ok;
  }

  /** Fast-forward the real base up to the accumulated integration branch. */
  async promote(id: string): Promise<{ ok: boolean; result: any }> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, result: { status: 'error', reason: 'no such session' } };
    const branch = this.intBranchName(s.baseBranch);
    if (!(await g.refExists(s.repo, branch))) {
      return { ok: false, result: { status: 'error', reason: 'no integration branch yet' } };
    }
    const result = await g.fastForward(s.repo, s.baseBranch, branch);
    await this.refreshAllMergeStatus();
    return { ok: result.status === 'merged', result };
  }

  /** Open the integration worktree (where a conflict lives) in an editor. */
  async openIntegrationInEditor(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    const int = await this.ensureIntegration(s.repo, s.baseBranch);
    return this.launchEditor(int.path);
  }

  /**
   * Graceful shutdown: dispose every driver and remove all cockpit worktrees
   * (session + integration). Branches are KEPT — the work and any accumulated
   * integration merges survive, so a later run can re-attach or promote.
   */
  async teardown(): Promise<void> {
    const repos = new Set<string>();
    for (const s of this.sessions.values()) {
      repos.add(s.repo);
      try {
        s.driver.dispose();
      } catch {
        /* ignore */
      }
      await exec('git', ['-C', s.repo, 'worktree', 'remove', '--force', s.cwd]).catch(() => {});
    }
    for (const [key, int] of this.integrations) {
      const repo = key.split('::')[0];
      repos.add(repo);
      await exec('git', ['-C', repo, 'worktree', 'remove', '--force', int.path]).catch(() => {});
    }
    for (const repo of repos) {
      await exec('git', ['-C', repo, 'worktree', 'prune']).catch(() => {});
    }
    // Everything under worktrees/ is cockpit-owned and now unregistered from git;
    // remove the empty directory shells git leaves behind.
    try {
      rmSync(WORKTREES_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    this.sessions.clear();
    this.integrations.clear();
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
