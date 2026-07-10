import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { BASE_REPO } from './dispatcher.js';

const MAX_SCROLLBACK = 100_000; // chars kept for replay to a (re)connecting UI

export type ShellKind = 'cmd' | 'bash' | 'powershell';

// How each shell is launched over a stdin pipe. cmd and powershell print a
// prompt + echo the command; bash -i does too (and evaluates $(( )) etc.), at
// the cost of ANSI colour codes + a one-time job-control warning — both cleaned
// up below. Default is cmd (universal on Windows; no PowerShell required).
const SHELLS: Record<ShellKind, { cmd: string; args: string[] }> = {
  cmd: { cmd: 'cmd.exe', args: [] },
  bash: { cmd: 'bash', args: ['-i'] },
  powershell: { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] },
};

export function normalizeShell(s: unknown): ShellKind {
  return s === 'bash' || s === 'powershell' || s === 'cmd' ? s : 'cmd';
}

/**
 * One persistent piped shell in the base repo (cmd / bash / powershell — the
 * operator's choice). Not a true PTY: no cursor addressing, and we strip ANSI +
 * carriage returns so the plain-text flyout stays readable. Persistent cwd + env
 * across commands; zero native deps, in keeping with the project's no-build ethos.
 */
export class Terminal {
  private proc!: ChildProcessWithoutNullStreams;
  private listeners = new Set<(chunk: string) => void>();
  private scrollback = '';
  private shell: ShellKind;

  constructor(shell?: ShellKind, private cwd: string = BASE_REPO) {
    this.shell = normalizeShell(shell ?? process.env.COCKPIT_SHELL);
    this.start();
  }

  getShell(): ShellKind {
    return this.shell;
  }

  private start() {
    const { cmd, args } = SHELLS[this.shell];
    let p: ChildProcessWithoutNullStreams;
    try {
      p = spawn(cmd, args, { cwd: this.cwd, windowsHide: true }) as ChildProcessWithoutNullStreams;
    } catch (err: any) {
      this.emit(`\n[could not launch ${this.shell} (${cmd}): ${err?.message ?? err}]\n`);
      return;
    }
    this.proc = p;
    const onData = (buf: Buffer) => this.emit(clean(buf.toString('utf8')));
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (code) => this.emit(`\n[${this.shell} exited (${code}). Type anything to restart.]\n`));
    p.on('error', (err) => this.emit(`\n[${this.shell} error: ${err.message}]\n`));

    this.emit(`agent-cockpit terminal · ${this.shell} · ${this.cwd}\n`);
  }

  private emit(chunk: string) {
    this.scrollback = (this.scrollback + chunk).slice(-MAX_SCROLLBACK);
    for (const cb of this.listeners) cb(chunk);
  }

  /** Run a line in the shell (respawns first if the previous shell had exited). */
  write(line: string) {
    if (!this.proc || this.proc.exitCode !== null || this.proc.killed) this.start();
    try {
      this.proc.stdin.write(line.replace(/\r?\n$/, '') + '\n');
    } catch {
      this.emit('\n[could not write to shell]\n');
    }
  }

  /** Subscribe to live output; the current scrollback is replayed immediately. */
  subscribe(cb: (chunk: string) => void): () => void {
    if (this.scrollback) cb(this.scrollback);
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Kill and respawn a fresh shell (clears scrollback). Optionally switch shells. */
  reset(shell?: ShellKind) {
    if (shell) this.shell = normalizeShell(shell);
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.scrollback = '';
    this.start();
  }

  dispose() {
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {
      /* ignore */
    }
  }
}

/** Owns multiple terminals keyed by id ('base' + one per session worktree). */
export class TerminalManager {
  private terms = new Map<string, Terminal>();

  /** Get-or-create the terminal for `id` rooted at `cwd`. */
  get(id: string, cwd: string, shell?: ShellKind): Terminal {
    let t = this.terms.get(id);
    if (!t) {
      t = new Terminal(shell, cwd);
      this.terms.set(id, t);
    }
    return t;
  }

  dispose(id: string) {
    const t = this.terms.get(id);
    if (t) {
      t.dispose();
      this.terms.delete(id);
    }
  }

  disposeAll() {
    for (const t of this.terms.values()) t.dispose();
    this.terms.clear();
  }
}

// Strip ANSI CSI/OSC escape sequences and carriage returns so the plain-text
// flyout doesn't show raw escape codes (bash -i colours its prompt) or stray \r.
function clean(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (title) sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colour/cursor) sequences
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}
