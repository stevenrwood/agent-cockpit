import type { SessionSnapshot } from './types.js';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

function fmt(n?: number): string {
  if (n == null) return '—';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** A self-contained HTML results page for one finished session. */
export function renderResults(s: SessionSnapshot, status: string, patch: string): string {
  const ctxPct =
    s.contextWindow && s.contextUsed ? Math.round((s.contextUsed / s.contextWindow) * 100) : null;
  const stats = [
    ['status', s.status],
    ['turns', String(s.turns)],
    ['tokens in / out', `${fmt(s.inputTokens)} / ${fmt(s.outputTokens)}`],
    ['cost', `$${(s.costUsd || 0).toFixed(4)}`],
    ['context', s.contextWindow ? `${fmt(s.contextUsed)} / ${fmt(s.contextWindow)} (${ctxPct}%)` : fmt(s.contextUsed)],
    ['model', s.model || '—'],
    ['branch', s.branch],
    ['base', s.baseBranch],
  ];
  const changed = status.trim()
    ? status.trim().split('\n').map((l) => esc(l)).join('\n')
    : '(no file changes)';
  const diff = patch.trim() ? highlightDiff(patch) : '(no tracked diff — new/untracked files are listed above)';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Results — ${esc(s.goal)}</title>
<style>
  :root { --bg:#f5f6f8; --panel:#fff; --border:#d0d7de; --text:#1f2328; --dim:#57606a;
          --add:#1a7f37; --del:#cf222e; --hunk:#0969da; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:18px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px;
          padding:16px; margin-bottom:18px; }
  .card h2 { font-size:14px; margin:0 0 10px; text-transform:uppercase; letter-spacing:.5px; color:var(--dim); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .stat .k { color:var(--dim); font-size:11px; text-transform:uppercase; }
  .stat .v { font-size:15px; font-weight:600; }
  pre, code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .result { white-space:pre-wrap; word-break:break-word; font-size:14px; }
  .scroll { overflow-x:auto; }
  pre.diff, pre.files { margin:0; font-size:12.5px; line-height:1.5; white-space:pre; }
  .diff .add { color:var(--add); }
  .diff .del { color:var(--del); }
  .diff .hunk { color:var(--hunk); font-weight:600; }
  .diff .file { font-weight:700; }
</style></head>
<body><div class="wrap">
  <h1>${esc(s.goal)}</h1>
  <div class="sub">${esc(s.provider)}${s.model ? ' · ' + esc(s.model) : ''} · ${esc(s.branch)}${s.finishedAt ? ' · finished' : ''}</div>

  <div class="card"><h2>Stats</h2><div class="stats">
    ${stats.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
  </div></div>

  <div class="card"><h2>Agent result</h2>
    <div class="result">${s.resultText ? esc(s.resultText) : '(no final result text captured)'}</div>
  </div>

  <div class="card"><h2>Changed files</h2><div class="scroll"><pre class="files">${changed}</pre></div></div>

  <div class="card"><h2>Diff vs ${esc(s.baseBranch)}</h2><div class="scroll"><pre class="diff">${diff}</pre></div></div>
</div></body></html>`;
}

function highlightDiff(patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      const e = esc(line);
      if (line.startsWith('+++') || line.startsWith('---')) return `<span class="file">${e}</span>`;
      if (line.startsWith('diff ') || line.startsWith('index ')) return `<span class="file">${e}</span>`;
      if (line.startsWith('@@')) return `<span class="hunk">${e}</span>`;
      if (line.startsWith('+')) return `<span class="add">${e}</span>`;
      if (line.startsWith('-')) return `<span class="del">${e}</span>`;
      return e;
    })
    .join('\n');
}
