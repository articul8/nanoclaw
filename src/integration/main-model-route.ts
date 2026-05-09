/**
 * Main-model route resolver — produces the SDK-facing configuration
 * (ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, model) for a session at spawn
 * time, based on the MAIN_MODEL_ROUTE env (RUNTIME_CONTRACT v1.1 §7.1).
 *
 * Two modes:
 *
 *   - "direct" (default for a8-claw, a8-code) — main-model traffic goes
 *     direct to the configured provider. ANTHROPIC_BASE_URL =
 *     https://api.anthropic.com; ANTHROPIC_API_KEY resolved per-tenant
 *     + per-user BYOK from vault (or env fallback in v1). Latency-tight;
 *     runtime self-reports usage to metering-service after each call.
 *
 *   - "model_manager" — main-model traffic goes through Model Manager
 *     gateway. ANTHROPIC_BASE_URL = ${MODEL_MANAGER_URL}/run/${uuid}
 *     where the endpoint UUID is resolved at spawn time via Model
 *     Manager's /resolve endpoint. No API key in env (MM has its own).
 *     Centralized control; +1 in-cluster hop on every call.
 *
 * All OTHER model calls (sub-agent inference, embeddings, OCR, judges,
 * perception models) route through Model Manager regardless of mode.
 */

import { platformPostJson } from '../auth/tenant-context.js';

import type { CredentialSource } from './main-model-credentials.js';
import { resolveMainModelKey } from './main-model-credentials.js';

export type MainModelMode = 'direct' | 'model_manager';

export interface MainModelConfig {
  /** Set as ANTHROPIC_BASE_URL on the SDK. */
  baseUrl: string;
  /** Set as ANTHROPIC_API_KEY on the SDK. Only present when mode="direct". */
  apiKey?: string;
  /** Which mode produced this config — useful for metering / logging. */
  mode: MainModelMode;
  /** Where the API key came from in direct mode (omitted in model_manager). */
  keySource?: CredentialSource;
  /** The model name passed in (for metering and SDK info). */
  model: string;
}

export interface ResolveOptions {
  tenantId: string;
  userId: string;
  /** Override the default model name (else pulled from DEFAULT_LLM_MODEL env). */
  model?: string;
}

const ANTHROPIC_DIRECT_BASE_URL = 'https://api.anthropic.com';

/** Read the configured route from env. Default: "direct". */
export function getMainModelMode(): MainModelMode {
  const v = process.env.MAIN_MODEL_ROUTE;
  if (v === 'model_manager') return 'model_manager';
  // Default + any unrecognized value → direct (matches the contract default)
  return 'direct';
}

/** Read the model name from override or DEFAULT_LLM_MODEL env. Throws if missing. */
function resolveModelName(override?: string): string {
  const name = override ?? process.env.DEFAULT_LLM_MODEL;
  if (!name) {
    throw new Error(`[main-model-route] no model name available. Pass {model: "..."} or set DEFAULT_LLM_MODEL env.`);
  }
  return name;
}

/**
 * Resolve the SDK config for the configured route. Call at session spawn;
 * apply the returned config as env to the container before launching.
 */
export async function resolveMainModelConfig(opts: ResolveOptions): Promise<MainModelConfig> {
  const mode = getMainModelMode();
  const model = resolveModelName(opts.model);

  if (mode === 'direct') {
    const creds = await resolveMainModelKey({ tenantId: opts.tenantId, userId: opts.userId });
    return {
      baseUrl: ANTHROPIC_DIRECT_BASE_URL,
      apiKey: creds.apiKey,
      mode: 'direct',
      keySource: creds.source,
      model,
    };
  }

  // model_manager mode — resolve endpoint UUID via Model Manager
  const mmUrl = process.env.MODEL_MANAGER_URL;
  if (!mmUrl) {
    throw new Error(`[main-model-route] MODEL_MANAGER_URL env required when MAIN_MODEL_ROUTE=model_manager`);
  }
  const uuid = await resolveModelEndpoint(mmUrl, model);
  return {
    baseUrl: `${mmUrl}/run/${uuid}`,
    mode: 'model_manager',
    model,
  };
}

/**
 * Call Model Manager's /resolve endpoint to map a model NAME to its
 * environment-specific endpoint UUID. Per the platform pattern: model
 * name in env, UUID at runtime — UUIDs differ per env.
 */
async function resolveModelEndpoint(mmUrl: string, modelName: string): Promise<string> {
  const url = `${mmUrl}/resolve`;
  const resp = await platformPostJson(url, { identifier: modelName });
  if (!resp.ok) {
    throw new Error(
      `[main-model-route] Model Manager /resolve failed for "${modelName}": ${resp.status} ${resp.statusText}`,
    );
  }
  const data = (await resp.json()) as { endpoint_id?: string };
  if (!data.endpoint_id) {
    throw new Error(
      `[main-model-route] Model Manager /resolve for "${modelName}" returned no endpoint_id: ${JSON.stringify(data)}`,
    );
  }
  return data.endpoint_id;
}
