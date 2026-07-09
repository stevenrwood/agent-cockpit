import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './sessionManager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COCKPIT_PORT ?? 8770);
const manager = new SessionManager();

function send(res: http.ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(json);
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

    // --- SSE live state stream ---
    if (method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const push = () => res.write(`data: ${JSON.stringify(manager.snapshots())}\n\n`);
      push();
      const unsub = manager.onChange(push);
      const ka = setInterval(() => res.write(': keep-alive\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ka);
        unsub();
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, manager.snapshots());
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
      if (method === 'POST' && action === 'interrupt') {
        const ok = await manager.interrupt(id);
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
