/**
 * Host-side container config for the openai-compat provider (AgentMesh fork).
 *
 * Passes the OpenAI-SDK-specific env (OPENAI_BASE_URL / OPENAI_API_KEY /
 * DEFAULT_LLM_MODEL) AND the AgentMesh platform context (TENANT_ID,
 * USER_ID, CONNECTION_STATE, WARP_URL, MODEL_MANAGER_URL, etc.) into
 * the per-session container so the in-container provider + platform
 * calls work end-to-end.
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

const PROVIDER_KEYS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'DEFAULT_LLM_MODEL'] as const;
const PLATFORM_KEYS = [
  'TENANT_ID',
  'USER_ID',
  'CONNECTION_STATE',
  'WARP_URL',
  'MODEL_MANAGER_URL',
  'TOOL_MANAGER_URL',
  'METERING_USAGE_URL',
] as const;

registerProviderContainerConfig('openai-compat', (ctx) => {
  const env: Record<string, string> = {};
  // Provider-specific: also accept canonical MAIN_MODEL_* as fallback so
  // operators can use one set of env names regardless of provider.
  const apiKey = ctx.hostEnv.OPENAI_API_KEY || ctx.hostEnv.MAIN_MODEL_API_KEY;
  if (apiKey) env.OPENAI_API_KEY = apiKey;
  const baseUrl = ctx.hostEnv.OPENAI_BASE_URL || ctx.hostEnv.MAIN_MODEL_BASE_URL;
  if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
  for (const key of PROVIDER_KEYS) {
    if (env[key] === undefined && ctx.hostEnv[key]) env[key] = ctx.hostEnv[key]!;
  }
  for (const key of PLATFORM_KEYS) {
    const v = ctx.hostEnv[key];
    if (v) env[key] = v;
  }
  return { env };
});
