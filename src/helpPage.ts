// The in-app manual, served at GET /help and opened by the header "? Help" button
// in a new tab. Self-contained HTML (own <style>), themed to match the cockpit.

export function renderHelp(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Cockpit — Manual</title>
<style>
  :root {
    --bg:#f5f6f8; --panel:#fff; --panel2:#eef1f4; --border:#d0d7de; --text:#1f2328;
    --dim:#57606a; --accent:#0969da; --ok:#1a7f37; --warn:#9a6700; --flash:#cf222e;
    --claude:#d97757; --claude-d:#c2603f; --claude-soft:rgba(217,119,87,0.14);
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif; }
  code,kbd,.mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  code { background:var(--panel2); padding:1px 5px; border-radius:4px; font-size:0.88em; }
  kbd { background:#fff; border:1px solid var(--border); border-bottom-width:2px; border-radius:5px;
    padding:1px 6px; font-size:0.82em; box-shadow:0 1px 0 rgba(0,0,0,0.04); white-space:nowrap; }
  header { background:var(--panel); border-bottom:2px solid var(--claude); padding:20px 28px; position:sticky; top:0; }
  header h1 { margin:0; font-size:20px; letter-spacing:0.5px; color:var(--claude-d); }
  header h1 .g { color:var(--claude); }
  header p { margin:4px 0 0; color:var(--dim); font-size:13px; }
  main { max-width:860px; margin:0 auto; padding:28px; }
  nav { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 18px; margin-bottom:24px; }
  nav b { display:block; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:var(--dim); margin-bottom:8px; }
  nav a { display:inline-block; margin:0 14px 6px 0; color:var(--accent); text-decoration:none; font-size:14px; }
  nav a:hover { text-decoration:underline; }
  section { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:22px 26px; margin-bottom:20px; }
  h2 { margin:0 0 12px; font-size:18px; color:var(--claude-d); border-bottom:1px solid var(--border); padding-bottom:8px; }
  h3 { margin:18px 0 6px; font-size:15px; }
  p { margin:10px 0; } ul,ol { margin:10px 0; padding-left:22px; } li { margin:5px 0; }
  .pill { display:inline-block; background:var(--claude); color:#fff; border-radius:6px; padding:1px 9px; font-weight:600; font-size:0.85em; }
  .pill.g { background:var(--ok); } .pill.b { background:var(--accent); } .pill.r { background:var(--flash); }
  .tip { background:var(--claude-soft); border-left:3px solid var(--claude); border-radius:0 8px 8px 0; padding:10px 14px; margin:14px 0; font-size:14px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 22px; }
  .grid > div { display:flex; gap:8px; align-items:baseline; }
  table { border-collapse:collapse; width:100%; margin:12px 0; font-size:14px; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:0.4px; }
  .foot { color:var(--dim); font-size:13px; text-align:center; padding:10px 0 30px; }
  @media (max-width:640px){ .grid{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1><span class="g">⌁</span> AGENT COCKPIT — MANUAL</h1>
  <p>Mission control for running parallel Claude Code sessions you can see and steer.</p>
</header>
<main>
  <nav>
    <b>Contents</b>
    <a href="#overview">Overview</a>
    <a href="#chat">Dispatcher chat</a>
    <a href="#submit">Autocorrect submit</a>
    <a href="#spawn">Spawning workers</a>
    <a href="#cards">Working a session</a>
    <a href="#merge">Merge sequencing</a>
    <a href="#terminal">Terminal</a>
    <a href="#manifest">Build &amp; Run (.cockpit.json)</a>
    <a href="#commit">Commit rule</a>
    <a href="#patterns">Common patterns</a>
    <a href="#keys">Shortcuts</a>
    <a href="#config">Config</a>
  </nav>

  <section id="overview">
    <h2>Overview</h2>
    <p>The cockpit has three parts:</p>
    <ul>
      <li><b>Dispatcher chat</b> (top) — a conversation with your mission-control brain. Plan here.</li>
      <li><b>Worker cards</b> (below) — one card per Claude session, each in its own git <b>worktree</b>
        (isolated branch + working dir), with live telemetry that <span class="pill r">flashes</span>
        when it needs a permission decision.</li>
      <li><b>Flyout terminal</b> (<kbd>Ctrl</kbd>+<kbd>\`</kbd>) — a manual shell for the odd command.</li>
    </ul>
    <div class="tip">The dispatcher <b>plans and drafts</b>; it does not spawn workers itself. You spawn
      them with <span class="pill">＋ Spawn session</span> using briefs it writes for you.</div>
  </section>

  <section id="chat">
    <h2>Dispatcher chat</h2>
    <p>A single persistent session you converse with — it runs in the base repo (no worktree) and can
      read the repo to answer questions. Its header shows the same stats as worker cards: status, turns,
      tokens, cost, model, and a context meter.</p>
    <h3>It stays fast automatically</h3>
    <p>It's <b>one logical permanent session</b>, but when its context passes ~80% it silently
      <b>recycles</b> — starts a fresh underlying context seeded with a short summary — so it never bogs
      down. Your on-screen transcript is kept. <span class="pill">↺ New chat</span> recycles it manually.</p>
    <h3>Proposing a session — one click, no copy/paste</h3>
    <p>When the dispatcher has a concrete piece of work to delegate, it renders an inline
      <b>proposed-session card</b> right in the chat: the goal (editable), repo/model/permissions
      prefilled from your last spawn (also editable). Tweak anything, then click
      <span class="pill">▸ Spawn session</span> once — it becomes a worker card below. Nothing to
      paste anywhere.</p>
  </section>

  <section id="submit">
    <h2>The two-stage autocorrect submit</h2>
    <p>The chat box is multiline — <kbd>Enter</kbd> makes a newline; it never sends on plain Enter.
      Sending is typo-forgiving (a fast Haiku pass fixes your jumble first):</p>
    <ol>
      <li><b>Single <span class="pill">✦↑</span> (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>)</b> → cleans your
        draft in place and refills the box. Typos/spacing/casing only — meaning, tone, and code tokens are
        preserved; it never answers your message. Nothing is sent yet.</li>
      <li><b><span class="pill g">↑</span> again</b> → sends the cleaned text. The arrow turns
        <b style="color:var(--ok)">green</b> when the draft is ready to send.</li>
      <li><b>Double-click the arrow</b> → send exactly as typed, skipping the cleanup.</li>
    </ol>
    <div class="tip">Edit after a clean and the arrow goes back to orange <span class="pill">✦↑</span> —
      a single click re-cleans your edit; double-click still sends as-is.</div>
    <p style="font-size:13px;color:var(--dim)"><b>Grammarly still showing up?</b> Text fields already
      carry the standard opt-out attributes, but current Grammarly builds often ignore them. Right-click
      the Grammarly icon inside the field → <b>"Ignore this site"</b> — sticks across restarts.</p>
  </section>

  <section id="spawn">
    <h2>Spawning worker sessions</h2>
    <p><span class="pill">＋ Spawn session</span> drops a form (and hides the chat until you submit):</p>
    <ul>
      <li><b>Goal / instructions</b> — the full brief the session starts with. Paste what the dispatcher drafted.</li>
      <li><b>Repo path</b> — OS-native form (e.g. <code>c:\\github\\ioSender</code>). It gets a fresh
        worktree on branch <code>cockpit/&lt;id&gt;</code> off the repo's current HEAD.</li>
      <li><b>Model</b> — Default (inherits) or pick Opus / Sonnet / Haiku / Fable.</li>
      <li><b>Permissions</b> — how much the cockpit auto-approves (changeable live on the card):
        <ul>
          <li><span class="pill">Accept edits</span> — auto-approves file edits, still flashes for Bash & others (default).</li>
          <li><span class="pill r">Bypass</span> — auto-approves everything (max speed, least oversight).</li>
          <li><span class="pill b">Ask</span> — flashes for every tool (most oversight).</li>
        </ul></li>
      <li><b>baseURL</b> (optional) — route this session to a gateway/local model (Tier-1 provider swap).</li>
    </ul>
  </section>

  <section id="cards">
    <h2>Working a session (the card)</h2>
    <ul>
      <li><span class="pill r">Flash + ⚑ NEEDS YOU</span> — the agent hit a permission gate. Read the tool +
        input, then <span class="pill g">Allow ✓</span> or <span class="pill r">Deny ✗</span>. (Deny sends
        it guidance.) Or flip the card's permissions dropdown so it stops asking.</li>
      <li><b>Follow-up box</b> — send another message to a live or finished session (it stays open for more turns).</li>
      <li><span class="pill">⧉ VS Code</span> — open the worktree in a new window to take over by hand.</li>
      <li><b>Interrupt</b> — stop the current turn. <b>✕ Remove</b> — dispose + drop the worktree (branch kept).</li>
      <li><span class="pill">📄 Results</span> (enabled when a turn finishes) — a page with stats, the final
        result, and the diff vs base. Green on success, red on error.</li>
      <li><span class="pill">▸_ Term</span> — a persistent terminal scoped to <em>this session's worktree</em>
        (separate from the header's base-repo terminal) — see <a href="#terminal">Terminal</a>.</li>
      <li>If the repo defines a <code>.cockpit.json</code>, one button per action it lists
        appears here too — see <a href="#manifest">Build &amp; Run</a>.</li>
    </ul>
  </section>

  <section id="merge">
    <h2>Merge sequencing</h2>
    <p>Parallel branches conflict, and merging one changes the base for the rest. The cockpit makes this
      visible and safe — <b>your main checkout is never touched.</b></p>
    <ol>
      <li><span class="pill">↻ Check all merges</span> — compute each branch's ahead/behind, dirty flag, and a
        real conflict <b>preflight</b> (a trial merge in a throwaway worktree).</li>
      <li><span class="pill g">Merge → integration</span> — merges a branch onto a cockpit-owned integration
        branch <code>cockpit/int/&lt;base&gt;</code> (its own worktree), then <b>rechecks every sibling</b> — so a
        branch that was clean flips to <span class="pill" style="background:var(--warn)">conflict</span> the moment
        an overlapping one lands ahead of it.</li>
      <li><b>Conflicts</b> stay isolated in the integration worktree: <span class="pill">⧉ Open integration</span>
        to resolve, <span class="pill r">Abort merge</span> to roll back. A second merge is refused until it's resolved.</li>
      <li><span class="pill">Promote → base</span> — when integration looks good, fast-forward the real base up to it
        (guarded: main must be clean and on the base).</li>
    </ol>
  </section>

  <section id="terminal">
    <h2>Flyout terminal</h2>
    <p>A persistent manual shell in the base repo — for git status, a build, an <code>ls</code>. Not a full
      terminal emulator, but persistent cwd + env across commands.</p>
    <ul>
      <li><b>Open/close</b>: <span class="pill">▸_ Terminal</span> button or <kbd>Ctrl</kbd>+<kbd>\`</kbd>.
        Dismiss with <b>✕</b>, <kbd>Esc</kbd>, or the toggle — hiding <b>keeps the shell alive</b> and its scrollback.</li>
      <li><b>Shell picker</b>: <code>cmd</code> / <code>bash</code> / <code>powershell</code> (default cmd, remembered).</li>
      <li><b>History</b>: <kbd>↑</kbd> / <kbd>↓</kbd> recall previous commands. Just start typing — focus is captured for you.</li>
      <li><span class="pill">↺ restart</span> kills and respawns the shell (also how you switch shells).</li>
    </ul>
  </section>

  <section id="manifest">
    <h2>Build &amp; Run — <code>.cockpit.json</code></h2>
    <p>The cockpit has <b>no built-in notion</b> of what "build", "run", or "test" mean — it
      never guesses a repo-specific command. A repo opts in by committing an arbitrary
      <code>{label: command}</code> map as <code>.cockpit.json</code> at its root:</p>
    <pre style="background:var(--panel2);border-radius:8px;padding:12px 14px;overflow:auto;font-size:13px;line-height:1.5">{
  "Test (Debug)":   "powershell -NoProfile -ExecutionPolicy Bypass -File .\\build.ps1 -Configuration Debug -Launch",
  "Test (Release)": "powershell -NoProfile -ExecutionPolicy Bypass -File .\\build.ps1 -Configuration Release -Launch"
}</pre>
    <p>Any number of entries (up to 8), any labels — a repo defines exactly the actions that
      make sense to it. A worker card shows one button per entry, in file order —
      <b>no manifest, no buttons</b>. Read once from the session's <b>worktree</b> at spawn time
      (so a branch that edits the manifest is honored); clicking a button opens that session's
      terminal and runs the command there, so you watch it live.</p>
  </section>

  <section id="commit">
    <h2>The commit rule</h2>
    <p>Every worker session is instructed to <b>commit all of its work</b> to its branch before
      stopping, and to put any spec/design doc it produces <b>in the repo</b> (e.g. a
      <code>docs/</code> folder) — never a temp or scratch directory.</p>
    <p>The cockpit backs this up: if a turn ends with a <b>dirty worktree</b>, the card shows an
      <span class="pill r">⚠ uncommitted work</span> banner and the agent gets one automatic nudge
      to commit everything. There is no manual "commit" button — the point is that a finished
      session's branch <em>is</em> the reviewable change list.</p>
  </section>

  <section id="patterns">
    <h2>Common usage patterns</h2>
    <h3>Plan → delegate</h3>
    <p>Describe the work to the dispatcher. Ask it to break the job into independent pieces and draft a goal
      per piece. Paste each into <span class="pill">＋ Spawn session</span>.</p>
    <h3>Fan out, then merge</h3>
    <p>Spawn several sessions on non-overlapping areas. When they finish, <span class="pill">↻ Check all merges</span>,
      then <b>Merge → integration</b> one at a time — watch siblings re-flag — resolve any conflict in the integration
      worktree, then <b>Promote → base</b> once.</p>
    <h3>Supervise vs. let it run</h3>
    <p>Start on <span class="pill">Accept edits</span> and watch the flashes. Once you trust a session, flip its card to
      <span class="pill r">Bypass</span> to let it run unattended; flip back to <span class="pill b">Ask</span> for a risky step.</p>
    <h3>Take over by hand</h3>
    <p>Any session: <span class="pill">⧉ VS Code</span> opens its worktree. Edit directly, or use the flyout terminal in
      the base repo. The branch is real git — nothing is hidden.</p>
    <div class="tip">Unattended sessions do best when they can <b>self-verify</b> (build/test without you). A session that
      can't check its own work will stall waiting for you — keep those supervised.</div>
  </section>

  <section id="keys">
    <h2>Keyboard shortcuts</h2>
    <div class="grid">
      <div><kbd>Ctrl</kbd>+<kbd>Enter</kbd> <span>Chat: clean (then send)</span></div>
      <div><kbd>Ctrl</kbd>+<kbd>\`</kbd> <span>Toggle terminal</span></div>
      <div>double-click ↑ <span>Chat: send as-is</span></div>
      <div><kbd>Esc</kbd> <span>Close terminal</span></div>
      <div><kbd>Enter</kbd> <span>Chat: newline · Terminal: run</span></div>
      <div><kbd>↑</kbd>/<kbd>↓</kbd> <span>Terminal: command history</span></div>
    </div>
  </section>

  <section id="config">
    <h2>Config (environment variables)</h2>
    <table>
      <tr><th>Variable</th><th>Default</th><th>Effect</th></tr>
      <tr><td><code>COCKPIT_PORT</code></td><td>8770</td><td>HTTP port</td></tr>
      <tr><td><code>COCKPIT_REPO</code></td><td>c:\\github\\ioSender</td><td>Base repo for the dispatcher + terminal</td></tr>
      <tr><td><code>COCKPIT_SHELL</code></td><td>cmd</td><td>Default terminal shell (cmd/bash/powershell)</td></tr>
      <tr><td><code>COCKPIT_CTX_RESET</code></td><td>0.8</td><td>Dispatcher context recycle threshold</td></tr>
      <tr><td><code>COCKPIT_AUTOCORRECT_MODEL</code></td><td>Haiku</td><td>Model for the clean-only pass</td></tr>
      <tr><td><code>COCKPIT_EDITOR</code></td><td>code</td><td>Editor for "Open in VS Code"</td></tr>
    </table>
    <p><span class="pill r">⏻ Shutdown</span> (header) tears down all cockpit worktrees but <b>keeps every branch</b> —
      your work and any integration merges survive.</p>
  </section>

  <div class="foot">Agent Cockpit · localhost, single operator · <a href="/" style="color:var(--accent)">← back to the cockpit</a></div>
</main>
</body>
</html>`;
}
