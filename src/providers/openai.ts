/**
 * Host-side container config for the openai-compat provider.
 *
 * Passes OPENAI_BASE_URL / OPENAI_API_KEY / DEFAULT_LLM_MODEL through
 * to the per-session container's env so the container-side openai
 * provider (container/agent-runner/src/providers/openai.ts) can read
 * them. In production these env vars are already present on the host's
 * process.env (set by the warm-pool allocator or by the local-mode
 * .env loader); we just forward them.
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

const PASSTHROUGH_KEYS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'DEFAULT_LLM_MODEL'] as const;

registerProviderContainerConfig('openai-compat', (ctx) => {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const v = ctx.hostEnv[key];
    if (v) env[key] = v;
  }
  return { env };
});
