/**
 * Unit tests for the pod-boot restore reader.
 *
 * Covers each documented skip path + the happy-path list+download.
 * The tar extraction itself is exercised at integration level (snapshot
 * upload + restore over a real /workspace round-trip is a separate test
 * that needs a Warp stub).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { _resetRestoreContextForTests, restoreSnapshot } from './restore.js';

const ORIG = {
  RESUME_SESSION_ID: process.env.RESUME_SESSION_ID,
  SESSION_ID: process.env.SESSION_ID,
  SESSION_PRIVACY: process.env.SESSION_PRIVACY,
  TENANT_ID: process.env.TENANT_ID,
  USER_ID: process.env.USER_ID,
  WARP_URL: process.env.WARP_URL,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let tmpWorkspace = '';

beforeEach(async () => {
  _resetRestoreContextForTests();
  tmpWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-test-'));
});

afterEach(async () => {
  setEnv(ORIG);
  _resetRestoreContextForTests();
  await fsp.rm(tmpWorkspace, { recursive: true, force: true }).catch(() => {});
});

describe('restoreSnapshot', () => {
  it('no-op when RESUME_SESSION_ID unset', async () => {
    setEnv({
      RESUME_SESSION_ID: undefined,
      SESSION_ID: 'sess-1',
      WARP_URL: 'http://warp.example.com',
      TENANT_ID: 't',
      USER_ID: 'u',
    });
    const result = await restoreSnapshot();
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('no-resume');
  });

  it('refuses when SESSION_PRIVACY=incognito (defensive — dispatcher bug)', async () => {
    setEnv({
      RESUME_SESSION_ID: 'sess-priv-1',
      SESSION_ID: 'sess-priv-1',
      SESSION_PRIVACY: 'incognito',
      WARP_URL: 'http://warp.example.com',
      TENANT_ID: 't',
      USER_ID: 'u',
      WORKSPACE_DIR: tmpWorkspace,
    });
    const fetchMock = mock(() => Promise.resolve(new Response('ok')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await restoreSnapshot();
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('incognito');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when SESSION_ID does not match RESUME_SESSION_ID', async () => {
    setEnv({
      RESUME_SESSION_ID: 'sess-a',
      SESSION_ID: 'sess-b',
      SESSION_PRIVACY: 'normal',
      WARP_URL: 'http://warp.example.com',
      TENANT_ID: 't',
      USER_ID: 'u',
      WORKSPACE_DIR: tmpWorkspace,
    });
    const result = await restoreSnapshot();
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('mismatch');
  });

  it('skips when WARP_URL is unset (standalone mode)', async () => {
    setEnv({
      RESUME_SESSION_ID: 'sess-1',
      SESSION_ID: 'sess-1',
      SESSION_PRIVACY: 'normal',
      WARP_URL: undefined,
      TENANT_ID: 't',
      USER_ID: 'u',
      WORKSPACE_DIR: tmpWorkspace,
    });
    const result = await restoreSnapshot();
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('no-warp');
  });

  it('refuses when workspace already has inbound.db (local-mode safety)', async () => {
    // Simulate local-mode where the host pre-mounted the session dir.
    await fsp.writeFile(path.join(tmpWorkspace, 'inbound.db'), 'pretend-sqlite');
    setEnv({
      RESUME_SESSION_ID: 'sess-1',
      SESSION_ID: 'sess-1',
      SESSION_PRIVACY: 'normal',
      WARP_URL: 'http://warp.example.com',
      TENANT_ID: 't',
      USER_ID: 'u',
      WORKSPACE_DIR: tmpWorkspace,
    });
    const fetchMock = mock(() => Promise.resolve(new Response('[]')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await restoreSnapshot();
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('workspace-not-empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no-snapshot when Warp list is empty (fresh session, no checkpoints)', async () => {
    setEnv({
      RESUME_SESSION_ID: 'sess-fresh',
      SESSION_ID: 'sess-fresh',
      SESSION_PRIVACY: 'normal',
      WARP_URL: 'http://warp.example.com',
      TENANT_ID: 't',
      USER_ID: 'u',
      WORKSPACE_DIR: tmpWorkspace,
    });
    const fetchMock = mock((url: string) => {
      expect(url).toContain('/files?');
      expect(url).toContain('tags=arty-snapshot%2Csess-fresh');
      return Promise.resolve(new Response(JSON.stringify({ items: [], total: 0 })));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await restoreSnapshot();
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('no-snapshot');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles bare-array list response shape', async () => {
    // Warp surface might return bare array vs envelope; restore tolerates both.
    setEnv({
      RESUME_SESSION_ID: 'sess-fresh',
      SESSION_ID: 'sess-fresh',
      SESSION_PRIVACY: 'normal',
      WARP_URL: 'http://warp.example.com',
      TENANT_ID: 't',
      USER_ID: 'u',
      WORKSPACE_DIR: tmpWorkspace,
    });
    const fetchMock = mock(() => Promise.resolve(new Response('[]')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await restoreSnapshot();
    expect(result.reason).toBe('no-snapshot');
  });

  it('returns error reason when Warp list call fails', async () => {
    setEnv({
      RESUME_SESSION_ID: 'sess-1',
      SESSION_ID: 'sess-1',
      SESSION_PRIVACY: 'normal',
      WARP_URL: 'http://warp.example.com',
      TENANT_ID: 't',
      USER_ID: 'u',
      WORKSPACE_DIR: tmpWorkspace,
    });
    const fetchMock = mock(() => Promise.resolve(new Response('boom', { status: 500 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await restoreSnapshot();
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.detail).toContain('500');
  });

  it('sends X-Tenant-ID + X-User-ID + X-Mission-Token headers on list call', async () => {
    setEnv({
      RESUME_SESSION_ID: 'sess-h',
      SESSION_ID: 'sess-h',
      SESSION_PRIVACY: 'normal',
      WARP_URL: 'http://warp.example.com',
      TENANT_ID: 'acme',
      USER_ID: 'arun',
      MISSION_TOKEN: 'mt-abc',
      WORKSPACE_DIR: tmpWorkspace,
    });
    let captured: Record<string, string> = {};
    const fetchMock = mock((_url: string, init: RequestInit) => {
      captured = init.headers as Record<string, string>;
      return Promise.resolve(new Response(JSON.stringify({ items: [] })));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await restoreSnapshot();
    expect(captured['X-Tenant-ID']).toBe('acme');
    expect(captured['X-User-ID']).toBe('arun');
    expect(captured['X-Mission-Token']).toBe('mt-abc');
    delete process.env.MISSION_TOKEN;
  });
});
