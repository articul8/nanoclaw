/**
 * Main-model API key resolver for direct routing (RUNTIME_CONTRACT v1.1 §7.1).
 *
 * Used at session spawn time when MAIN_MODEL_ROUTE=direct. Tries, in order:
 *
 *   1. user-byok via vault — the user's own API key, if they've supplied one
 *   2. tenant-vault — the tenant-level operator-managed key
 *   3. env fallback — ANTHROPIC_API_KEY in process.env (local dev or
 *      single-tenant K8s Secret bootstrap)
 *   4. fail — MainModelKeyNotFoundError with diagnostic context
 *
 * For v1 the vault lookups are stubs returning null (the credential
 * service / vault integration is a post-v1 follow-up). The interface
 * shape is stable so v2 drops in without changing callers.
 */

export type CredentialSource = 'user-byok' | 'tenant-vault' | 'env';

export interface MainModelCredentials {
  apiKey: string;
  source: CredentialSource;
}

export interface ResolveOptions {
  tenantId: string;
  userId: string;
}

export class MainModelKeyNotFoundError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string
  ) {
    super(
      `[main-model-credentials] no main-model API key resolved for ` +
        `tenant=${tenantId} user=${userId}. Tried (1) user-byok via vault, ` +
        `(2) tenant-vault, (3) ANTHROPIC_API_KEY env. For local dev, set ` +
        `ANTHROPIC_API_KEY in your .env. For cloud, populate the per-tenant ` +
        `a8-claw-secrets.anthropic-api-key Secret or wait for vault integration.`
    );
    this.name = 'MainModelKeyNotFoundError';
  }
}

/**
 * V1 stub for user-level BYOK lookup. Returns null until Warp's credential
 * service exposes the lookup endpoint. The signature is stable so the v2
 * implementation can drop in without changing callers.
 *
 * Future shape: POST {WARP_URL}/credentials/lookup
 *   body: { tenantId, userId, scope: "main-model-key" }
 *   200: { apiKey: string } — found
 *   404: not configured for this user
 */
async function fetchUserApiKey(_tenantId: string, _userId: string): Promise<string | null> {
  return null;
}

/**
 * V1 stub for tenant-level key lookup. Same shape, same future plan.
 *
 * Future shape: POST {WARP_URL}/credentials/lookup
 *   body: { tenantId, scope: "tenant-main-model-key" }
 *   200: { apiKey: string } — operator-managed
 *   404: not configured for this tenant
 */
async function fetchTenantApiKey(_tenantId: string): Promise<string | null> {
  return null;
}

/**
 * Resolve the main-model API key. Throws MainModelKeyNotFoundError if
 * no key is found in any tier.
 */
export async function resolveMainModelKey(opts: ResolveOptions): Promise<MainModelCredentials> {
  const userKey = await fetchUserApiKey(opts.tenantId, opts.userId);
  if (userKey && userKey.length > 0) {
    return { apiKey: userKey, source: 'user-byok' };
  }

  const tenantKey = await fetchTenantApiKey(opts.tenantId);
  if (tenantKey && tenantKey.length > 0) {
    return { apiKey: tenantKey, source: 'tenant-vault' };
  }

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length > 0) {
    return { apiKey: envKey, source: 'env' };
  }

  throw new MainModelKeyNotFoundError(opts.tenantId, opts.userId);
}
