/**
 * Session-boot recall — pairs with the snapshot/restore loop.
 *
 * Pulls context-aware recommendations from IntelligenceService once at
 * pod boot. The agent does NOT semantic-search at session start (per
 * arty-autoskill-architecture); the runtime calls
 * `intelligence_recommend(context_type='session', context_id=<id>)` and
 * injects the pre-ranked items into the system prompt. This is what
 * makes the next session warm without the agent burning context-window
 * tokens on search round-trips.
 *
 * Runtime infra — direct Warp HTTP, not Platform MCP. The agent never
 * decides whether to recall; it just sees enriched context at the start
 * of its conversation.
 *
 * Privacy:
 *   - SESSION_PRIVACY=incognito → skip entirely (incognito sessions
 *     don't read or write platform memory)
 *   - WARP_URL unset or TENANT/USER missing → standalone mode, skip
 *
 * Fail-open: any HTTP failure / parse error returns null. The session
 * continues without recall enrichment. Quality-of-life, not a hard
 * dependency.
 */
import path from 'node:path';

function log(msg: string): void {
  console.error(`[recall] ${msg}`);
}

export interface RecallContext {
  session_id: string;
  privacy: 'normal' | 'incognito';
  tenant_id: string;
  user_id: string;
  warp_url: string | null;
}

let _ctx: RecallContext | null = null;

function getContext(): RecallContext {
  if (_ctx) return _ctx;
  const rawPrivacy = (process.env.SESSION_PRIVACY ?? 'normal').toLowerCase();
  _ctx = {
    session_id: process.env.SESSION_ID ?? '',
    privacy: rawPrivacy === 'incognito' ? 'incognito' : 'normal',
    tenant_id: process.env.TENANT_ID ?? '',
    user_id: process.env.USER_ID ?? '',
    warp_url: process.env.WARP_URL || null,
  };
  return _ctx;
}

export function _resetRecallContextForTests(): void {
  _ctx = null;
}

export interface RecallResult {
  /** Format-ready prompt snippet to inject into the system prompt. Null when no recall happened. */
  prompt_snippet: string | null;
  /** Raw items from IntelligenceService — kept for audit / debugging. Empty when no items. */
  items: unknown[];
  /** Reason for null result, when applicable. */
  skipped_reason?: 'no-warp' | 'incognito' | 'no-session-id' | 'empty' | 'error';
  /** Detail when skipped_reason='error'. */
  detail?: string;
}

/**
 * Fetch recall items for this session. Returns the formatted snippet
 * (or null) plus the raw items. Never throws — fail-open by design.
 *
 * Call once at agent-runner startup, before the poll loop, after
 * restore.ts has finished. The snippet goes into `systemContext.instructions`.
 */
export async function fetchSessionRecall(limit = 5): Promise<RecallResult> {
  const ctx = getContext();

  if (ctx.privacy === 'incognito') {
    return { prompt_snippet: null, items: [], skipped_reason: 'incognito' };
  }
  if (!ctx.session_id) {
    return { prompt_snippet: null, items: [], skipped_reason: 'no-session-id' };
  }
  if (!ctx.warp_url || !ctx.tenant_id || !ctx.user_id) {
    return { prompt_snippet: null, items: [], skipped_reason: 'no-warp' };
  }

  const params = new URLSearchParams({
    context_type: 'session',
    context_id: ctx.session_id,
    limit: String(limit),
  });
  const url = `${ctx.warp_url}/intelligence/recommend?${params.toString()}`;
  try {
    const res = await fetch(url, {
      headers: {
        'X-Tenant-ID': ctx.tenant_id,
        'X-User-ID': ctx.user_id,
        ...(process.env.MISSION_TOKEN ? { 'X-Mission-Token': process.env.MISSION_TOKEN } : {}),
      },
    });
    if (!res.ok) {
      return {
        prompt_snippet: null,
        items: [],
        skipped_reason: 'error',
        detail: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { items?: unknown[] } | unknown[];
    const items = Array.isArray(body) ? body : (body.items ?? []);
    if (items.length === 0) {
      return { prompt_snippet: null, items: [], skipped_reason: 'empty' };
    }
    log(`recalled ${items.length} item(s) for session ${ctx.session_id}`);
    return { prompt_snippet: formatPromptSnippet(items), items };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { prompt_snippet: null, items: [], skipped_reason: 'error', detail: msg };
  }
}

/**
 * Render the items into a short, model-friendly preamble. IntelligenceService
 * returns ranked items spanning L1+L2+L3 (structural / semantic / activity);
 * we keep it as a JSON block prefixed by a one-line explanation so the LLM
 * knows what it's looking at without us having to second-guess the
 * item shape (which varies per context_type).
 */
export function formatPromptSnippet(items: unknown[]): string {
  // Cap the JSON we emit at a sensible size — the recall endpoint is
  // already limit-capped (default 5), but defensively trim the rendered
  // form so a future limit bump can't blow the system prompt budget.
  const trimmed = items.slice(0, 10);
  const json = JSON.stringify(trimmed, null, 2);
  return [
    '## Session recall',
    '',
    'Below is pre-ranked context from prior sessions, semantic memory, and',
    'activity signals — surfaced by the platform IntelligenceService. Use it',
    'to ground answers when relevant; ignore items that don\'t apply.',
    '',
    '```json',
    json,
    '```',
  ].join('\n');
}

/** Helper: combine an existing instructions string with the recall snippet. */
export function withRecall(baseInstructions: string | undefined, snippet: string | null): string {
  if (!snippet) return baseInstructions ?? '';
  if (!baseInstructions) return snippet;
  return baseInstructions + '\n\n---\n\n' + snippet;
}

// Internal — for path construction in tests if we ever cache to disk.
export const _internal = { path };
