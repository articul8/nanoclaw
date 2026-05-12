/**
 * Local-host management HTTP server — dashboard parity surface.
 *
 * Serves the `/api/v1/a8/claw[/...]` routes from mgmt-handlers.ts on a
 * separate port from webhook-server.ts. Why two ports:
 *
 *   webhook-server (default 3000)  — public-facing, receives channel
 *                                    callbacks (Slack, Linear, etc.).
 *                                    Must be reachable from the internet
 *                                    when channels are wired.
 *
 *   mgmt-server (default 3010)     — operator-only, drives the dashboard
 *                                    and CLI. Bound to 127.0.0.1 by default
 *                                    so it never accidentally faces the
 *                                    public internet on a misconfigured
 *                                    machine. Override with MGMT_HOST=0.0.0.0
 *                                    if you intentionally want LAN access.
 *
 * Routes (mirrors a8-code's coordinator surface at endpoints.py:1244-1592):
 *   GET    /api/v1/a8/claw                  list
 *   GET    /api/v1/a8/claw/:id              detail
 *   POST   /api/v1/a8/claw                  create
 *   POST   /api/v1/a8/claw/:id/resume       resume
 *   POST   /api/v1/a8/claw/:id/stop         stop
 *   DELETE /api/v1/a8/claw/:id              delete (only closed sessions)
 *   GET    /api/v1/health                   liveness
 *
 * CORS: permissive in local mode (Origin echo, no credentials). The
 * dashboard is a static SPA served from a different origin (Vite dev
 * server on :5173 or a static build on :8080); without CORS it can't
 * call us. We don't use cookies/credentials so the open-Origin policy
 * is safe here.
 */
import http from 'node:http';

import { log } from './log.js';
import {
  createSessionHandler,
  deleteSessionHandler,
  getSessionDetail,
  listSessions,
  resumeSessionHandler,
  stopSessionHandler,
  type HandlerResult,
} from './mgmt-handlers.js';

const DEFAULT_PORT = 3010;
const DEFAULT_HOST = '127.0.0.1';

let server: http.Server | null = null;

function logmsg(msg: string): void {
  log.info(`[mgmt] ${msg}`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      // Cap at 1MB — dashboard payloads are tiny (a few fields). Anything
      // bigger is either a bug or an attack.
      if (body.length > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tenant-ID, X-User-ID');
}

function writeJson<T>(res: http.ServerResponse, result: HandlerResult<T>): void {
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.body));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname, searchParams } = url;

  // Liveness — separate from the management routes so dashboards / load
  // balancers can probe without auth.
  if (req.method === 'GET' && pathname === '/api/v1/health') {
    writeJson(res, { status: 200, body: { ok: true, service: 'a8-claw', mode: 'local' } });
    return;
  }

  // /api/v1/a8/claw      (list / create)
  if (pathname === '/api/v1/a8/claw') {
    if (req.method === 'GET') {
      writeJson(
        res,
        listSessions({
          status: searchParams.get('status') ?? undefined,
          include_incognito: searchParams.get('include_incognito') === 'true',
          limit: parseIntOrUndef(searchParams.get('limit')),
          offset: parseIntOrUndef(searchParams.get('offset')),
        }),
      );
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req).catch(() => '');
      const parsed = safeParseJson(body);
      if (parsed === undefined) {
        writeJson(res, { status: 400, body: { error: 'invalid JSON body' } });
        return;
      }
      writeJson(res, createSessionHandler(parsed));
      return;
    }
  }

  // /api/v1/a8/claw/:id            (GET detail / DELETE)
  // /api/v1/a8/claw/:id/resume     (POST)
  // /api/v1/a8/claw/:id/stop       (POST)
  const m = pathname.match(/^\/api\/v1\/a8\/claw\/([^/]+)(?:\/([^/]+))?$/);
  if (m) {
    const sessionId = decodeURIComponent(m[1]);
    const action = m[2];

    if (req.method === 'GET' && !action) {
      writeJson(
        res,
        getSessionDetail(sessionId, {
          include_incognito: searchParams.get('include_incognito') === 'true',
        }),
      );
      return;
    }
    if (req.method === 'DELETE' && !action) {
      writeJson(res, deleteSessionHandler(sessionId));
      return;
    }
    if (req.method === 'POST' && action === 'resume') {
      writeJson(res, await resumeSessionHandler(sessionId));
      return;
    }
    if (req.method === 'POST' && action === 'stop') {
      writeJson(res, stopSessionHandler(sessionId));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function parseIntOrUndef(s: string | null): number | undefined {
  if (s === null) return undefined;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

function safeParseJson(body: string): Record<string, unknown> | undefined {
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Start the management HTTP server. Idempotent — second call is a no-op
 * and returns the existing server. Reads `MGMT_PORT` + `MGMT_HOST` from
 * env; defaults to 127.0.0.1:3010 for security (operator-only, not LAN
 * by default).
 */
export function startMgmtServer(): http.Server {
  if (server) return server;
  const port = parseInt(process.env.MGMT_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.MGMT_HOST ?? DEFAULT_HOST;

  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logmsg(`handler threw: ${(err as Error).message ?? err}`);
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } catch {
        // res already partially written — give up.
      }
    });
  });

  server.listen(port, host, () => {
    logmsg(`management server listening on http://${host}:${port}/api/v1/a8/claw`);
  });

  return server;
}

/** Stop the management server. Returns a promise that resolves once closed. */
export async function stopMgmtServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}
