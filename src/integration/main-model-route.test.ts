import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMainModelMode, resolveMainModelConfig } from './main-model-route.js';

const ORIG = {
  TENANT_ID: process.env.TENANT_ID,
  USER_ID: process.env.USER_ID,
  MAIN_MODEL_ROUTE: process.env.MAIN_MODEL_ROUTE,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  DEFAULT_LLM_MODEL: process.env.DEFAULT_LLM_MODEL,
  MODEL_MANAGER_URL: process.env.MODEL_MANAGER_URL,
};

function setAll(opts: {
  tenant?: string;
  user?: string;
  route?: string;
  key?: string;
  model?: string;
  mmUrl?: string;
}): void {
  process.env.TENANT_ID = opts.tenant ?? 'tenant-test';
  process.env.USER_ID = opts.user ?? 'user-test';
  if (opts.route === undefined) delete process.env.MAIN_MODEL_ROUTE;
  else process.env.MAIN_MODEL_ROUTE = opts.route;
  if (opts.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = opts.key;
  if (opts.model === undefined) delete process.env.DEFAULT_LLM_MODEL;
  else process.env.DEFAULT_LLM_MODEL = opts.model;
  if (opts.mmUrl === undefined) delete process.env.MODEL_MANAGER_URL;
  else process.env.MODEL_MANAGER_URL = opts.mmUrl;
}

afterEach(() => {
  if (ORIG.TENANT_ID === undefined) delete process.env.TENANT_ID;
  else process.env.TENANT_ID = ORIG.TENANT_ID;
  if (ORIG.USER_ID === undefined) delete process.env.USER_ID;
  else process.env.USER_ID = ORIG.USER_ID;
  if (ORIG.MAIN_MODEL_ROUTE === undefined) delete process.env.MAIN_MODEL_ROUTE;
  else process.env.MAIN_MODEL_ROUTE = ORIG.MAIN_MODEL_ROUTE;
  if (ORIG.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG.ANTHROPIC_API_KEY;
  if (ORIG.DEFAULT_LLM_MODEL === undefined) delete process.env.DEFAULT_LLM_MODEL;
  else process.env.DEFAULT_LLM_MODEL = ORIG.DEFAULT_LLM_MODEL;
  if (ORIG.MODEL_MANAGER_URL === undefined) delete process.env.MODEL_MANAGER_URL;
  else process.env.MODEL_MANAGER_URL = ORIG.MODEL_MANAGER_URL;
  vi.unstubAllGlobals();
});

describe('getMainModelMode', () => {
  it('defaults to "direct" when env unset', () => {
    delete process.env.MAIN_MODEL_ROUTE;
    expect(getMainModelMode()).toBe('direct');
  });

  it('returns "direct" when env=direct', () => {
    process.env.MAIN_MODEL_ROUTE = 'direct';
    expect(getMainModelMode()).toBe('direct');
  });

  it('returns "model_manager" when env=model_manager', () => {
    process.env.MAIN_MODEL_ROUTE = 'model_manager';
    expect(getMainModelMode()).toBe('model_manager');
  });

  it('falls back to "direct" for unrecognized values', () => {
    process.env.MAIN_MODEL_ROUTE = 'invalid';
    expect(getMainModelMode()).toBe('direct');
  });
});

describe('resolveMainModelConfig — direct mode', () => {
  beforeEach(() => {
    setAll({ route: 'direct', key: 'sk-ant-test', model: 'claude-sonnet-4-6' });
  });

  it('returns Anthropic base URL + key + model', async () => {
    const cfg = await resolveMainModelConfig({ tenantId: 'tenant-test', userId: 'user-test' });
    expect(cfg).toEqual({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      mode: 'direct',
      keySource: 'env',
      model: 'claude-sonnet-4-6',
    });
  });

  it('throws if no key resolvable', async () => {
    setAll({ route: 'direct', key: undefined, model: 'claude-sonnet-4-6' });
    await expect(resolveMainModelConfig({ tenantId: 't', userId: 'u' })).rejects.toThrow(
      /no main-model API key resolved/,
    );
  });

  it('throws if no model name available', async () => {
    setAll({ route: 'direct', key: 'k', model: undefined });
    await expect(resolveMainModelConfig({ tenantId: 't', userId: 'u' })).rejects.toThrow(/no model name available/);
  });

  it('honors model override over env default', async () => {
    setAll({ route: 'direct', key: 'k', model: 'claude-sonnet-4-6' });
    const cfg = await resolveMainModelConfig({ tenantId: 't', userId: 'u', model: 'claude-opus-4-7' });
    expect(cfg.model).toBe('claude-opus-4-7');
  });
});

describe('resolveMainModelConfig — model_manager mode', () => {
  beforeEach(() => {
    setAll({
      route: 'model_manager',
      model: 'claude-sonnet-4-6',
      mmUrl: 'http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local:8000',
    });
  });

  it('calls /resolve and returns MM run URL with the endpoint UUID', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ endpoint_id: 'uuid-abc-123' }), { status: 200 }));
    vi.stubGlobal('fetch', mock);

    const cfg = await resolveMainModelConfig({ tenantId: 'tenant-test', userId: 'user-test' });

    expect(cfg).toEqual({
      baseUrl: 'http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local:8000/run/uuid-abc-123',
      mode: 'model_manager',
      model: 'claude-sonnet-4-6',
    });
    expect(cfg.apiKey).toBeUndefined();

    // verify the /resolve call shape
    expect(mock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local:8000/resolve');
    expect(calledInit.method).toBe('POST');
    expect(calledInit.body).toBe(JSON.stringify({ identifier: 'claude-sonnet-4-6' }));
    expect(calledInit.headers).toMatchObject({
      'X-Tenant-ID': 'tenant-test',
      'X-User-ID': 'user-test',
      'Content-Type': 'application/json',
    });
  });

  it('throws if MODEL_MANAGER_URL is unset', async () => {
    delete process.env.MODEL_MANAGER_URL;
    await expect(resolveMainModelConfig({ tenantId: 't', userId: 'u' })).rejects.toThrow(
      /MODEL_MANAGER_URL env required when MAIN_MODEL_ROUTE=model_manager/,
    );
  });

  it('throws if /resolve returns non-OK status', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('not found', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', mock);
    await expect(resolveMainModelConfig({ tenantId: 't', userId: 'u' })).rejects.toThrow(
      /Model Manager \/resolve failed for "claude-sonnet-4-6": 404/,
    );
  });

  it('throws if /resolve returns no endpoint_id', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    await expect(resolveMainModelConfig({ tenantId: 't', userId: 'u' })).rejects.toThrow(/returned no endpoint_id/);
  });
});
