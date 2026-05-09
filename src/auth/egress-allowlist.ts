/**
 * Egress allowlist — defense-in-depth for the bifurcated, provider-agnostic
 * model-routing invariant from RUNTIME_CONTRACT_20260505.md §7 / §7.1 (v1.1).
 *
 * Rules:
 *   - Hosts NOT on the known-LLM-provider list are unconstrained here
 *     (NetworkPolicy is the actual enforcement; that's an unknown/custom
 *     host such as a self-hosted vLLM endpoint or a Together/Fireworks
 *     URL — handled by infrastructure).
 *
 *   - Hosts on the known-LLM-provider list are DENIED unless ALL of:
 *       1. MAIN_MODEL_ROUTE=direct
 *       2. The host matches the runtime's configured main-model provider
 *          (derived from MAIN_MODEL_BASE_URL hostname, or the provider
 *          default for MAIN_MODEL_PROVIDER).
 *
 * Concretely: if the runtime is configured for Anthropic in direct mode,
 * api.anthropic.com is reachable but api.openai.com / api.cohere.ai /
 * api.gemini / etc. are not. Switch the configured provider to Google
 * and api.anthropic.com flips to denied; generativelanguage.googleapis.com
 * flips to allowed. Etc.
 *
 * The K8s NetworkPolicy is the primary network-layer enforcement. This
 * module is a runtime-side belt: HTTP wrappers fail fast on bypass
 * attempts with a descriptive error.
 */

import type { MainModelProvider } from '../integration/main-model-route.js';

/**
 * Known LLM-provider hostnames. The configured provider's host (one of
 * these, or a custom URL not in this set) is allowed in direct mode;
 * the rest are blocked. Add new providers here as discovered.
 */
export const KNOWN_LLM_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'generativelanguage.googleapis.com', // Google Gemini
  'api.together.xyz',
  'api.fireworks.ai',
  'api.groq.com',
  'api.deepseek.com',
]);

/** Default host per provider, used when MAIN_MODEL_BASE_URL is unset. */
const PROVIDER_DEFAULT_HOST: Record<MainModelProvider, string> = {
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  'openai-compat': 'api.openai.com',
};

function isDirectMainModelRoute(): boolean {
  return process.env.MAIN_MODEL_ROUTE === 'direct';
}

function getConfiguredProvider(): MainModelProvider {
  const v = process.env.MAIN_MODEL_PROVIDER;
  if (v === 'google') return 'google';
  if (v === 'openai-compat') return 'openai-compat';
  return 'anthropic';
}

/**
 * The hostname we'd hit in direct mode for the configured provider.
 * Prefers MAIN_MODEL_BASE_URL when set (allows custom self-hosted /
 * proxy URLs); falls back to the per-provider default. Returns null
 * if MAIN_MODEL_BASE_URL is set but malformed.
 */
function getConfiguredProviderHost(): string | null {
  const customUrl = process.env.MAIN_MODEL_BASE_URL;
  if (customUrl) {
    try {
      return new URL(customUrl).hostname;
    } catch {
      return null;
    }
  }
  return PROVIDER_DEFAULT_HOST[getConfiguredProvider()];
}

/**
 * Returns true if the URL's host is denied under the current configuration.
 * Malformed URLs return false (defer to fetch for the better error).
 */
export function isDenied(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!KNOWN_LLM_PROVIDER_HOSTS.has(host)) return false;
  // Known LLM provider host. Allow only if direct mode AND it's the configured one.
  if (!isDirectMainModelRoute()) return true;
  return host !== getConfiguredProviderHost();
}

/** Throws a descriptive error if the URL's host is denied. */
export function assertAllowed(url: string): void {
  if (!isDenied(url)) return;
  const host = new URL(url).hostname;
  let reason: string;
  if (!isDirectMainModelRoute()) {
    reason = `MAIN_MODEL_ROUTE is "${process.env.MAIN_MODEL_ROUTE ?? '<unset>'}", not "direct"; either set MAIN_MODEL_ROUTE=direct or use Model Manager`;
  } else {
    const configured = getConfiguredProviderHost();
    reason = `the configured main-model provider is "${getConfiguredProvider()}" (host: ${configured}); ${host} is a different LLM provider and non-configured providers are always blocked`;
  }
  throw new Error(`[egress-allowlist] direct call to ${host} is blocked: ${reason}. URL: ${url}`);
}
