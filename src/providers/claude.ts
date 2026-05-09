/**
 * Claude provider container config — AgentMesh fork variant.
 *
 * Upstream nanoclaw's claude.ts was conditional (only registered when
 * the user configured a custom Anthropic-compatible endpoint via setup,
 * for the OneCLI proxy-rewrite pattern). For AgentMesh we always register
 * and pass through the full set of env vars the per-session container
 * needs to drive an Anthropic chat:
 *
 *   - ANTHROPIC_API_KEY          — direct mode, from MAIN_MODEL_API_KEY
 *                                  (canonical) or ANTHROPIC_API_KEY (legacy)
 *   - ANTHROPIC_BASE_URL         — when configured for proxy / Anthropic-
 *                                  compatible endpoint or model_manager mode
 *   - ANTHROPIC_AUTH_TOKEN       — placeholder when an explicit BASE_URL is
 *                                  set without a key (the OneCLI proxy
 *                                  rewrites Authorization on the wire)
 *   - TENANT_ID, USER_ID         — tenant scoping for in-container calls
 *   - WARP_URL, MODEL_MANAGER_URL, TOOL_MANAGER_URL — platform service URLs
 *   - DEFAULT_LLM_MODEL          — model name the SDK should use
 *   - CONNECTION_STATE           — incognito / offline / connected for
 *                                  runtime-side gating of platform calls
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', (ctx) => {
  const env: Record<string, string> = {};

  // Anthropic SDK auth: prefer canonical name, fall back to the upstream-
  // standard ANTHROPIC_API_KEY.
  const apiKey = ctx.hostEnv.MAIN_MODEL_API_KEY || ctx.hostEnv.ANTHROPIC_API_KEY;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

  // Custom base URL (proxy or Model Manager gateway). When set without a
  // direct API key, the OneCLI proxy pattern uses ANTHROPIC_AUTH_TOKEN=placeholder
  // and rewrites Authorization on the wire.
  const baseUrl = ctx.hostEnv.MAIN_MODEL_BASE_URL || ctx.hostEnv.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
    if (!apiKey) env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  // Tenant + user — required by every platform call (X-Tenant-ID / X-User-ID).
  if (ctx.hostEnv.TENANT_ID) env.TENANT_ID = ctx.hostEnv.TENANT_ID;
  if (ctx.hostEnv.USER_ID) env.USER_ID = ctx.hostEnv.USER_ID;

  // Connection state — runtime-side gates check this for incognito mode.
  if (ctx.hostEnv.CONNECTION_STATE) env.CONNECTION_STATE = ctx.hostEnv.CONNECTION_STATE;

  // AgentMesh platform service URLs (in-container HTTP calls go to these).
  if (ctx.hostEnv.WARP_URL) env.WARP_URL = ctx.hostEnv.WARP_URL;
  if (ctx.hostEnv.MODEL_MANAGER_URL) env.MODEL_MANAGER_URL = ctx.hostEnv.MODEL_MANAGER_URL;
  if (ctx.hostEnv.TOOL_MANAGER_URL) env.TOOL_MANAGER_URL = ctx.hostEnv.TOOL_MANAGER_URL;
  if (ctx.hostEnv.METERING_USAGE_URL) env.METERING_USAGE_URL = ctx.hostEnv.METERING_USAGE_URL;

  // Default model name (SDK reads this for some defaults; harmless if unset).
  if (ctx.hostEnv.DEFAULT_LLM_MODEL) env.DEFAULT_LLM_MODEL = ctx.hostEnv.DEFAULT_LLM_MODEL;

  return { env };
});
