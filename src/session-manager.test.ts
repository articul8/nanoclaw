/**
 * Unit tests for resumeSession — local-mode resume.
 *
 * Covers:
 *   - not-found: missing session returns ok=false, reason='not-found'
 *   - reactivation: a closed session flips status='active' before wake
 *   - already-active happy path: no flip, wakeContainer triggers spawn
 *   - already-running: wakeContainer no-ops, spawned=false
 *   - wake failure: ok=false, reason='wake-failed'
 *
 * wakeContainer is mocked so we don't need Docker. The DB layer uses the
 * in-memory test DB from initTestDb().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { createSession, getSession, updateSession } from './db/sessions.js';
import type { Session } from './types.js';

// vitest hoists vi.mock above all imports so the mocked version is what
// resumeSession's dynamic import sees.
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn(),
}));
const { wakeContainer } = await import('./container-runner.js');
const { resumeSession } = await import('./session-manager.js');

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
  vi.mocked(wakeContainer).mockReset();
  vi.mocked(wakeContainer).mockResolvedValue(true);
});

afterEach(() => {
  closeDb();
});

describe('resumeSession', () => {
  it('returns not-found when session id does not exist', async () => {
    const result = await resumeSession('does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-found');
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('reactivates a closed session and wakes the container', async () => {
    createSession(makeSession({ status: 'closed', container_status: 'stopped' }));
    const result = await resumeSession('sess-1');
    expect(result.ok).toBe(true);
    expect(result.reactivated).toBe(true);
    expect(result.spawned).toBe(true);
    expect(result.session?.status).toBe('active');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('does not flip status when session is already active, but still wakes', async () => {
    createSession(makeSession({ status: 'active', container_status: 'stopped' }));
    const result = await resumeSession('sess-1');
    expect(result.ok).toBe(true);
    expect(result.reactivated).toBe(false);
    expect(result.spawned).toBe(true);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('reports spawned=false when the container was already running', async () => {
    createSession(makeSession({ status: 'active', container_status: 'running' }));
    const result = await resumeSession('sess-1');
    expect(result.ok).toBe(true);
    expect(result.reactivated).toBe(false);
    expect(result.spawned).toBe(false);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('propagates wake failure as ok=false, reason=wake-failed', async () => {
    vi.mocked(wakeContainer).mockResolvedValue(false);
    createSession(makeSession({ status: 'closed', container_status: 'stopped' }));
    const result = await resumeSession('sess-1');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('wake-failed');
    // Reactivation still happened — caller can choose to retry the wake
    // without re-flipping the status row.
    expect(result.reactivated).toBe(true);
  });

  it('preserves privacy flag across resume (immutable session identity)', async () => {
    createSession(makeSession({ status: 'closed', privacy: 'incognito' }));
    await resumeSession('sess-1');
    const after = getSession('sess-1');
    expect(after?.privacy).toBe('incognito');
    expect(after?.status).toBe('active');
  });

  it('preserves session id across resume (durable workstream identity)', async () => {
    createSession(makeSession({ id: 'sess-durable', status: 'closed' }));
    const result = await resumeSession('sess-durable');
    expect(result.session?.id).toBe('sess-durable');
  });
});
