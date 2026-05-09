import { afterEach, describe, expect, it } from 'vitest';

import { KNOWN_LLM_PROVIDER_HOSTS, assertAllowed, isDenied } from './egress-allowlist.js';

const ORIG = {
  MAIN_MODEL_ROUTE: process.env.MAIN_MODEL_ROUTE,
  MAIN_MODEL_PROVIDER: process.env.MAIN_MODEL_PROVIDER,
  MAIN_MODEL_BASE_URL: process.env.MAIN_MODEL_BASE_URL,
};

function setEnv(opts: { route?: string; provider?: string; baseUrl?: string }): void {
  for (const [k, v] of [
    ['MAIN_MODEL_ROUTE', opts.route],
    ['MAIN_MODEL_PROVIDER', opts.provider],
    ['MAIN_MODEL_BASE_URL', opts.baseUrl],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('isDenied — provider-aware allow/deny', () => {
  it('non-LLM-provider hosts are not denied (NetworkPolicy is enforcer)', () => {
    setEnv({ route: 'direct', provider: 'anthropic' });
    expect(isDenied('http://aks-warp-service.aks-warp-apps.svc.cluster.local:8085/m/events')).toBe(false);
    expect(isDenied('https://api.slack.com/webhook')).toBe(false);
    expect(isDenied('https://api.telegram.org/bot/sendMessage')).toBe(false);
    expect(isDenied('https://my-self-hosted-vllm.example.com/v1/chat')).toBe(false);
  });

  it('all LLM provider hosts are denied when route != direct', () => {
    setEnv({ route: 'model_manager', provider: 'anthropic' });
    for (const host of KNOWN_LLM_PROVIDER_HOSTS) {
      expect(isDenied(`https://${host}/v1/anything`)).toBe(true);
    }
  });

  it('all LLM provider hosts are denied when MAIN_MODEL_ROUTE is unset', () => {
    setEnv({ provider: 'anthropic' }); // route unset
    for (const host of KNOWN_LLM_PROVIDER_HOSTS) {
      expect(isDenied(`https://${host}/v1/x`)).toBe(true);
    }
  });
});

describe('isDenied — anthropic configured', () => {
  it('api.anthropic.com allowed; others denied', () => {
    setEnv({ route: 'direct', provider: 'anthropic' });
    expect(isDenied('https://api.anthropic.com/v1/messages')).toBe(false);
    expect(isDenied('https://api.openai.com/v1/x')).toBe(true);
    expect(isDenied('https://generativelanguage.googleapis.com/v1/x')).toBe(true);
    expect(isDenied('https://api.cohere.ai/x')).toBe(true);
  });
});

describe('isDenied — google configured', () => {
  it('generativelanguage.googleapis.com allowed; others denied', () => {
    setEnv({ route: 'direct', provider: 'google' });
    expect(isDenied('https://generativelanguage.googleapis.com/v1/models')).toBe(false);
    expect(isDenied('https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isDenied('https://api.openai.com/v1/x')).toBe(true);
  });
});

describe('isDenied — openai-compat configured', () => {
  it('api.openai.com allowed by default; others denied', () => {
    setEnv({ route: 'direct', provider: 'openai-compat' });
    expect(isDenied('https://api.openai.com/v1/chat/completions')).toBe(false);
    expect(isDenied('https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isDenied('https://generativelanguage.googleapis.com/v1/x')).toBe(true);
  });

  it('custom MAIN_MODEL_BASE_URL allows the configured custom host', () => {
    setEnv({ route: 'direct', provider: 'openai-compat', baseUrl: 'https://api.together.xyz/v1' });
    expect(isDenied('https://api.together.xyz/v1/chat/completions')).toBe(false);
    // Default openai host is no longer the configured one — denied
    expect(isDenied('https://api.openai.com/v1/x')).toBe(true);
  });

  it('custom hosts NOT in KNOWN_LLM_PROVIDER_HOSTS pass through (NetworkPolicy enforces)', () => {
    setEnv({ route: 'direct', provider: 'openai-compat', baseUrl: 'https://my-vllm.example.com/v1' });
    expect(isDenied('https://my-vllm.example.com/v1/chat')).toBe(false);
  });
});

describe('isDenied — malformed', () => {
  it('returns false for malformed URLs (defer to fetch)', () => {
    expect(isDenied('not-a-url')).toBe(false);
    expect(isDenied('')).toBe(false);
  });
});

describe('assertAllowed', () => {
  it('returns silently for allowed URLs', () => {
    setEnv({ route: 'direct', provider: 'anthropic' });
    expect(() => assertAllowed('http://aks-warp-service.aks-warp-apps.svc.cluster.local:8085/foo')).not.toThrow();
    expect(() => assertAllowed('https://api.anthropic.com/v1/messages')).not.toThrow();
    expect(() => assertAllowed('not-a-url')).not.toThrow();
  });

  it('throws with a non-direct-route reason when MAIN_MODEL_ROUTE != direct', () => {
    setEnv({ route: 'model_manager', provider: 'anthropic' });
    expect(() => assertAllowed('https://api.anthropic.com/v1/messages')).toThrow(
      /MAIN_MODEL_ROUTE is "model_manager", not "direct"/,
    );
  });

  it('throws with a non-configured-provider reason when wrong provider', () => {
    setEnv({ route: 'direct', provider: 'anthropic' });
    expect(() => assertAllowed('https://api.openai.com/v1/x')).toThrow(
      /configured main-model provider is "anthropic".*api\.openai\.com is a different LLM provider/s,
    );
  });

  it('error message includes the URL for diagnostics', () => {
    setEnv({ route: 'direct', provider: 'anthropic' });
    const url = 'https://api.openai.com/v1/chat/completions';
    expect(() => assertAllowed(url)).toThrow(new RegExp(url.replace(/[/.]/g, '\\$&')));
  });
});

describe('KNOWN_LLM_PROVIDER_HOSTS', () => {
  it('includes the major providers', () => {
    expect(KNOWN_LLM_PROVIDER_HOSTS.has('api.anthropic.com')).toBe(true);
    expect(KNOWN_LLM_PROVIDER_HOSTS.has('api.openai.com')).toBe(true);
    expect(KNOWN_LLM_PROVIDER_HOSTS.has('generativelanguage.googleapis.com')).toBe(true);
  });
});
