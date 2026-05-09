/**
 * Main-model usage self-report to metering-service (RUNTIME_CONTRACT v1.1 §7.1).
 *
 * In direct routing mode the runtime calls Anthropic directly, so Model
 * Manager doesn't see those tokens. Instead the runtime POSTs a usage
 * record to metering-service after each main-model call — same row shape
 * MM would have emitted, with `source: "direct"` to let metering-service
 * aggregate uniformly across both bifurcated paths.
 *
 * Fire-and-forget by design — never blocks the chat hot path. Errors are
 * logged but don't propagate. metering-service running degraded must not
 * break user conversations.
 */

import { platformPostJson } from '../auth/tenant-context.js';

import type { CredentialSource } from './main-model-credentials.js';

export interface MainModelUsage {
  tenantId: string;
  userId: string;
  /** Optional — set when the call is part of an orchestrated mission. */
  missionId?: string;
  sessionId: string;
  modelName: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** Where the API key came from — useful for billing reconciliation. */
  keySource: CredentialSource;
}

export interface MeteringRecord {
  tenant_id: string;
  user_id: string;
  mission_id?: string;
  session_id: string;
  model_name: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  ts: string; // ISO-8601
  source: 'direct';
  key_source: CredentialSource;
}

/**
 * Build the metering record from the usage event. Snake-case keys match
 * the row shape Model Manager emits, so metering-service aggregates
 * across both paths uniformly.
 */
export function buildMeteringRecord(usage: MainModelUsage, now: Date = new Date()): MeteringRecord {
  return {
    tenant_id: usage.tenantId,
    user_id: usage.userId,
    mission_id: usage.missionId,
    session_id: usage.sessionId,
    model_name: usage.modelName,
    tokens_in: usage.tokensIn,
    tokens_out: usage.tokensOut,
    latency_ms: usage.latencyMs,
    ts: now.toISOString(),
    source: 'direct',
    key_source: usage.keySource,
  };
}

/**
 * Fire-and-forget POST of a usage record to metering-service. Reads
 * METERING_USAGE_URL from env; if unset, logs a warning and skips
 * (acceptable for local dev — production deployments should always
 * have it set). Errors during the POST are caught and logged.
 */
export function reportMainModelUsage(usage: MainModelUsage): void {
  const url = process.env.METERING_USAGE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.warn('[main-model-meter] METERING_USAGE_URL not set; skipping self-report');
    return;
  }
  const record = buildMeteringRecord(usage);
  // Fire-and-forget. The chat hot path doesn't await this.
  void platformPostJson(url, record).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn('[main-model-meter] failed to report usage:', msg);
  });
}
