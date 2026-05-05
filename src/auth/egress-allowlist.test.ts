import { describe, expect, it } from 'vitest';

import { assertAllowed, DENIED_HOSTS, isDenied } from './egress-allowlist.js';

describe('isDenied', () => {
  it('returns true for known model-provider hosts', () => {
    expect(isDenied('https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isDenied('https://api.openai.com/v1/chat/completions')).toBe(true);
    expect(isDenied('https://api.cohere.ai/generate')).toBe(true);
    expect(isDenied('https://api.mistral.ai/anything')).toBe(true);
  });

  it('returns false for AgentMesh platform hosts', () => {
    expect(isDenied('http://aks-warp-service.aks-warp-apps.svc.cluster.local:8085/missions/mis-1/events')).toBe(false);
    expect(isDenied('http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local:8000/run/abc')).toBe(false);
    expect(isDenied('http://aks-tool-manager.aks-tool-manager-apps.svc.cluster.local:8080/tools/nge_search/execute')).toBe(false);
  });

  it('returns false for channel adapter hosts', () => {
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
    expect(() => assertAllowed('http://aks-warp-service.aks-warp-apps.svc.cluster.local:8085/foo')).not.toThrow();
    expect(() => assertAllowed('https://api.slack.com/webhook')).not.toThrow();
    expect(() => assertAllowed('not-a-url')).not.toThrow(); // malformed: defer to fetch
  });

  it('throws a descriptive error for denied URLs', () => {
    expect(() => assertAllowed('https://api.anthropic.com/v1/messages')).toThrow(
      /direct call to api\.anthropic\.com is blocked/
    );
    expect(() => assertAllowed('https://api.anthropic.com/v1/messages')).toThrow(
      /must route through Model Manager/
    );
  });

  it('error message includes the URL for diagnostics', () => {
    const url = 'https://api.openai.com/v1/chat/completions';
    expect(() => assertAllowed(url)).toThrow(new RegExp(url.replace(/[/.]/g, '\\$&')));
  });
});

describe('DENIED_HOSTS', () => {
  it('exposes the set for tests / debugging', () => {
    expect(DENIED_HOSTS.has('api.anthropic.com')).toBe(true);
    expect(DENIED_HOSTS.has('api.openai.com')).toBe(true);
  });
});
