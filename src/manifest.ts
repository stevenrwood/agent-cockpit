import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface RepoManifest {
  build?: string;
  run?: string;
  test?: string;
}

const KEYS: (keyof RepoManifest)[] = ['build', 'run', 'test'];

/**
 * Read `.cockpit.json` from a worktree root — the repo's own definition of what
 * "build" / "run" / "test" mean to it. No file, no buttons: the cockpit never
 * guesses a repo-specific command (e.g. a hardcoded build.ps1 invocation).
 * Only string fields for the three known keys are kept; anything else is ignored.
 */
export function readManifest(cwd: string): RepoManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(cwd, '.cockpit.json'), 'utf8');
  } catch {
    return undefined; // no manifest — the common case
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // malformed — treat as absent rather than crash the spawn
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const out: RepoManifest = {};
  for (const k of KEYS) {
    const v = (parsed as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
