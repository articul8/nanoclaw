/**
 * Audit ledger — durable record of every state-changing decision.
 *
 * Implements the runtime-contract §4 spec (RUNTIME_CONTRACT_20260505.md):
 *
 *   POST {WARP_URL}/missions/{mission_id}/events
 *   { event_id, tenant_id, user_id, mission_id, task_id, agent_id,
 *     parent_agent_id, agent_type, event_kind, payload, timestamp }
 *
 * Two modes:
 *
 *   1. mission mode  — MISSION_ID env is set (dispatched from mission engine).
 *                      POSTs to Warp's ledger endpoint.
 *
 *   2. standalone    — no MISSION_ID (operator running ./a8-claw chat locally).
 *                      Appends to /workspace/audit.jsonl for local provenance.
 *                      A future tenant-level audit endpoint can ingest these.
 *
 * In **incognito** (CONNECTION_STATE=incognito) we write neither — the
 * incognito contract is "nothing leaves the runtime."
 *
 * Emission discipline per §4.4:
 *   - Every state-changing decision writes one event. Reads don't (except
 *     auditable blackboard_read on high-stakes missions, not in v1).
 *   - Writes are fire-and-forget — never block the agent's hot path.
 *   - Failures are logged but never thrown.
 *
 * NOTE: event_kind is a closed enum per the contract — runtimes cannot
 * invent new kinds without a cross-runtime PR + ADR. For transparency
 * narrations that don't map to an enum value, we attach `rationale` and
 * `narration_category` to the payload of the closest existing event_kind
 * (typically `tool_call`, `bus_message_out`, `spawn`, or `dispatch`).
 */
import fs from 'fs';
import path from 'path';

import type { NarrationCategory } from './live-render.js';

function log(msg: string): void {
  console.error(`[audit] ${msg}`);
}

/** Closed enum per runtime-contract §4.2. */
export type EventKind =
  | 'mission_submit'
  | 'mission_complete'
  | 'mission_cancel'
  | 'dispatch'
  | 'spawn'
  | 'spawn_rejected'
  | 'bus_message_in'
  | 'bus_message_out'
  | 'broadcast'
  | 'blackboard_read'
  | 'blackboard_write'
  | 'blackboard_conflict'
  | 'budget_reserve'
  | 'budget_commit'
  | 'budget_release'
  | 'tool_call'
  | 'model_call'
  | 'heartbeat'
  | 'exit'
  | 'checkpoint'
  | 'replay';

export interface AuditEventInput {
  event_kind: EventKind;
  payload: Record<string, unknown>;
  /**
   * Optional natural-language rationale — the same text the user sees as
   * narration. Attached to payload so the audit trail captures the WHY
   * not just the WHAT.
   */
  rationale?: string;
  /**
   * Optional category — mirrors NarrationCategory so audit consumers can
   * filter to "all approval events" / "all delegations" without a
   * payload-text grep.
   */
  narration_category?: NarrationCategory;
  /** Optional task identifier (mission-mode only). */
  task_id?: string | null;
}

interface AuditContext {
  tenant_id: string;
  user_id: string;
  mission_id: string | null;
  agent_id: string;
  parent_agent_id: string | null;
  agent_type: string;
  warp_url: string | null;
  incognito: boolean;
  fallback_path: string;
}

let _ctx: AuditContext | null = null;

function getContext(): AuditContext {
  if (_ctx) return _ctx;
  const incognito = (process.env.CONNECTION_STATE || '').toLowerCase() === 'incognito';
  _ctx = {
    tenant_id: process.env.TENANT_ID || '',
    user_id: process.env.USER_ID || '',
    mission_id: process.env.MISSION_ID || null,
    agent_id: process.env.AGENT_ID || process.env.AGENT_GROUP_ID || '',
    parent_agent_id: process.env.PARENT_AGENT_ID || null,
    agent_type: process.env.AGENT_TYPE || 'a8-claw',
    warp_url: process.env.WARP_URL || null,
    incognito,
    // /workspace is the session dir mounted RW by the host (see container-runner.ts).
    fallback_path: '/workspace/audit.jsonl',
  };
  return _ctx;
}

/** For tests — reset cached env-derived context. */
export function _resetAuditContextForTests(): void {
  _ctx = null;
}

function generateEventId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `evt-${Date.now().toString(36)}-${rnd}`;
}

/**
 * Write one audit event. Fire-and-forget — never throws, never blocks.
 *
 * Returns a promise the caller MAY await for testing / commit-on-exit
 * paths, but production call sites should ignore it: the contract's
 * "never block the hot path" rule applies.
 */
export async function writeMissionEvent(input: AuditEventInput): Promise<void> {
  const ctx = getContext();
  if (ctx.incognito) return; // §4.4 + incognito contract: nothing leaves
  if (!ctx.tenant_id || !ctx.user_id) {
    // Without identity, we can't write a valid row — drop silently. (The
    // host always sets these for real sessions; only dev / misconfig
    // hits this path, and we don't want stderr noise on every call.)
    return;
  }

  const row = {
    event_id: generateEventId(),
    tenant_id: ctx.tenant_id,
    user_id: ctx.user_id,
    mission_id: ctx.mission_id,
    task_id: input.task_id ?? null,
    agent_id: ctx.agent_id,
    parent_agent_id: ctx.parent_agent_id,
    agent_type: ctx.agent_type,
    event_kind: input.event_kind,
    payload: {
      ...input.payload,
      ...(input.rationale ? { rationale: input.rationale } : {}),
      ...(input.narration_category ? { narration_category: input.narration_category } : {}),
    },
    timestamp: new Date().toISOString(),
  };

  if (ctx.mission_id && ctx.warp_url) {
    // Mission mode — POST to the platform ledger.
    void postToWarp(ctx, row).catch((err) => {
      // Audit write failure is logged once but never thrown — the
      // contract says writes are fire-and-forget with retry. v1 has no
      // retry buffer (TODO §4.4 buffering); failures hit the fallback
      // path so the row isn't lost.
      log(`Warp ledger write failed: ${(err as Error).message ?? err} — falling back to local jsonl`);
      void appendToFallback(ctx.fallback_path, row);
    });
  } else {
    // Standalone mode — local JSONL. The host can drain this to the
    // platform when connectivity comes back.
    void appendToFallback(ctx.fallback_path, row);
  }
}

async function postToWarp(ctx: AuditContext, row: Record<string, unknown>): Promise<void> {
  const url = `${ctx.warp_url}/missions/${encodeURIComponent(ctx.mission_id!)}/events`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-ID': ctx.tenant_id,
      'X-User-ID': ctx.user_id,
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '<no body>')}`);
  }
}

async function appendToFallback(filePath: string, row: Record<string, unknown>): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, JSON.stringify(row) + '\n');
  } catch (err) {
    // Last-resort failure — log once, never throw. If both the platform
    // ledger AND the local fallback are unwritable, the row is lost,
    // but the agent's hot path stays unaffected.
    log(`Fallback jsonl write failed (${filePath}): ${(err as Error).message ?? err}`);
  }
}
