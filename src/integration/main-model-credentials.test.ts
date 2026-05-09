import { afterEach, describe, expect, it } from 'vitest';

import { MainModelKeyNotFoundError, resolveMainModelKey } from './main-model-credentials.js';

const ORIG_KEY = process.env.ANTHROPIC_API_KEY;
function setEnvKey(value?: string): void {
  if (value === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = value;
}

afterEach(() => {
  setEnvKey(ORIG_KEY);
});

describe('resolveMainModelKey', () => {
  it('returns the env key with source="env" when ANTHROPIC_API_KEY is set', async () => {
    setEnvKey('sk-ant-local-dev-key');
    const result = await resolveMainModelKey({ tenantId: 't1', userId: 'u1' });
    expect(result).toEqual({ apiKey: 'sk-ant-local-dev-key', source: 'env' });
  });

  it('throws MainModelKeyNotFoundError when no key is anywhere', async () => {
    setEnvKey(undefined);
    await expect(resolveMainModelKey({ tenantId: 'tenant-acme', userId: 'user-arun' })).rejects.toBeInstanceOf(
      MainModelKeyNotFoundError,
    );
  });

  it('error message includes tenant + user for diagnostics', async () => {
    setEnvKey(undefined);
    await expect(resolveMainModelKey({ tenantId: 'tenant-acme', userId: 'user-arun' })).rejects.toThrow(
      /tenant=tenant-acme user=user-arun/,
    );
  });

  it('error message references all three tiers for triage', async () => {
    setEnvKey(undefined);
    await expect(resolveMainModelKey({ tenantId: 't', userId: 'u' })).rejects.toThrow(
      /user-byok.*tenant-vault.*ANTHROPIC_API_KEY/s,
    );
  });

  it('treats empty-string env key as missing (falls through to error)', async () => {
    setEnvKey('');
    await expect(resolveMainModelKey({ tenantId: 't', userId: 'u' })).rejects.toBeInstanceOf(MainModelKeyNotFoundError);
  });

  it('attaches tenantId / userId to the error object for programmatic handling', async () => {
    setEnvKey(undefined);
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
