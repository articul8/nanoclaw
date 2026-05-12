/**
 * Unit tests for the Warp queue HTTP client.
 *
 * Covers:
 *   - construction validates baseUrl
 *   - poll: handles all 3 response-envelope shapes (envelope, single, array)
 *   - poll: 204 No Content => empty array
 *   - poll: HTTP error / network error => empty array (never throws)
 *   - publish: sets headers + body shape correctly
 *   - publish: returns false on HTTP error (caller decides retry)
 *   - publish: respects priority override
 *   - injected fetchImpl is used (no real network)
 */
import { describe, expect, it, vi } from 'vitest';

import { WarpQueueClient, normalizeMessages } from './warp-queue-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WarpQueueClient construction', () => {
  it('requires baseUrl', () => {
    expect(() => new WarpQueueClient({ baseUrl: '' })).toThrow(/baseUrl/);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse([])));
    const c = new WarpQueueClient({ baseUrl: 'http://warp.example.com///', fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.pollMessages('q');
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url.startsWith('http://warp.example.com/queues/q/messages')).toBe(true);
  });

  it('defaults system tenant/user to "system"', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse([])));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.pollMessages('q');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Tenant-ID']).toBe('system');
    expect(headers['X-User-ID']).toBe('system');
  });
});

describe('pollMessages', () => {
  it('returns flat array from { messages: [...] } envelope', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ messages: [{ run_id: 'r1' }, { run_id: 'r2' }] })),
    );
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await c.pollMessages('q');
    expect(out).toEqual([{ run_id: 'r1' }, { run_id: 'r2' }]);
  });

  it('returns single from { message: { payload: { body } } } envelope', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: { payload: { body: { run_id: 'one' } } } })),
    );
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await c.pollMessages('q');
    expect(out).toEqual([{ run_id: 'one' }]);
  });

  it('returns bare array as-is', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse([{ a: 1 }])));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await c.pollMessages('q');
    expect(out).toEqual([{ a: 1 }]);
  });

  it('treats 204 No Content as empty', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await c.pollMessages('q');
    expect(out).toEqual([]);
  });

  it('returns empty array on 5xx (never throws — pollers must stay alive)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 })));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await c.pollMessages('q');
    expect(out).toEqual([]);
  });

  it('returns empty array on network error (never throws)', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await c.pollMessages('q');
    expect(out).toEqual([]);
  });

  it('encodes queue name for URL safety', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse([])));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.pollMessages('queue/with slash');
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('queue%2Fwith%20slash');
  });

  it('passes maxMessages and timeoutSeconds to URL', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse([])));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.pollMessages('q', { maxMessages: 5, timeoutSeconds: 10 });
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('max_messages=5');
    expect(url).toContain('timeout=10');
  });
});

describe('publish', () => {
  it('POSTs body + priority and returns true on 2xx', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 202 })));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const ok = await c.publish('q', { run_id: 'r1' });
    expect(ok).toBe(true);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ body: { run_id: 'r1' }, priority: 5 });
  });

  it('respects priority override', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 202 })));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.publish('q', { x: 1 }, { priority: 9 });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).priority).toBe(9);
  });

  it('returns false on HTTP error (never throws)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const ok = await c.publish('q', {});
    expect(ok).toBe(false);
  });

  it('returns false on network error (never throws)', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const c = new WarpQueueClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const ok = await c.publish('q', {});
    expect(ok).toBe(false);
  });
});

describe('normalizeMessages', () => {
  it('handles null and undefined', () => {
    expect(normalizeMessages(null)).toEqual([]);
    expect(normalizeMessages(undefined)).toEqual([]);
  });

  it('handles an unrecognized shape defensively', () => {
    expect(normalizeMessages({ totally: 'unexpected' })).toEqual([]);
  });
});
