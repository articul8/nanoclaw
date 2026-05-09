import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMainModelMode,
  getMainModelProvider,
  resolveMainModelConfig,
} from './main-model-route.js';

const ORIG = {
  TENANT_ID: process.env.TENANT_ID,
  USER_ID: process.env.USER_ID,
  MAIN_MODEL_ROUTE: process.env.MAIN_MODEL_ROUTE,
  MAIN_MODEL_PROVIDER: process.env.MAIN_MODEL_PROVIDER,
  MAIN_MODEL_BASE_URL: process.env.MAIN_MODEL_BASE_URL,
  MAIN_MODEL_API_KEY: process.env.MAIN_MODEL_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  DEFAULT_LLM_MODEL: process.env.DEFAULT_LLM_MODEL,
  MODEL_MANAGER_URL: process.env.MODEL_MANAGER_URL,
};

function setAll(opts: {
  tenant?: string;
  user?: string;
  route?: string;
  provider?: string;
  baseUrl?: string;
  key?: string;
  model?: string;
  mmUrl?: string;
}): void {
  process.env.TENANT_ID = opts.tenant ?? 'tenant-test';
  process.env.USER_ID = opts.user ?? 'user-test';
  for (const [k, v] of [
    ['MAIN_MODEL_ROUTE', opts.route],
    ['MAIN_MODEL_PROVIDER', opts.provider],
    ['MAIN_MODEL_BASE_URL', opts.baseUrl],
    ['MAIN_MODEL_API_KEY', opts.key],
    ['DEFAULT_LLM_MODEL', opts.model],
    ['MODEL_MANAGER_URL', opts.mmUrl],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Always clear the legacy fallback so tests aren't ambiguous
  delete process.env.ANTHROPIC_API_KEY;
}

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe('getMainModelMode', () => {
  it('defaults to "direct" when env unset', () => {
    delete process.env.MAIN_MODEL_ROUTE;
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

describe('getMainModelProvider', () => {
  it('defaults to "anthropic" when unset', () => {
    delete process.env.MAIN_MODEL_PROVIDER;
    expect(getMainModelProvider()).toBe('anthropic');
  });

  it('returns "google" when env=google', () => {
    process.env.MAIN_MODEL_PROVIDER = 'google';
    expect(getMainModelProvider()).toBe('google');
  });

  it('returns "openai-compat" when env=openai-compat', () => {
    process.env.MAIN_MODEL_PROVIDER = 'openai-compat';
    expect(getMainModelProvider()).toBe('openai-compat');
  });

  it('falls back to "anthropic" for unrecognized values', () => {
    process.env.MAIN_MODEL_PROVIDER = 'cohere';
    expect(getMainModelProvider()).toBe('anthropic');
  });
});

describe('resolveMainModelConfig — direct mode, anthropic provider (default)', () => {
  beforeEach(() => {
    setAll({ route: 'direct', provider: 'anthropic', key: 'sk-ant-test', model: 'claude-sonnet-4-6' });
  });

  it('uses default Anthropic base URL when MAIN_MODEL_BASE_URL unset', async () => {
    const cfg = await resolveMainModelConfig({ tenantId: 'tenant-test', userId: 'user-test' });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.apiKey).toBe('sk-ant-test');
    expect(cfg.containerEnv).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
  });

  it('honors MAIN_MODEL_BASE_URL override (e.g. Anthropic-compatible proxy)', async () => {
    setAll({ route: 'direct', provider: 'anthropic', baseUrl: 'https://my-proxy.example/v1', key: 'k', model: 'm' });
    const cfg = await resolveMainModelConfig({ tenantId: 't', userId: 'u' });
    expect(cfg.baseUrl).toBe('https://my-proxy.example/v1');
    expect(cfg.containerEnv.ANTHROPIC_BASE_URL).toBe('https://my-proxy.example/v1');
  });
});

describe('resolveMainModelConfig — direct mode, google provider', () => {
  beforeEach(() => {
    setAll({ route: 'direct', provider: 'google', key: 'gk-test', model: 'gemini-2.0-flash-exp' });
  });

  it('uses Google default base URL + GOOGLE_API_KEY env', async () => {
    const cfg = await resolveMainModelConfig({ tenantId: 't', userId: 'u' });
    expect(cfg.provider).toBe('google');
    expect(cfg.baseUrl).toBe('https://generativelanguage.googleapis.com');
    expect(cfg.containerEnv).toEqual({
      GOOGLE_GENAI_BASE_URL: 'https://generativelanguage.googleapis.com',
      GOOGLE_API_KEY: 'gk-test',
    });
  });
});

describe('resolveMainModelConfig — direct mode, openai-compat provider', () => {
  beforeEach(() => {
    setAll({ route: 'direct', provider: 'openai-compat', key: 'sk-oai-test', model: 'gpt-4o' });
  });

  it('uses OpenAI default base URL + OPENAI_API_KEY env', async () => {
    const cfg = await resolveMainModelConfig({ tenantId: 't', userId: 'u' });
    expect(cfg.provider).toBe('openai-compat');
    expect(cfg.baseUrl).toBe('https://api.openai.com');
    expect(cfg.containerEnv).toEqual({
      OPENAI_BASE_URL: 'https://api.openai.com',
      OPENAI_API_KEY: 'sk-oai-test',
    });
  });

  it('honors a custom base URL for self-hosted / Together / Fireworks / etc.', async () => {
    setAll({
      route: 'direct',
      provider: 'openai-compat',
      baseUrl: 'https://api.together.xyz/v1',
      key: 'tg-key',
      model: 'meta-llama/Llama-3.3-70B',
    });
    const cfg = await resolveMainModelConfig({ tenantId: 't', userId: 'u' });
    expect(cfg.baseUrl).toBe('https://api.together.xyz/v1');
    expect(cfg.containerEnv.OPENAI_BASE_URL).toBe('https://api.together.xyz/v1');
  });
});

describe('resolveMainModelConfig — model_manager mode', () => {
  beforeEach(() => {
    setAll({
      route: 'model_manager',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      mmUrl: 'http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local:8000',
    });
  });

  it('calls /resolve, returns MM run URL, no apiKey, anthropic placeholder auth', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ endpoint_id: 'uuid-abc-123' }), { status: 200 }));
    vi.stubGlobal('fetch', mock);

    const cfg = await resolveMainModelConfig({ tenantId: 'tenant-test', userId: 'user-test' });

    expect(cfg.mode).toBe('model_manager');
    expect(cfg.baseUrl).toBe('http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local:8000/run/uuid-abc-123');
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.containerEnv).toEqual({
      ANTHROPIC_BASE_URL: 'http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local:8000/run/uuid-abc-123',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
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

describe('resolveMainModelConfig — overrides', () => {
  it('opts.provider overrides MAIN_MODEL_PROVIDER env', async () => {
    setAll({ route: 'direct', provider: 'anthropic', key: 'k', model: 'm' });
    const cfg = await resolveMainModelConfig({ tenantId: 't', userId: 'u', provider: 'openai-compat' });
    expect(cfg.provider).toBe('openai-compat');
    expect(cfg.containerEnv.OPENAI_BASE_URL).toBe('https://api.openai.com');
  });

  it('opts.model overrides DEFAULT_LLM_MODEL env', async () => {
    setAll({ route: 'direct', provider: 'anthropic', key: 'k', model: 'claude-sonnet-4-6' });
    const cfg = await resolveMainModelConfig({ tenantId: 't', userId: 'u', model: 'claude-opus-4-7' });
    expect(cfg.model).toBe('claude-opus-4-7');
  });
});
