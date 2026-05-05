/**
 * Unit tests for the tenant context HTTP wrapper.
 *
 * Covers:
 *   - env-driven reads of TENANT_ID / USER_ID / MISSION_TOKEN
 *   - fail-fast when either tenant or user is missing (security invariant)
 *   - header injection on platformFetch
 *   - per-call missionToken override
 *   - platformPostJson convenience (Content-Type + serialization)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { platformFetch, platformPostJson, readTenantContext } from './tenant-context.js';

const ORIG = {
  TENANT_ID: process.env.TENANT_ID,
  USER_ID: process.env.USER_ID,
  MISSION_TOKEN: process.env.MISSION_TOKEN,
};

function setEnv(t?: string, u?: string, m?: string): void {
  if (t === undefined) delete process.env.TENANT_ID;
  else process.env.TENANT_ID = t;
  if (u === undefined) delete process.env.USER_ID;
  else process.env.USER_ID = u;
  if (m === undefined) delete process.env.MISSION_TOKEN;
  else process.env.MISSION_TOKEN = m;
}

afterEach(() => {
  setEnv(ORIG.TENANT_ID, ORIG.USER_ID, ORIG.MISSION_TOKEN);
  vi.unstubAllGlobals();
});

describe('readTenantContext', () => {
  it('returns env values when both tenant and user are set', () => {
    setEnv('tenant-acme', 'user-arun', 'mt-abc');
    expect(readTenantContext()).toEqual({
      tenantId: 'tenant-acme',
      userId: 'user-arun',
      missionToken: 'mt-abc',
    });
  });

  it('returns empty missionToken when MISSION_TOKEN unset', () => {
    setEnv('tenant-acme', 'user-arun', undefined);
    expect(readTenantContext().missionToken).toBe('');
  });

  it('throws when TENANT_ID is missing', () => {
    setEnv(undefined, 'user-arun');
    expect(() => readTenantContext()).toThrow(/TENANT_ID and USER_ID must both be set/);
  });

  it('throws when USER_ID is missing', () => {
    setEnv('tenant-acme', undefined);
    expect(() => readTenantContext()).toThrow(/TENANT_ID and USER_ID must both be set/);
  });

  it('throws when both are empty strings', () => {
    setEnv('', '');
    expect(() => readTenantContext()).toThrow(/TENANT_ID and USER_ID must both be set/);
  });
});

describe('platformFetch', () => {
  beforeEach(() => {
    setEnv('tenant-acme', 'user-arun');
  });

  it('injects X-Tenant-ID and X-User-ID on every call', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);

    await platformFetch('https://example.com/api');

    expect(mock).toHaveBeenCalledTimes(1);
    const init = mock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      'X-Tenant-ID': 'tenant-acme',
      'X-User-ID': 'user-arun',
    });
    expect((init.headers as Record<string, string>)['X-Mission-Token']).toBeUndefined();
  });

  it('injects X-Mission-Token from MISSION_TOKEN env when set', async () => {
    setEnv('tenant-acme', 'user-arun', 'mt-from-env');
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);

    await platformFetch('https://example.com/api');

    const init = mock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Mission-Token']).toBe('mt-from-env');
  });

  it('per-call missionToken overrides env', async () => {
    setEnv('tenant-acme', 'user-arun', 'mt-from-env');
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);

    await platformFetch('https://example.com/api', { missionToken: 'mt-override' });

    const init = mock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Mission-Token']).toBe('mt-override');
  });

  it('preserves caller-supplied headers alongside platform headers', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);

    await platformFetch('https://example.com/api', {
      headers: { 'X-Custom': 'value', 'Accept': 'application/json' },
    });

    const init = mock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      'X-Tenant-ID': 'tenant-acme',
      'X-User-ID': 'user-arun',
      'X-Custom': 'value',
      'Accept': 'application/json',
    });
  });

  it('refuses to call when tenant context is broken', async () => {
    setEnv(undefined, 'user-arun');
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);

    await expect(platformFetch('https://example.com/api')).rejects.toThrow(
      /TENANT_ID and USER_ID must both be set/
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it('refuses to call denied LLM-provider URLs (egress allowlist)', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);

    await expect(platformFetch('https://api.anthropic.com/v1/messages')).rejects.toThrow(
      /direct call to api\.anthropic\.com is blocked/
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('platformPostJson', () => {
  beforeEach(() => {
    setEnv('tenant-acme', 'user-arun');
  });

  it('sets Content-Type, serializes body, uses POST', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);

    await platformPostJson('https://example.com/api', { foo: 'bar', n: 42 });

    expect(mock).toHaveBeenCalledTimes(1);
    const init = mock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Tenant-ID': 'tenant-acme',
      'X-User-ID': 'user-arun',
    });
    expect(init.body).toBe(JSON.stringify({ foo: 'bar', n: 42 }));
  });
});
