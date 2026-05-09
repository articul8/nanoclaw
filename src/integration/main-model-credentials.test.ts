import { afterEach, describe, expect, it } from 'vitest';

import { MainModelKeyNotFoundError, resolveMainModelKey } from './main-model-credentials.js';

const ORIG = {
  MAIN_MODEL_API_KEY: process.env.MAIN_MODEL_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

function setKeys(opts: { canonical?: string; legacy?: string }): void {
  if (opts.canonical === undefined) delete process.env.MAIN_MODEL_API_KEY;
  else process.env.MAIN_MODEL_API_KEY = opts.canonical;
  if (opts.legacy === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = opts.legacy;
}

afterEach(() => {
  if (ORIG.MAIN_MODEL_API_KEY === undefined) delete process.env.MAIN_MODEL_API_KEY;
  else process.env.MAIN_MODEL_API_KEY = ORIG.MAIN_MODEL_API_KEY;
  if (ORIG.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG.ANTHROPIC_API_KEY;
});

describe('resolveMainModelKey', () => {
  it('returns the canonical MAIN_MODEL_API_KEY with source="env"', async () => {
    setKeys({ canonical: 'sk-canonical-key' });
    const result = await resolveMainModelKey({ tenantId: 't1', userId: 'u1' });
    expect(result).toEqual({ apiKey: 'sk-canonical-key', source: 'env' });
  });

  it('falls back to legacy ANTHROPIC_API_KEY when canonical is unset', async () => {
    setKeys({ legacy: 'sk-ant-legacy' });
    const result = await resolveMainModelKey({ tenantId: 't', userId: 'u' });
    expect(result).toEqual({ apiKey: 'sk-ant-legacy', source: 'env' });
  });

  it('canonical takes precedence over legacy when both set', async () => {
    setKeys({ canonical: 'sk-canonical', legacy: 'sk-legacy' });
    const result = await resolveMainModelKey({ tenantId: 't', userId: 'u' });
    expect(result.apiKey).toBe('sk-canonical');
  });

  it('throws MainModelKeyNotFoundError when no key is anywhere', async () => {
    setKeys({});
    await expect(resolveMainModelKey({ tenantId: 'tenant-acme', userId: 'user-arun' })).rejects.toBeInstanceOf(
      MainModelKeyNotFoundError,
    );
  });

  it('error message includes tenant + user for diagnostics', async () => {
    setKeys({});
    await expect(resolveMainModelKey({ tenantId: 'tenant-acme', userId: 'user-arun' })).rejects.toThrow(
      /tenant=tenant-acme user=user-arun/,
    );
  });

  it('error message references all three tiers for triage', async () => {
    setKeys({});
    await expect(resolveMainModelKey({ tenantId: 't', userId: 'u' })).rejects.toThrow(
      /user-byok.*tenant-vault.*MAIN_MODEL_API_KEY/s,
    );
  });

  it('treats empty-string canonical as missing (falls through to legacy or error)', async () => {
    setKeys({ canonical: '' });
    await expect(resolveMainModelKey({ tenantId: 't', userId: 'u' })).rejects.toBeInstanceOf(MainModelKeyNotFoundError);
  });

  it('attaches tenantId / userId to the error object for programmatic handling', async () => {
    setKeys({});
    try {
      await resolveMainModelKey({ tenantId: 'tenant-x', userId: 'user-y' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MainModelKeyNotFoundError);
      const err = e as MainModelKeyNotFoundError;
      expect(err.tenantId).toBe('tenant-x');
      expect(err.userId).toBe('user-y');
    }
  });
});
