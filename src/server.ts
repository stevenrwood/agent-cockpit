import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './sessionManager.js';
import { Dispatcher } from './dispatcher.js';
import { Terminal, normalizeShell } from './terminal.js';
import { autocorrect } from './autocorrect.js';
import { renderHelp } from './helpPage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COCKPIT_PORT ?? 8770);
const manager = new SessionManager();

// The dispatcher chat + a shared base-repo terminal. Both are singletons that
// live for the whole cockpit run; the dispatcher is created lazily on first use
// so a boot with no chat costs nothing.
let dispatcher: Dispatcher | null = null;
const chatListeners = new Set<() => void>();
function getDispatcher(): Dispatcher {
  if (!dispatcher) dispatcher = new Dispatcher(() => { for (const cb of chatListeners) cb(); });
  return dispatcher;
}
let terminal: Terminal | null = null;
function getTerminal(): Terminal {
  if (!terminal) terminal = new Terminal();
  return terminal;
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(json);
}

// Open an SSE stream and return a non-throwing writer. Writes after the client
// disconnects are swallowed (they must never bubble into the request handler's
// catch, which would try to writeHead again on an already-headed response).
function openSSE(res: http.ServerResponse): (data: unknown) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return (data: unknown) => {
    if (res.writableEnded) return;
    try {
      res.write(typeof data === 'string' ? data : `data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client went away mid-write */
    }
  };
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','sessions','s1','permission']
  const method = req.method ?? 'GET';

  try {
    // --- static UI ---
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = readFileSync(path.resolve(here, '..', 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // --- help / manual page ---
    if (method === 'GET' && (url.pathname === '/help' || url.pathname === '/help.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHelp());
      return;
    }

    // --- SSE live state stream ---
    if (method === 'GET' && url.pathname === '/api/events') {
      const write = openSSE(res);
      const push = () => write(manager.snapshots());
      push();
      const unsub = manager.onChange(push);
      const ka = setInterval(() => write(': keep-alive\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ka);
        unsub();
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, manager.snapshots());
    }

    // --- dispatcher chat ---
    if (method === 'GET' && url.pathname === '/api/chat/events') {
      const d = getDispatcher(); // resolve BEFORE opening the stream (may construct)
      const write = openSSE(res);
      const push = () => write({ state: d.getState(), transcript: d.getTranscript() });
      push();
      chatListeners.add(push);
      const ka = setInterval(() => write(': keep-alive\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ka);
        chatListeners.delete(push);
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/chat/message') {
      const body = await readBody(req);
      getDispatcher().sendMessage(String(body.text ?? ''));
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/chat/autocorrect') {
      const body = await readBody(req);
      const cleaned = await autocorrect(String(body.text ?? ''));
      return send(res, 200, { cleaned });
    }
    if (method === 'POST' && url.pathname === '/api/chat/reset') {
      getDispatcher().reset();
      return send(res, 200, { ok: true });
    }

    // --- shared base-repo terminal ---
    if (method === 'GET' && url.pathname === '/api/terminal/events') {
      const term = getTerminal(); // resolve BEFORE opening the stream (may spawn shell)
      const write = openSSE(res);
      const unsub = term.subscribe((chunk) => write({ chunk }));
      const ka = setInterval(() => write(': keep-alive\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ka);
        unsub();
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/terminal/input') {
      const body = await readBody(req);
      getTerminal().write(String(body.data ?? ''));
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/api/terminal/reset') {
      const body = await readBody(req);
      getTerminal().reset(body.shell ? normalizeShell(body.shell) : undefined);
      return send(res, 200, { ok: true, shell: getTerminal().getShell() });
    }

    // --- recompute merge status for all sessions ---
    if (method === 'POST' && url.pathname === '/api/refresh-merge') {
      await manager.refreshAllMergeStatus();
      return send(res, 200, { ok: true });
    }

    // --- graceful shutdown: teardown worktrees then exit ---
    if (method === 'POST' && url.pathname === '/api/shutdown') {
      send(res, 200, { ok: true });
      setImmediate(() => void shutdown('api'));
      return;
    }

    // --- create a session ---
    if (method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readBody(req);
      if (!body.repo || !body.goal) return send(res, 400, { error: 'repo and goal are required' });
      const snap = await manager.create(body);
      return send(res, 201, snap);
    }

    // --- per-session actions: /api/sessions/:id/<action> ---
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
      const id = parts[2];
      const action = parts[3];

      if (method === 'POST' && action === 'permission') {
        const body = await readBody(req);
        const ok = manager.answerPermission(id, body.permissionId, {
          allow: !!body.allow,
          message: body.message,
        });
        return send(res, ok ? 200 : 404, { ok });
      }
      if (method === 'POST' && action === 'message') {
        const body = await readBody(req);
        const ok = manager.sendMessage(id, String(body.text ?? ''));
        return send(res, ok ? 200 : 404, { ok });
      }
      if (method === 'POST' && action === 'policy') {
        const body = await readBody(req);
        const policy = body.policy;
        if (policy !== 'ask' && policy !== 'acceptEdits' && policy !== 'bypass')
          return send(res, 400, { error: 'policy must be ask | acceptEdits | bypass' });
        const ok = manager.setPolicy(id, policy);
        return send(res, ok ? 200 : 404, { ok });
      }
      if (method === 'POST' && action === 'interrupt') {
        const ok = await manager.interrupt(id);
        return send(res, ok ? 200 : 404, { ok });
      }
      if (method === 'POST' && action === 'open-vscode') {
        const ok = manager.openInEditor(id);
        return send(res, ok ? 200 : 404, { ok });
      }
      // Results page (HTML) for a finished session — goal, stats, result, diff.
      if (method === 'GET' && action === 'results') {
        const html = await manager.resultsHtml(id);
        if (html == null) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (method === 'POST' && action === 'refresh-merge') {
        const ok = await manager.refreshMergeStatus(id);
        return send(res, ok ? 200 : 404, { ok });
      }
      if (method === 'POST' && action === 'merge') {
        const { ok, result } = await manager.merge(id);
        return send(res, 200, { ok, result });
      }
      if (method === 'POST' && action === 'abort-merge') {
        const ok = await manager.abortMerge(id);
        return send(res, ok ? 200 : 404, { ok });
      }
      if (method === 'POST' && action === 'promote') {
        const { ok, result } = await manager.promote(id);
        return send(res, 200, { ok, result });
      }
      // Open the integration worktree (where a conflict lives) to resolve it.
      if (method === 'POST' && action === 'open-integration') {
        const ok = await manager.openIntegrationInEditor(id);
        return send(res, ok ? 200 : 404, { ok });
      }
      if (method === 'DELETE' && !action) {
        const ok = await manager.remove(id);
        return send(res, ok ? 200 : 404, { ok });
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (err: any) {
    send(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`agent-cockpit → http://127.0.0.1:${PORT}`);
});

// Graceful teardown: on Ctrl+C / kill, dispose sessions and remove all cockpit
// worktrees (branches kept) before exiting.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} → tearing down worktrees…`);
  try {
    dispatcher?.dispose();
    terminal?.dispose();
  } catch {
    /* ignore */
  }
  try {
    await manager.teardown();
  } catch (err) {
    console.error('teardown error:', err);
  }
  server.close(() => process.exit(0));
  // Failsafe if server.close hangs on open SSE connections.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// The cockpit hosts LIVE agent sessions — one stray error (e.g. an SSE write
// racing a client disconnect) must not take them all down. Log and stay up.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
