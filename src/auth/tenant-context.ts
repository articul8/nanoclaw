/**
 * Tenant context wrapper for platform HTTP calls.
 *
 * Every outbound call to AgentMesh platform services (Warp, Tool Manager,
 * Model Manager, metering-service) MUST carry X-Tenant-ID and X-User-ID
 * headers — see RUNTIME_CONTRACT_20260505.md §6 and the platform-wide
 * "tenant_id AND user_id ARE ALWAYS REQUIRED, NEVER OPTIONAL" invariant.
 *
 * Tenant + user are read from process.env (TENANT_ID, USER_ID), set
 * per-pod by the warm-pool allocator at K8s scheduling time. Mission
 * token (X-Mission-Token, optional) comes from MISSION_TOKEN env or the
 * `missionToken` per-call override.
 *
 * Channel-adapter calls (Slack, Telegram, Discord, etc.) do NOT go
 * through this wrapper — those use per-channel auth (OAuth tokens etc).
 */

import { assertAllowed } from './egress-allowlist.js';

export interface PlatformFetchOptions extends RequestInit {
  /** Per-call override for X-Mission-Token. Falls back to MISSION_TOKEN env. */
  missionToken?: string;
}

export interface TenantContext {
  tenantId: string;
  userId: string;
  missionToken: string;
}

/**
 * True when the runtime is in incognito mode (CONNECTION_STATE=incognito).
 * In incognito mode, platform calls are NOT made at all — callers should
 * check this and skip the call rather than relying on platformFetch to
 * throw. The throw is defense-in-depth.
 */
export function isIncognito(): boolean {
  return process.env.CONNECTION_STATE === 'incognito';
}

/**
 * Read tenant context from process.env. Throws if TENANT_ID or USER_ID
 * are missing/empty — a pod that boots without them is misconfigured at
 * the K8s level and cannot serve sessions safely.
 */
export function readTenantContext(): TenantContext {
  const tenantId = process.env.TENANT_ID ?? '';
  const userId = process.env.USER_ID ?? '';
  const missionToken = process.env.MISSION_TOKEN ?? '';

  if (!tenantId || !userId) {
    throw new Error(
      `[tenant-context] TENANT_ID and USER_ID must both be set in env. ` +
        `Got TENANT_ID="${tenantId}", USER_ID="${userId}". ` +
        `These are populated per-pod by the warm-pool allocator at scheduling time. ` +
        `Tenant-only scoping is a security breach — both are required.`,
    );
  }

  return { tenantId, userId, missionToken };
}

/**
 * Outbound HTTP wrapper for AgentMesh platform service calls (Warp,
 * Tool Manager, Model Manager, metering-service). Auto-injects
 * X-Tenant-ID, X-User-ID, and X-Mission-Token (when set) headers.
 *
 * Use this for ALL calls to platform services. Do not call the raw
 * `fetch` for those endpoints. Channel adapters use their own auth.
 */
export async function platformFetch(url: string, options: PlatformFetchOptions = {}): Promise<Response> {
  if (isIncognito()) {
    throw new Error(
      `[tenant-context] platformFetch refused: runtime is in INCOGNITO mode (CONNECTION_STATE=incognito). ` +
        `No platform calls allowed. Callers should check isIncognito() and skip the call. URL: ${url}`,
    );
  }
  assertAllowed(url);
  const { tenantId, userId, missionToken: envToken } = readTenantContext();
  const { missionToken: callToken, headers: callerHeaders, ...rest } = options;

  const headers: Record<string, string> = {
    'X-Tenant-ID': tenantId,
    'X-User-ID': userId,
    ...((callerHeaders ?? {}) as Record<string, string>),
  };

  const token = callToken ?? envToken;
  if (token) {
    headers['X-Mission-Token'] = token;
  }

  return fetch(url, { ...rest, headers });
}

/**
 * Convenience: POST a JSON body. Sets Content-Type: application/json
 * and serializes the body. Other headers/options pass through.
 */
export async function platformPostJson(
  url: string,
  body: unknown,
  options: PlatformFetchOptions = {},
): Promise<Response> {
  return platformFetch(url, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...((options.headers ?? {}) as Record<string, string>) },
    body: JSON.stringify(body),
  });
}
