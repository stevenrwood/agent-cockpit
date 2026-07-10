import { readFileSync } from 'node:fs';
import path from 'node:path';

/** An arbitrary {label: command} map — the repo defines its own action names. */
export type RepoManifest = Record<string, string>;

const MAX_ACTIONS = 8; // sane cap so a malformed/huge file can't flood a card with buttons

/**
 * Read `.cockpit.json` from a worktree root — the repo's own definition of
 * whatever actions it wants a click-to-run button for (e.g. "Test (Debug)",
 * "Test (Release)", or anything else). The cockpit has NO built-in notion of
 * build/run/test; it only renders one button per entry, in file order. No
 * file, no buttons: it never guesses a repo-specific command.
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const out: RepoManifest = {};
  for (const [label, cmd] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof cmd === 'string' && cmd.trim() && label.trim()) out[label] = cmd;
    if (Object.keys(out).length >= MAX_ACTIONS) break;
  }
  return Object.keys(out).length ? out : undefined;
}
