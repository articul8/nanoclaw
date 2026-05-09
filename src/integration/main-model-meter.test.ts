import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMeteringRecord, reportMainModelUsage } from './main-model-meter.js';

const ORIG = {
  TENANT_ID: process.env.TENANT_ID,
  USER_ID: process.env.USER_ID,
  METERING_USAGE_URL: process.env.METERING_USAGE_URL,
};

afterEach(() => {
  if (ORIG.TENANT_ID === undefined) delete process.env.TENANT_ID;
  else process.env.TENANT_ID = ORIG.TENANT_ID;
  if (ORIG.USER_ID === undefined) delete process.env.USER_ID;
  else process.env.USER_ID = ORIG.USER_ID;
  if (ORIG.METERING_USAGE_URL === undefined) delete process.env.METERING_USAGE_URL;
  else process.env.METERING_USAGE_URL = ORIG.METERING_USAGE_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildMeteringRecord', () => {
  it('produces the canonical snake-case shape with source="direct"', () => {
    const fixedDate = new Date('2026-05-08T12:34:56.789Z');
    const record = buildMeteringRecord(
      {
        tenantId: 'tenant-acme',
        userId: 'user-arun',
        sessionId: 'sess-1',
        modelName: 'claude-sonnet-4-6',
        tokensIn: 100,
        tokensOut: 200,
        latencyMs: 1234,
        keySource: 'env',
      },
      fixedDate,
    );
    expect(record).toEqual({
      tenant_id: 'tenant-acme',
      user_id: 'user-arun',
      mission_id: undefined,
      session_id: 'sess-1',
      model_name: 'claude-sonnet-4-6',
      tokens_in: 100,
      tokens_out: 200,
      latency_ms: 1234,
      ts: '2026-05-08T12:34:56.789Z',
      source: 'direct',
      key_source: 'env',
    });
  });

  it('passes through mission_id when set', () => {
    const r = buildMeteringRecord({
      tenantId: 't',
      userId: 'u',
      missionId: 'mis-7',
      sessionId: 's',
      modelName: 'm',
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      keySource: 'tenant-vault',
    });
    expect(r.mission_id).toBe('mis-7');
  });

  it('preserves key_source values', () => {
    expect(
      buildMeteringRecord({
        tenantId: 't',
        userId: 'u',
        sessionId: 's',
        modelName: 'm',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        keySource: 'user-byok',
      }).key_source,
    ).toBe('user-byok');
  });
});

describe('reportMainModelUsage', () => {
  beforeEach(() => {
    process.env.TENANT_ID = 'tenant-test';
    process.env.USER_ID = 'user-test';
  });

  it('POSTs to METERING_USAGE_URL when set', async () => {
    process.env.METERING_USAGE_URL = 'http://aks-metering-service.aks-metering-apps.svc.cluster.local:8000/v1/usage';
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);

    reportMainModelUsage({
      tenantId: 'tenant-test',
      userId: 'user-test',
      sessionId: 'sess-1',
      modelName: 'claude-sonnet-4-6',
      tokensIn: 50,
      tokensOut: 100,
      latencyMs: 800,
      keySource: 'env',
    });

    // Allow microtask queue to flush the fire-and-forget
    await new Promise((r) => setImmediate(r));

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://aks-metering-service.aks-metering-apps.svc.cluster.local:8000/v1/usage');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      tenant_id: 'tenant-test',
      user_id: 'user-test',
      session_id: 'sess-1',
      model_name: 'claude-sonnet-4-6',
      tokens_in: 50,
      tokens_out: 100,
      latency_ms: 800,
      source: 'direct',
      key_source: 'env',
    });
    expect(typeof body.ts).toBe('string');
  });

  it('logs a warning and skips when METERING_USAGE_URL is unset', () => {
    delete process.env.METERING_USAGE_URL;
    const mock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reportMainModelUsage({
      tenantId: 't',
      userId: 'u',
      sessionId: 's',
      modelName: 'm',
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      keySource: 'env',
    });

    expect(mock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('METERING_USAGE_URL not set'));
  });

  it('swallows POST errors (fire-and-forget never throws into the hot path)', async () => {
    process.env.METERING_USAGE_URL = 'http://aks-metering-service.svc/v1/usage';
    const mock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', mock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Function returns synchronously and does NOT throw
    expect(() =>
      reportMainModelUsage({
        tenantId: 't',
        userId: 'u',
        sessionId: 's',
        modelName: 'm',
        tokensIn: 1,
        tokensOut: 1,
        latencyMs: 1,
        keySource: 'env',
      }),
    ).not.toThrow();

    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to report usage'),
      expect.stringContaining('connection refused'),
    );
  });

  it('returns synchronously even on success (does not block caller)', () => {
    process.env.METERING_USAGE_URL = 'http://aks-metering-service.svc/v1/usage';
    let resolveFetch: (v: Response) => void = () => {};
    const slowFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', slowFetch);

    const start = Date.now();
    reportMainModelUsage({
      tenantId: 't',
      userId: 'u',
      sessionId: 's',
      modelName: 'm',
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      keySource: 'env',
    });
    const elapsed = Date.now() - start;
    // Should be effectively instant — never awaiting the in-flight promise.
    expect(elapsed).toBeLessThan(50);
    // Cleanup the dangling promise so the test runner doesn't hang
    resolveFetch(new Response('ok'));
  });
});
