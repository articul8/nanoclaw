/**
 * Main-model route resolver — produces the SDK-facing configuration
 * (base URL, API key, container env, model name) for a session at spawn
 * time, based on MAIN_MODEL_PROVIDER + MAIN_MODEL_ROUTE env vars
 * (RUNTIME_CONTRACT v1.1 §7.1).
 *
 * Provider-agnostic — the configured main-model provider can be:
 *
 *   - anthropic       (default) — api.anthropic.com or any Anthropic-compatible endpoint
 *   - google          — Google Gemini (generativelanguage.googleapis.com)
 *   - openai-compat   — any OpenAI-API-compatible service: OpenAI itself,
 *                       Together, Fireworks, Groq, vLLM-deployed local models,
 *                       Ollama with OpenAI compat, etc.
 *
 * Two routing modes:
 *
 *   - "direct" (default) — main-model traffic goes direct to the configured
 *     provider's base URL. MAIN_MODEL_API_KEY resolved per-tenant + per-user
 *     BYOK from vault (or env fallback in v1). Latency-tight; runtime
 *     self-reports usage to metering-service.
 *
 *   - "model_manager" — main-model traffic goes through Model Manager
 *     gateway. Endpoint UUID resolved at spawn via MM /resolve. No API
 *     key in env. MM auto-meters. Works regardless of provider — MM
 *     speaks the right protocol for whichever model is registered.
 *
 * Returns containerEnv: the provider-specific env var pair to inject into
 * the per-session container so the SDK there picks them up. Each provider
 * uses its own canonical env names (ANTHROPIC_BASE_URL / GOOGLE_API_KEY /
 * OPENAI_BASE_URL), matching the upstream SDK conventions.
 *
 * NOTE: container-side SDK selection per provider requires the corresponding
 * nanoclaw provider module to be wired (see src/providers/). v1 ships
 * Anthropic end-to-end; Google + OpenAI-compat env+config supported,
 * container-side wiring is a small follow-up.
 *
 * All OTHER model calls (sub-agent inference, embeddings, OCR, judges,
 * perception models) route through Model Manager regardless of mode/provider.
 */

import { platformPostJson } from '../auth/tenant-context.js';

import type { CredentialSource } from './main-model-credentials.js';
import { resolveMainModelKey } from './main-model-credentials.js';

export type MainModelProvider = 'anthropic' | 'google' | 'openai-compat';
export type MainModelMode = 'direct' | 'model_manager';

export interface MainModelConfig {
  provider: MainModelProvider;
  /** Mode that produced this config (direct vs model_manager). */
  mode: MainModelMode;
  /** Resolved base URL (direct: provider's URL; model_manager: MM/run/{uuid}). */
  baseUrl: string;
  /** API key — present only in direct mode. Empty in model_manager mode. */
  apiKey?: string;
  /** Where the key came from (direct mode only) — captured for billing. */
  keySource?: CredentialSource;
  /** Model name. */
  model: string;
  /** Provider-specific env vars to inject into the per-session container. */
  containerEnv: Record<string, string>;
}

export interface ResolveOptions {
  tenantId: string;
  userId: string;
  /** Override DEFAULT_LLM_MODEL env. */
  model?: string;
  /** Override MAIN_MODEL_PROVIDER env. */
  provider?: MainModelProvider;
}

const PROVIDER_DEFAULT_BASE_URL: Record<MainModelProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  'openai-compat': 'https://api.openai.com',
};

/** Read the configured route from env. Default: "direct". */
export function getMainModelMode(): MainModelMode {
  const v = process.env.MAIN_MODEL_ROUTE;
  if (v === 'model_manager') return 'model_manager';
  return 'direct';
}

/** Read the configured provider from env. Default: "anthropic". */
export function getMainModelProvider(): MainModelProvider {
  const v = process.env.MAIN_MODEL_PROVIDER;
  if (v === 'google') return 'google';
  if (v === 'openai-compat') return 'openai-compat';
  return 'anthropic';
}

/** Read the configured base URL from env, defaulting per provider. */
export function getMainModelBaseUrl(provider: MainModelProvider): string {
  return process.env.MAIN_MODEL_BASE_URL || PROVIDER_DEFAULT_BASE_URL[provider];
}

/** Read the model name from override or DEFAULT_LLM_MODEL env. Throws if missing. */
function resolveModelName(override?: string): string {
  const name = override ?? process.env.DEFAULT_LLM_MODEL;
  if (!name) {
    throw new Error(
      `[main-model-route] no model name available. Pass {model: "..."} or set DEFAULT_LLM_MODEL env.`,
    );
  }
  return name;
}

/**
 * Build the container env vars for the SDK based on provider + apiKey + baseUrl.
 * The container's provider-specific SDK reads these env names; the host
 * injects them at spawn time. In model_manager mode, apiKey is undefined
 * and we inject only the base URL (the upstream SDK auth flow there is
 * handled by the OneCLI proxy / provider's auth-token placeholder).
 */
function containerEnvForProvider(
  provider: MainModelProvider,
  baseUrl: string,
  apiKey: string | undefined,
  mode: MainModelMode,
): Record<string, string> {
  const env: Record<string, string> = {};
  switch (provider) {
    case 'anthropic':
      env.ANTHROPIC_BASE_URL = baseUrl;
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
      else if (mode === 'model_manager') env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
      break;
    case 'google':
      // Google Gemini SDK reads GOOGLE_API_KEY; base URL override is less common
      // (the SDK targets the standard generativelanguage endpoint by default).
      // We pass the URL through env so a custom proxy can override it.
      env.GOOGLE_GENAI_BASE_URL = baseUrl;
      if (apiKey) env.GOOGLE_API_KEY = apiKey;
      break;
    case 'openai-compat':
      env.OPENAI_BASE_URL = baseUrl;
      if (apiKey) env.OPENAI_API_KEY = apiKey;
      break;
  }
  return env;
}

/**
 * Resolve the SDK config for the configured route + provider. Call at session
 * spawn; merge containerEnv into the per-session container's env before
 * launching.
 */
export async function resolveMainModelConfig(opts: ResolveOptions): Promise<MainModelConfig> {
  const mode = getMainModelMode();
  const provider = opts.provider ?? getMainModelProvider();
  const model = resolveModelName(opts.model);

  if (mode === 'direct') {
    const baseUrl = getMainModelBaseUrl(provider);
    const creds = await resolveMainModelKey({ tenantId: opts.tenantId, userId: opts.userId });
    return {
      provider,
      mode: 'direct',
      baseUrl,
      apiKey: creds.apiKey,
      keySource: creds.source,
      model,
      containerEnv: containerEnvForProvider(provider, baseUrl, creds.apiKey, 'direct'),
    };
  }

  // model_manager mode — resolve endpoint UUID via Model Manager
  const mmUrl = process.env.MODEL_MANAGER_URL;
  if (!mmUrl) {
    throw new Error(
      `[main-model-route] MODEL_MANAGER_URL env required when MAIN_MODEL_ROUTE=model_manager`,
    );
  }
  const uuid = await resolveModelEndpoint(mmUrl, model);
  const baseUrl = `${mmUrl}/run/${uuid}`;
  return {
    provider,
    mode: 'model_manager',
    baseUrl,
    model,
    containerEnv: containerEnvForProvider(provider, baseUrl, undefined, 'model_manager'),
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
