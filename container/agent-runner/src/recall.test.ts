/**
 * Recall tests — fail-open behavior + privacy gating.
 *
 * Covers each documented skip path and the happy-path fetch shape.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { _resetRecallContextForTests, fetchSessionRecall, formatPromptSnippet, withRecall } from './recall.js';

const ORIG = {
  SESSION_ID: process.env.SESSION_ID,
  SESSION_PRIVACY: process.env.SESSION_PRIVACY,
  TENANT_ID: process.env.TENANT_ID,
  USER_ID: process.env.USER_ID,
  WARP_URL: process.env.WARP_URL,
  MISSION_TOKEN: process.env.MISSION_TOKEN,
};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  _resetRecallContextForTests();
});

afterEach(() => {
  setEnv(ORIG);
  _resetRecallContextForTests();
});

describe('fetchSessionRecall', () => {
  it('skips when SESSION_PRIVACY=incognito', async () => {
    setEnv({
      SESSION_ID: 'sess-priv',
      SESSION_PRIVACY: 'incognito',
      TENANT_ID: 't',
      USER_ID: 'u',
      WARP_URL: 'http://warp.test',
    });
    const fetchMock = mock(() => Promise.resolve(new Response('ok')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetchSessionRecall();
    expect(r.skipped_reason).toBe('incognito');
    expect(r.prompt_snippet).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when SESSION_ID empty', async () => {
    setEnv({ SESSION_ID: '', SESSION_PRIVACY: 'normal', TENANT_ID: 't', USER_ID: 'u', WARP_URL: 'http://w' });
    const r = await fetchSessionRecall();
    expect(r.skipped_reason).toBe('no-session-id');
  });

  it('skips when WARP_URL unset (standalone mode)', async () => {
    setEnv({ SESSION_ID: 's', SESSION_PRIVACY: 'normal', TENANT_ID: 't', USER_ID: 'u', WARP_URL: undefined });
    const r = await fetchSessionRecall();
    expect(r.skipped_reason).toBe('no-warp');
  });

  it('returns empty when IntelligenceService returns no items', async () => {
    setEnv({
      SESSION_ID: 'sess-fresh',
      SESSION_PRIVACY: 'normal',
      TENANT_ID: 't',
      USER_ID: 'u',
      WARP_URL: 'http://warp.test',
    });
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ items: [] }))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetchSessionRecall();
    expect(r.skipped_reason).toBe('empty');
    expect(r.prompt_snippet).toBeNull();
  });

  it('formats items into a prompt snippet on happy path', async () => {
    setEnv({
      SESSION_ID: 'sess-hot',
      SESSION_PRIVACY: 'normal',
      TENANT_ID: 't',
      USER_ID: 'u',
      WARP_URL: 'http://warp.test',
    });
    const items = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.7 }];
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ items }))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetchSessionRecall();
    expect(r.items).toEqual(items);
    expect(r.prompt_snippet).toContain('Session recall');
    expect(r.prompt_snippet).toContain('"id": "a"');
  });

  it('returns error reason on HTTP failure (fail-open)', async () => {
    setEnv({
      SESSION_ID: 'sess-x',
      SESSION_PRIVACY: 'normal',
      TENANT_ID: 't',
      USER_ID: 'u',
      WARP_URL: 'http://warp.test',
    });
    const fetchMock = mock(() => Promise.resolve(new Response('boom', { status: 500 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetchSessionRecall();
    expect(r.skipped_reason).toBe('error');
    expect(r.prompt_snippet).toBeNull();
  });

  it('handles bare-array response shape (Warp drift tolerance)', async () => {
    setEnv({
      SESSION_ID: 'sess-x',
      SESSION_PRIVACY: 'normal',
      TENANT_ID: 't',
      USER_ID: 'u',
      WARP_URL: 'http://warp.test',
    });
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify([{ id: 'a' }]))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetchSessionRecall();
    expect(r.items).toEqual([{ id: 'a' }]);
  });

  it('includes X-Mission-Token header when set', async () => {
    setEnv({
      SESSION_ID: 'sess-x',
      SESSION_PRIVACY: 'normal',
      TENANT_ID: 't',
      USER_ID: 'u',
      WARP_URL: 'http://warp.test',
      MISSION_TOKEN: 'mt-test',
    });
    let captured: Record<string, string> = {};
    const fetchMock = mock((_url: string, init: RequestInit) => {
      captured = init.headers as Record<string, string>;
      return Promise.resolve(new Response(JSON.stringify({ items: [] })));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await fetchSessionRecall();
    expect(captured['X-Mission-Token']).toBe('mt-test');
  });
});

describe('formatPromptSnippet + withRecall', () => {
  it('renders header + JSON block', () => {
    const out = formatPromptSnippet([{ k: 1 }]);
    expect(out).toContain('## Session recall');
    expect(out).toContain('```json');
    expect(out).toContain('"k": 1');
  });

  it('caps render at 10 items defensively', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ i }));
    const out = formatPromptSnippet(items);
    expect(out).toContain('"i": 0');
    expect(out).toContain('"i": 9');
    expect(out).not.toContain('"i": 10');
  });

  it('withRecall appends a separator before the snippet', () => {
    const out = withRecall('Base instructions.', '## Session recall\nfoo');
    expect(out).toContain('Base instructions.');
    expect(out).toContain('---');
    expect(out).toContain('## Session recall');
  });

  it('withRecall returns base alone when snippet is null', () => {
    expect(withRecall('Base.', null)).toBe('Base.');
  });

  it('withRecall returns empty when both are missing', () => {
    expect(withRecall(undefined, null)).toBe('');
  });
});
