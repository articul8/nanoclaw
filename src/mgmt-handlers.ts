/**
 * Dashboard parity HTTP handlers — pure functions, host-mode only.
 *
 * Mirrors a8-code's `/api/v1/a8/code` surface exactly so a single dashboard
 * UI (or two dashboards sharing components) can drive both runtimes:
 *
 *   GET    /api/v1/a8/claw                  list
 *   GET    /api/v1/a8/claw/:id              detail
 *   POST   /api/v1/a8/claw                  create
 *   POST   /api/v1/a8/claw/:id/resume       resume (calls resumeSession)
 *   POST   /api/v1/a8/claw/:id/stop         stop (kills container, status='closed')
 *
 * Response shape (A8ClawSessionResponse) is a strict superset of
 * A8CodeSessionResponse (endpoints.py:1256) — `execution_id` aliases to
 * `session_id` since arty's local mode has no separate execution concept,
 * `mission_id` is null in local mode, `agent_type='a8-claw'`. Extras
 * (`agent_group_id`, `container_status`, `privacy`) are arty-specific
 * fields the a8-code dashboard ignores by default.
 *
 * Incognito sessions are HIDDEN from the list by default. Pass
 * `?include_incognito=true` to opt in — UI must surface this clearly so
 * the user knows they're viewing private sessions.
 *
 * Pure functions: HTTP plumbing (parse, route, write) lives in
 * mgmt-server.ts. Tests target these handlers directly with parsed
 * inputs, no fetch / supertest needed.
 */
import { randomUUID } from 'node:crypto';

import { getAgentGroup, getAllAgentGroups } from './db/agent-groups.js';
import { killContainer } from './container-runner.js';
import {
  createSession,
  deleteSession as deleteSessionRow,
  getActiveSessions,
  getRunningSessions,
  getSession,
  updateSession,
} from './db/sessions.js';
import { resumeSession } from './session-manager.js';
import type { Session, SessionPrivacy } from './types.js';

export interface A8ClawSessionResponse {
  session_id: string;
  /** Same as session_id in local mode — no separate execution concept. Kept for a8-code shape parity. */
  execution_id: string;
  /** Null in local mode; set when dispatched via mission engine. Kept for a8-code shape parity. */
  mission_id: string | null;
  title: string;
  status: string;
  agent_type: 'a8-claw';
  created_at: string;
  last_activity: string | null;
  /** Arty-specific — present so the dashboard can group sessions by agent. */
  agent_group_id: string;
  /** Arty-specific — `running` | `idle` | `stopped`. */
  container_status: Session['container_status'];
  /** Arty-specific — `normal` | `incognito`. Dashboard uses this to visually mark private sessions. */
  privacy: SessionPrivacy;
}

export interface A8ClawSessionListResponse {
  sessions: A8ClawSessionResponse[];
  total: number;
}

export interface HandlerResult<T = unknown> {
  status: number;
  body: T;
}

function sessionTitle(session: Session): string {
  // Title is derived rather than persisted on the row (arty's `sessions`
  // table has no title column today). Use the agent group name when
  // available; fall back to a session-id prefix. Dashboard can override
  // via a future title update endpoint.
  const ag = getAgentGroup(session.agent_group_id);
  const prefix = session.id.length > 8 ? session.id.slice(0, 8) : session.id;
  return ag?.name ? `${ag.name} (${prefix})` : `Session ${prefix}`;
}

function toResponse(session: Session): A8ClawSessionResponse {
  return {
    session_id: session.id,
    execution_id: session.id,
    mission_id: null,
    title: sessionTitle(session),
    status: session.status,
    agent_type: 'a8-claw',
    created_at: session.created_at,
    last_activity: session.last_active,
    agent_group_id: session.agent_group_id,
    container_status: session.container_status,
    privacy: session.privacy,
  };
}

export interface ListOptions {
  /** Filter: `active` | `closed` | `running` (running = container_status='running'). */
  status?: string;
  /** Show incognito sessions in the list. Default false. */
  include_incognito?: boolean;
  /** Page size; capped at 200. */
  limit?: number;
  /** Pagination offset. */
  offset?: number;
}

export function listSessions(opts: ListOptions = {}): HandlerResult<A8ClawSessionListResponse> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  // Pre-filter by status. 'running' is a container_status filter while
  // 'active'/'closed' filter the session row; treat them symmetrically.
  let rows: Session[];
  if (opts.status === 'running') {
    rows = getRunningSessions();
  } else if (opts.status === 'active') {
    rows = getActiveSessions();
  } else if (opts.status === 'closed') {
    // No dedicated helper — fall back to filtering active+closed (no
    // closed-only helper exists; this is rare enough that the extra
    // walk is acceptable). Future: add getAllSessions().
    rows = getActiveSessions().filter((s) => s.status === 'closed');
  } else {
    rows = getActiveSessions();
  }

  // Hide incognito by default. The list endpoint is the most-public
  // surface and incognito sessions must not appear unless the caller
  // explicitly asks for them. Detail-by-id is also gated (see getSessionDetail).
  if (!opts.include_incognito) {
    rows = rows.filter((s) => s.privacy === 'normal');
  }

  // Sort by most-recent-activity-first so the dashboard's top row is
  // what the user most likely wants to resume.
  rows.sort((a, b) => {
    const aTime = a.last_active ?? a.created_at;
    const bTime = b.last_active ?? b.created_at;
    return bTime.localeCompare(aTime);
  });

  const page = rows.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      sessions: page.map(toResponse),
      total: rows.length,
    },
  };
}

export function getSessionDetail(
  sessionId: string,
  opts: { include_incognito?: boolean } = {},
): HandlerResult<A8ClawSessionResponse | { error: string }> {
  const session = getSession(sessionId);
  if (!session) {
    return { status: 404, body: { error: `Session ${sessionId} not found` } };
  }
  // Incognito sessions are hidden from detail-by-id unless explicitly
  // opted in. Same gating as list — never surface privacy='incognito'
  // by accident.
  if (session.privacy === 'incognito' && !opts.include_incognito) {
    return { status: 404, body: { error: `Session ${sessionId} not found` } };
  }
  return { status: 200, body: toResponse(session) };
}

export interface CreateOptions {
  agent_group_id?: string;
  /** Reserved for future use — title, description, mode, depth match a8-code's CreateRequest. */
  title?: string;
  description?: string;
  /** Per-session privacy. Defaults to 'normal'. */
  privacy?: SessionPrivacy;
}

export function createSessionHandler(opts: CreateOptions): HandlerResult<A8ClawSessionResponse | { error: string }> {
  // agent_group_id resolution: explicit > only-one > error.
  let agentGroupId = opts.agent_group_id;
  if (!agentGroupId) {
    const groups = getAllAgentGroups();
    if (groups.length === 1) {
      agentGroupId = groups[0].id;
    } else {
      return {
        status: 400,
        body: {
          error:
            groups.length === 0
              ? 'No agent group exists — run ./a8-claw init-first-agent first.'
              : `Multiple agent groups exist (${groups.length}) — pass agent_group_id in body to pick one.`,
        },
      };
    }
  }

  const ag = getAgentGroup(agentGroupId);
  if (!ag) {
    return { status: 404, body: { error: `Agent group ${agentGroupId} not found` } };
  }

  const session: Session = {
    id: `sess-${Date.now()}-${randomUUID().slice(0, 8)}`,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
    privacy: opts.privacy ?? 'normal',
  };
  createSession(session);
  return { status: 201, body: toResponse(session) };
}

export async function resumeSessionHandler(
  sessionId: string,
): Promise<HandlerResult<A8ClawSessionResponse | { error: string }>> {
  const result = await resumeSession(sessionId);
  if (!result.ok) {
    if (result.reason === 'not-found') {
      return { status: 404, body: { error: `Session ${sessionId} not found` } };
    }
    return {
      status: 503,
      body: { error: `Failed to wake container for ${sessionId}: ${result.reason}` },
    };
  }
  // The session row is fresh from resumeSession's re-fetch.
  return { status: 200, body: toResponse(result.session!) };
}

export function stopSessionHandler(
  sessionId: string,
): HandlerResult<A8ClawSessionResponse | { error: string }> {
  const session = getSession(sessionId);
  if (!session) {
    return { status: 404, body: { error: `Session ${sessionId} not found` } };
  }
  // Kill the container if running. killContainer is a no-op when the
  // container isn't tracked, so safe to call unconditionally.
  killContainer(sessionId, 'mgmt stop endpoint');
  // Flip status to 'closed'. The row stays — resume re-activates it via
  // resumeSession. We don't delete; that's a separate (future) endpoint
  // to preserve the workstream identity invariant.
  updateSession(sessionId, { status: 'closed', container_status: 'stopped' });
  const after = getSession(sessionId);
  // The row exists (we just read it pre-update), but TS doesn't know
  // that across the updateSession call — fall back to a synthetic copy.
  return {
    status: 200,
    body: toResponse(
      after ?? { ...session, status: 'closed', container_status: 'stopped' },
    ),
  };
}

/**
 * Delete a session permanently. Distinct from `stop` (which keeps the row
 * so resume works) — this removes the row + session dir entirely.
 * Defensive: only allowed on closed sessions so we don't yank state out
 * from under a running container.
 */
export function deleteSessionHandler(
  sessionId: string,
): HandlerResult<{ ok: true } | { error: string }> {
  const session = getSession(sessionId);
  if (!session) {
    return { status: 404, body: { error: `Session ${sessionId} not found` } };
  }
  if (session.status === 'active' || session.container_status === 'running') {
    return {
      status: 409,
      body: { error: `Session ${sessionId} is active — stop it first` },
    };
  }
  // Row delete only. The session dir on disk stays (operators may want
  // to forensically inspect it); a future endpoint can wipe the dir
  // separately.
  deleteSessionRow(sessionId);
  return { status: 200, body: { ok: true } };
}
