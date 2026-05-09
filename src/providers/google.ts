/**
 * Host-side container config for the google (Gemini) provider.
 *
 * Passes GOOGLE_GENAI_BASE_URL / GOOGLE_API_KEY / DEFAULT_LLM_MODEL
 * through to the per-session container's env so the container-side
 * google provider (container/agent-runner/src/providers/google.ts)
 * can read them.
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

const PASSTHROUGH_KEYS = ['GOOGLE_GENAI_BASE_URL', 'GOOGLE_API_KEY', 'DEFAULT_LLM_MODEL'] as const;

registerProviderContainerConfig('google', (ctx) => {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const v = ctx.hostEnv[key];
    if (v) env[key] = v;
  }
  return { env };
});
