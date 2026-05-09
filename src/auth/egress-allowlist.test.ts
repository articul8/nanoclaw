import { afterEach, describe, expect, it } from 'vitest';

import { ALWAYS_DENIED_HOSTS, assertAllowed, isDenied } from './egress-allowlist.js';

const ORIG_ROUTE = process.env.MAIN_MODEL_ROUTE;
function setRoute(value?: string): void {
  if (value === undefined) delete process.env.MAIN_MODEL_ROUTE;
  else process.env.MAIN_MODEL_ROUTE = value;
}

afterEach(() => {
  setRoute(ORIG_ROUTE);
});

describe('isDenied — non-configured LLM providers (always denied)', () => {
  it('returns true regardless of MAIN_MODEL_ROUTE', () => {
    for (const route of ['direct', 'model_manager', undefined]) {
      setRoute(route);
      expect(isDenied('https://api.openai.com/v1/chat/completions')).toBe(true);
      expect(isDenied('https://api.cohere.ai/generate')).toBe(true);
      expect(isDenied('https://api.mistral.ai/anything')).toBe(true);
      expect(isDenied('https://generativelanguage.googleapis.com/v1/models')).toBe(true);
      expect(isDenied('https://api.together.xyz/v1/x')).toBe(true);
      expect(isDenied('https://api.deepseek.com/v1/x')).toBe(true);
    }
  });
});

describe('isDenied — main-model provider (api.anthropic.com)', () => {
  it('is ALLOWED when MAIN_MODEL_ROUTE=direct', () => {
    setRoute('direct');
    expect(isDenied('https://api.anthropic.com/v1/messages')).toBe(false);
  });

  it('is DENIED when MAIN_MODEL_ROUTE=model_manager', () => {
    setRoute('model_manager');
    expect(isDenied('https://api.anthropic.com/v1/messages')).toBe(true);
  });

  it('is DENIED when MAIN_MODEL_ROUTE is unset (safe default)', () => {
    setRoute(undefined);
    expect(isDenied('https://api.anthropic.com/v1/messages')).toBe(true);
  });

  it('is DENIED when MAIN_MODEL_ROUTE is anything other than "direct"', () => {
    setRoute('anything-else');
    expect(isDenied('https://api.anthropic.com/v1/messages')).toBe(true);
  });
});

describe('isDenied — platform + channel hosts (always allowed)', () => {
  it('returns false for AgentMesh platform hosts in any mode', () => {
    for (const route of ['direct', 'model_manager', undefined]) {
      setRoute(route);
      expect(isDenied('http://aks-warp-service.aks-warp-apps.svc.cluster.local:8085/missions/m/events')).toBe(false);
      expect(isDenied('http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local:8000/run/abc')).toBe(false);
      expect(isDenied('http://aks-tool-manager.aks-tool-manager-apps.svc.cluster.local:8080/tools/x/execute')).toBe(false);
    }
  });

  it('returns false for channel adapter hosts (Slack, Telegram, Discord)', () => {
    setRoute('direct');
    expect(isDenied('https://api.slack.com/webhook')).toBe(false);
    expect(isDenied('https://api.telegram.org/bot/sendMessage')).toBe(false);
    expect(isDenied('https://discord.com/api/v10/channels/123/messages')).toBe(false);
  });

  it('returns false for malformed URLs', () => {
    expect(isDenied('not-a-url')).toBe(false);
    expect(isDenied('')).toBe(false);
  });
});

describe('assertAllowed', () => {
  it('returns silently for allowed URLs', () => {
    setRoute('direct');
    expect(() => assertAllowed('http://aks-warp-service.aks-warp-apps.svc.cluster.local:8085/foo')).not.toThrow();
    expect(() => assertAllowed('https://api.slack.com/webhook')).not.toThrow();
    expect(() => assertAllowed('https://api.anthropic.com/v1/messages')).not.toThrow(); // direct mode
    expect(() => assertAllowed('not-a-url')).not.toThrow(); // malformed: defer to fetch
  });

  it('throws with always-denied reason for non-configured providers', () => {
    setRoute('direct');
    expect(() => assertAllowed('https://api.openai.com/v1/x')).toThrow(
      /api\.openai\.com is a non-configured LLM provider/
    );
  });

  it('throws with route reason when Anthropic is blocked due to non-direct route', () => {
    setRoute('model_manager');
    expect(() => assertAllowed('https://api.anthropic.com/v1/messages')).toThrow(
      /MAIN_MODEL_ROUTE is "model_manager", not "direct"/
    );
  });

  it('throws with unset-route reason when MAIN_MODEL_ROUTE is missing', () => {
    setRoute(undefined);
    expect(() => assertAllowed('https://api.anthropic.com/v1/messages')).toThrow(
      /MAIN_MODEL_ROUTE is "<unset>", not "direct"/
    );
  });

  it('error message includes the URL for diagnostics', () => {
    setRoute('direct');
    const url = 'https://api.openai.com/v1/chat/completions';
    expect(() => assertAllowed(url)).toThrow(new RegExp(url.replace(/[/.]/g, '\\$&')));
  });
});

describe('ALWAYS_DENIED_HOSTS', () => {
  it('exposes the always-blocked LLM provider set for tests / debugging', () => {
    expect(ALWAYS_DENIED_HOSTS.has('api.openai.com')).toBe(true);
    expect(ALWAYS_DENIED_HOSTS.has('api.cohere.ai')).toBe(true);
    // api.anthropic.com is NOT in this set — it's conditional, not always-denied.
    expect(ALWAYS_DENIED_HOSTS.has('api.anthropic.com')).toBe(false);
  });
});
