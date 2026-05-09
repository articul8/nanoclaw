/**
 * Egress allowlist — defense-in-depth for the bifurcated model-routing
 * invariant from RUNTIME_CONTRACT_20260505.md §7 / §7.1 (v1.1).
 *
 * Two axes of denial:
 *   1. Non-configured LLM providers (api.openai.com, api.cohere.ai, …)
 *      — always denied.
 *   2. The configured main-model provider (currently api.anthropic.com)
 *      — denied UNLESS MAIN_MODEL_ROUTE=direct. In direct mode the
 *      runtime sends main-model traffic direct to the provider and
 *      self-reports metering to metering-service. In model_manager mode
 *      (or unset), the runtime is expected to route through Model Manager
 *      via ANTHROPIC_BASE_URL = ${MODEL_MANAGER_URL}/run/{uuid}.
 *
 * The K8s NetworkPolicy is the primary network-layer enforcement. This
 * module is a runtime-side belt: HTTP wrappers refuse to fire requests
 * to denied hosts with a descriptive error, before the call ever leaves.
 */

/**
 * Non-configured LLM provider domains. Always blocked, regardless of
 * MAIN_MODEL_ROUTE. Add new providers here as discovered.
 */
export const ALWAYS_DENIED_HOSTS: ReadonlySet<string> = new Set([
  'api.openai.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'generativelanguage.googleapis.com', // Gemini
  'api.together.xyz',
  'api.deepseek.com',
]);

/** Hostname of the configured main-model provider. */
const MAIN_PROVIDER_HOST = 'api.anthropic.com';

/** True when the runtime is configured for direct main-model routing. */
function isDirectMainModelRoute(): boolean {
  return process.env.MAIN_MODEL_ROUTE === 'direct';
}

/**
 * Returns true if the URL's host is on the deny list under current config:
 *   - ALWAYS_DENIED_HOSTS: true regardless of route.
 *   - Main-model provider: true UNLESS MAIN_MODEL_ROUTE=direct.
 *   - Anything else: false.
 * Malformed URLs return false (defer to fetch for a better error).
 */
export function isDenied(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (ALWAYS_DENIED_HOSTS.has(host)) return true;
  if (host === MAIN_PROVIDER_HOST && !isDirectMainModelRoute()) return true;
  return false;
}

/**
 * Throws a descriptive error if the URL's host is denied. Use as a guard
 * inside HTTP wrappers (e.g. platformFetch) to catch bypass attempts.
 */
export function assertAllowed(url: string): void {
  if (!isDenied(url)) return;
  const host = new URL(url).hostname;
  const reason = ALWAYS_DENIED_HOSTS.has(host)
    ? `${host} is a non-configured LLM provider; only the runtime's configured main-model provider is permitted (and only when MAIN_MODEL_ROUTE=direct)`
    : `MAIN_MODEL_ROUTE is "${process.env.MAIN_MODEL_ROUTE ?? '<unset>'}", not "direct"; either set MAIN_MODEL_ROUTE=direct (and provide ANTHROPIC_API_KEY) or use Model Manager via ANTHROPIC_BASE_URL`;
  throw new Error(`[egress-allowlist] direct call to ${host} is blocked: ${reason}. URL: ${url}`);
}
