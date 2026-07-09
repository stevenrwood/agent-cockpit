import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Non-throwing git runner — we care about exit codes (merge conflict = code 1),
// not exceptions.
function git(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

export async function currentBranch(repo: string): Promise<string> {
  const r = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.stdout.trim();
}

export async function isClean(repo: string): Promise<boolean> {
  const r = await git(repo, ['status', '--porcelain']);
  return r.stdout.trim() === '';
}

/** Counts vs base: `behind` = commits in base not in branch; `ahead` = branch-only. */
export async function aheadBehind(
  repo: string,
  base: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  const r = await git(repo, ['rev-list', '--left-right', '--count', `${base}...${branch}`]);
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export type MergePreview = 'clean' | 'conflict' | 'up-to-date' | 'unknown';

/**
 * Accurate, side-effect-free conflict preflight: check out `base` in a throwaway
 * detached worktree, attempt a real `--no-commit --no-ff` merge of `branch`,
 * read the result, then delete the worktree. Matches actual merge behavior on
 * any git version (no 2.38 merge-tree dependency).
 */
export async function mergePreview(
  repo: string,
  base: string,
  branch: string,
): Promise<{ preview: MergePreview; conflictFiles: string[] }> {
  const ab = await aheadBehind(repo, base, branch);
  if (ab.ahead === 0) return { preview: 'up-to-date', conflictFiles: [] };

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cockpit-merge-'));
  try {
    const add = await git(repo, ['worktree', 'add', '--detach', tmp, base]);
    if (add.code !== 0) return { preview: 'unknown', conflictFiles: [] };

    const merge = await git(tmp, ['merge', '--no-commit', '--no-ff', branch]);
    let preview: MergePreview;
    let conflictFiles: string[] = [];
    if (merge.code === 0) {
      preview = 'clean';
    } else {
      preview = 'conflict';
      const u = await git(tmp, ['diff', '--name-only', '--diff-filter=U']);
      conflictFiles = u.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    await git(tmp, ['merge', '--abort']); // ignore result
    return { preview, conflictFiles };
  } finally {
    await git(repo, ['worktree', 'remove', '--force', tmp]);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* worktree remove already cleaned it */
    }
  }
}

export type MergeResult =
  | { status: 'refused'; reason: string }
  | { status: 'merged' }
  | { status: 'conflict'; conflictFiles: string[] }
  | { status: 'error'; reason: string };

/**
 * Execute the merge into `base` in the repo's MAIN working tree — guarded so we
 * never clobber: the main checkout must be clean and already on `base`. On
 * conflict we leave the state in place for the operator to resolve (Open in VS
 * Code) or Abort.
 */
export async function mergeBranch(repo: string, base: string, branch: string): Promise<MergeResult> {
  const cur = await currentBranch(repo);
  if (cur !== base) {
    return { status: 'refused', reason: `main checkout is on '${cur}', not base '${base}'` };
  }
  if (!(await isClean(repo))) {
    return { status: 'refused', reason: 'main checkout has uncommitted changes' };
  }
  const r = await git(repo, ['merge', '--no-ff', '--no-edit', branch]);
  if (r.code === 0) return { status: 'merged' };

  const u = await git(repo, ['diff', '--name-only', '--diff-filter=U']);
  const conflictFiles = u.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (conflictFiles.length) return { status: 'conflict', conflictFiles };
  // Non-conflict failure (e.g. nothing to merge / other error).
  return { status: 'error', reason: (r.stderr || r.stdout).trim().slice(0, 300) };
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  const r = await git(repo, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
  return r.code === 0 && r.stdout.trim() !== '';
}

/** Path of the worktree that currently has `branch` checked out, or null. */
export async function findWorktreeForBranch(repo: string, branch: string): Promise<string | null> {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  for (const block of r.stdout.split(/\n\n+/)) {
    const wt = block.match(/^worktree (.+)$/m)?.[1];
    const br = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (br === branch && wt) return wt.trim();
  }
  return null;
}

/**
 * Merge `branch` into whatever is checked out in `worktree` (the cockpit-owned
 * integration worktree). No base-guard — the cockpit keeps this worktree clean.
 */
export async function mergeInWorktree(worktree: string, branch: string): Promise<MergeResult> {
  const r = await git(worktree, ['merge', '--no-ff', '--no-edit', branch]);
  if (r.code === 0) return { status: 'merged' };
  const u = await git(worktree, ['diff', '--name-only', '--diff-filter=U']);
  const conflictFiles = u.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (conflictFiles.length) return { status: 'conflict', conflictFiles };
  return { status: 'error', reason: (r.stderr || r.stdout).trim().slice(0, 300) };
}

/** Fast-forward `base` (checked out in the repo's main tree) up to `branch`. */
export async function fastForward(repo: string, base: string, branch: string): Promise<MergeResult> {
  const cur = await currentBranch(repo);
  if (cur !== base) return { status: 'refused', reason: `main checkout is on '${cur}', not base '${base}'` };
  if (!(await isClean(repo))) return { status: 'refused', reason: 'main checkout has uncommitted changes' };
  const r = await git(repo, ['merge', '--ff-only', branch]);
  if (r.code === 0) return { status: 'merged' };
  return { status: 'error', reason: (r.stderr || r.stdout).trim().slice(0, 300) };
}

export async function abortMerge(repo: string): Promise<boolean> {
  const r = await git(repo, ['merge', '--abort']);
  return r.code === 0;
}

/** Is a merge currently in progress in the repo's main tree? */
export async function mergeInProgress(repo: string): Promise<boolean> {
  const r = await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  return r.code === 0 && r.stdout.trim() !== '';
}
