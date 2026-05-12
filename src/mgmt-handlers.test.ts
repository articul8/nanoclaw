/**
 * Unit tests for the dashboard parity HTTP handlers.
 *
 * Tests target the pure handler functions (mgmt-handlers.ts) directly,
 * bypassing the HTTP plumbing in mgmt-server.ts. The DB layer uses
 * initTestDb() so we don't need a real ./data/v2.db.
 *
 * resumeSession and killContainer are mocked so we don't need Docker or
 * the OneCLI gateway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { createSession, getSession } from './db/sessions.js';
import type { Session } from './types.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

const handlers = await import('./mgmt-handlers.js');
const { killContainer, wakeContainer } = await import('./container-runner.js');

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
    privacy: 'normal',
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  vi.mocked(wakeContainer).mockReset().mockResolvedValue(true);
  vi.mocked(killContainer).mockReset();
});

afterEach(() => {
  closeDb();
});

describe('listSessions', () => {
  it('returns active sessions by default, ordered most-recent first', () => {
    createSession(makeSession({ id: 'sess-a', last_active: '2026-05-01T00:00:00Z' }));
    createSession(makeSession({ id: 'sess-b', last_active: '2026-05-12T00:00:00Z' }));
    createSession(makeSession({ id: 'sess-c', last_active: '2026-05-05T00:00:00Z' }));
    const r = handlers.listSessions();
    expect(r.status).toBe(200);
    expect(r.body.sessions.map((s) => s.session_id)).toEqual(['sess-b', 'sess-c', 'sess-a']);
    expect(r.body.total).toBe(3);
  });

  it('hides incognito sessions by default', () => {
    createSession(makeSession({ id: 'sess-pub' }));
    createSession(makeSession({ id: 'sess-priv', privacy: 'incognito' }));
    const r = handlers.listSessions();
    expect(r.body.sessions.map((s) => s.session_id)).toEqual(['sess-pub']);
    expect(r.body.total).toBe(1);
  });

  it('includes incognito when include_incognito=true', () => {
    createSession(makeSession({ id: 'sess-pub' }));
    createSession(makeSession({ id: 'sess-priv', privacy: 'incognito' }));
    const r = handlers.listSessions({ include_incognito: true });
    expect(r.body.total).toBe(2);
  });

  it('caps page size at 200', () => {
    const r = handlers.listSessions({ limit: 9999 });
    // No sessions exist — just verify it didn't throw.
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
  });

  it('filters by status=running (container_status, not row status)', () => {
    createSession(makeSession({ id: 'sess-a', container_status: 'running' }));
    createSession(makeSession({ id: 'sess-b', container_status: 'stopped' }));
    const r = handlers.listSessions({ status: 'running' });
    expect(r.body.sessions.map((s) => s.session_id)).toEqual(['sess-a']);
  });

  it('emits arty-specific fields alongside a8-code parity fields', () => {
    createSession(makeSession({ id: 'sess-shape' }));
    const r = handlers.listSessions();
    const s = r.body.sessions[0];
    expect(s.session_id).toBe('sess-shape');
    expect(s.execution_id).toBe('sess-shape'); // alias in local mode
    expect(s.mission_id).toBeNull();
    expect(s.agent_type).toBe('a8-claw');
    expect(s.agent_group_id).toBe('ag-1');
    expect(s.container_status).toBe('stopped');
    expect(s.privacy).toBe('normal');
  });
});

describe('getSessionDetail', () => {
  it('returns 404 for unknown session', () => {
    const r = handlers.getSessionDetail('nope');
    expect(r.status).toBe(404);
  });

  it('hides incognito session as 404 by default', () => {
    createSession(makeSession({ id: 'sess-priv', privacy: 'incognito' }));
    const r = handlers.getSessionDetail('sess-priv');
    expect(r.status).toBe(404);
  });

  it('returns incognito session when include_incognito=true', () => {
    createSession(makeSession({ id: 'sess-priv', privacy: 'incognito' }));
    const r = handlers.getSessionDetail('sess-priv', { include_incognito: true });
    expect(r.status).toBe(200);
  });
});

describe('createSessionHandler', () => {
  it('creates a session against the sole agent group when one exists', () => {
    const r = handlers.createSessionHandler({});
    expect(r.status).toBe(201);
    const body = r.body as { session_id: string; agent_group_id: string; privacy: string };
    expect(body.agent_group_id).toBe('ag-1');
    expect(body.privacy).toBe('normal');
    // Persisted
    expect(getSession(body.session_id)).toBeDefined();
  });

  it('errors when no agent group exists', () => {
    // Reset DB without any agent group.
    closeDb();
    const db = initTestDb();
    runMigrations(db);
    const r = handlers.createSessionHandler({});
    expect(r.status).toBe(400);
  });

  it('errors when multiple agent groups exist and none picked', () => {
    createAgentGroup({
      id: 'ag-2',
      name: 'Other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const r = handlers.createSessionHandler({});
    expect(r.status).toBe(400);
  });

  it('respects explicit privacy=incognito', () => {
    const r = handlers.createSessionHandler({ privacy: 'incognito' });
    expect(r.status).toBe(201);
    const body = r.body as { privacy: string };
    expect(body.privacy).toBe('incognito');
  });
});

describe('resumeSessionHandler', () => {
  it('400-rejects unknown session as 404', async () => {
    const r = await handlers.resumeSessionHandler('nope');
    expect(r.status).toBe(404);
  });

  it('flips closed session to active and reports success', async () => {
    createSession(makeSession({ status: 'closed' }));
    const r = await handlers.resumeSessionHandler('sess-1');
    expect(r.status).toBe(200);
    const body = r.body as { status: string };
    expect(body.status).toBe('active');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when container wake fails', async () => {
    vi.mocked(wakeContainer).mockResolvedValue(false);
    createSession(makeSession({ status: 'closed' }));
    const r = await handlers.resumeSessionHandler('sess-1');
    expect(r.status).toBe(503);
  });
});

describe('stopSessionHandler', () => {
  it('404 for unknown session', () => {
    const r = handlers.stopSessionHandler('nope');
    expect(r.status).toBe(404);
  });

  it('kills container, flips status to closed, container_status to stopped', () => {
    createSession(makeSession({ status: 'active', container_status: 'running' }));
    const r = handlers.stopSessionHandler('sess-1');
    expect(r.status).toBe(200);
    expect(killContainer).toHaveBeenCalledWith('sess-1', expect.any(String));
    const after = getSession('sess-1');
    expect(after?.status).toBe('closed');
    expect(after?.container_status).toBe('stopped');
  });
});

describe('deleteSessionHandler', () => {
  it('404 for unknown session', () => {
    const r = handlers.deleteSessionHandler('nope');
    expect(r.status).toBe(404);
  });

  it('refuses to delete an active session (caller must stop first)', () => {
    createSession(makeSession({ status: 'active', container_status: 'running' }));
    const r = handlers.deleteSessionHandler('sess-1');
    expect(r.status).toBe(409);
  });

  it('deletes a closed session', () => {
    createSession(makeSession({ status: 'closed', container_status: 'stopped' }));
    const r = handlers.deleteSessionHandler('sess-1');
    expect(r.status).toBe(200);
    expect(getSession('sess-1')).toBeUndefined();
  });
});
