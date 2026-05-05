/**
 * Egress allowlist — defense-in-depth for the "no direct LLM-provider calls"
 * invariant from RUNTIME_CONTRACT_20260505.md §7.
 *
 * The primary enforcement is at the K8s NetworkPolicy layer (vanilla K8s
 * can't FQDN-block, but the absence of any ANTHROPIC_API_KEY in container
 * env means the Anthropic SDK has nothing to authenticate with even if a
 * call leaks through). This module is a runtime-side belt: any HTTP wrapper
 * that uses these helpers will refuse to fire a request to a known-blocked
 * host, with a descriptive error pointing the caller at Model Manager.
 *
 * Wired into platformFetch so any platform call that's mistakenly aimed at
 * api.anthropic.com / api.openai.com / etc. fails fast with a readable
 * message rather than producing a confusing 401 / network error.
 */

/**
 * Hosts that runtimes MUST NOT call directly. All inference routes through
 * Model Manager. Bypassing it would skip metering, audit, model versioning,
 * and tenant scoping.
 */
export const DENIED_HOSTS: ReadonlySet<string> = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'generativelanguage.googleapis.com', // Gemini
  'api.together.xyz',
  'api.deepseek.com',
]);

/**
 * Returns true if the URL's host is on the denied list. Malformed URLs
 * return false (they'll fail with a clearer error from fetch itself).
 */
export function isDenied(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return DENIED_HOSTS.has(host);
}

/**
 * Throws a descriptive error if the URL's host is denied. Use as a guard
 * inside HTTP wrappers (e.g. platformFetch) to catch bypass attempts.
 */
export function assertAllowed(url: string): void {
  if (!isDenied(url)) return;
  const host = new URL(url).hostname;
  throw new Error(
    `[egress-allowlist] direct call to ${host} is blocked. ` +
      `All inference must route through Model Manager (RUNTIME_CONTRACT §7). ` +
      `If your code is reaching ${host}, you likely meant to use the SDK ` +
      `with ANTHROPIC_BASE_URL = MODEL_MANAGER_URL instead of constructing the URL by hand. ` +
      `URL: ${url}`
  );
}
