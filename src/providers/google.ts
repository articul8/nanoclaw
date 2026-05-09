/**
 * Host-side container config for the google (Gemini) provider (AgentMesh fork).
 *
 * Passes the Google-SDK-specific env (GOOGLE_GENAI_BASE_URL /
 * GOOGLE_API_KEY / DEFAULT_LLM_MODEL) AND the AgentMesh platform context
 * (TENANT_ID, USER_ID, CONNECTION_STATE, WARP_URL, MODEL_MANAGER_URL, etc.)
 * into the per-session container.
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

const PROVIDER_KEYS = ['GOOGLE_GENAI_BASE_URL', 'GOOGLE_API_KEY', 'DEFAULT_LLM_MODEL'] as const;
const PLATFORM_KEYS = [
  'TENANT_ID',
  'USER_ID',
  'CONNECTION_STATE',
  'WARP_URL',
  'MODEL_MANAGER_URL',
  'TOOL_MANAGER_URL',
  'METERING_USAGE_URL',
] as const;

registerProviderContainerConfig('google', (ctx) => {
  const env: Record<string, string> = {};
  // Provider-specific with canonical fallback for one-set-of-names UX.
  const apiKey = ctx.hostEnv.GOOGLE_API_KEY || ctx.hostEnv.MAIN_MODEL_API_KEY;
  if (apiKey) env.GOOGLE_API_KEY = apiKey;
  const baseUrl = ctx.hostEnv.GOOGLE_GENAI_BASE_URL || ctx.hostEnv.MAIN_MODEL_BASE_URL;
  if (baseUrl) env.GOOGLE_GENAI_BASE_URL = baseUrl;
  for (const key of PROVIDER_KEYS) {
    if (env[key] === undefined && ctx.hostEnv[key]) env[key] = ctx.hostEnv[key]!;
  }
  for (const key of PLATFORM_KEYS) {
    const v = ctx.hostEnv[key];
    if (v) env[key] = v;
  }
  return { env };
});
