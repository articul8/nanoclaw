/**
 * Emit-side of the mission-queue adapter — submit-mission to a peer.
 *
 * When an arty session decides to delegate work to another runtime
 * (e.g., a heavy autonomous task → a8-code, a perception scan →
 * atomic-agent), it publishes an `agent_execute` envelope to the peer's
 * queue (`agent_execute_<peer_runtime>`). The peer's pod picks it up
 * the same way arty picks up its own dispatches.
 *
 * This is what `mesh_submit_mission` Platform MCP tool eventually calls
 * to dispatch. Platform MCP's handler invokes this via the in-runtime
 * library; the catalog doesn't directly publish to the queue. Same
 * runtime-infra-vs-agent-tool boundary as snapshot.ts.
 *
 * Per the contract: the envelope shape is locked. Caller provides the
 * task-specific fields (role, goal, context); this module fills in the
 * required platform fields (mission_id, task_id, audit_event_id,
 * cancellation_token, idempotency_key) deterministically.
 */
import { randomUUID } from 'node:crypto';

import type { AgentExecuteEnvelope, AgentType } from './envelope.js';
import type { WarpQueueClient } from './warp-queue-client.js';

function log(msg: string): void {
  console.error(`[mq-submit] ${msg}`);
}

export interface SubmitMissionInput {
  /** Which runtime should pick this up. */
  agent_type: AgentType;
  /** Task spec — propagated to the dispatched agent. */
  role: string;
  goal: string;
  context?: Record<string, unknown>;
  /** Caps. Defaults to conservative values if omitted. */
  budget?: Partial<AgentExecuteEnvelope['budget']>;
  /** Inherited from caller's mission context — REQUIRED security invariant. */
  tenant_id: string;
  user_id: string;
  /**
   * Agent id of the caller (so the peer's audit trail can link parent →
   * child). When the caller is itself a top-level dispatch, this is the
   * dispatching pod's own agent_id.
   */
  parent_agent_id?: string;
  /**
   * Override mission_id for resume semantics — when the caller is
   * RESUMING a peer session by re-spawning, pass the existing mission_id
   * (session_id) so the peer hydrates from snapshot. Mints a new id by
   * default.
   */
  mission_id?: string;
  /**
   * Override task_id for fan-out — when a single mission spawns multiple
   * peer tasks they share mission_id but get distinct task_ids.
   */
  task_id?: string;
}

export interface SubmitMissionResult {
  ok: boolean;
  /** The envelope that was published (or attempted) — caller may want this for audit. */
  envelope: AgentExecuteEnvelope;
}

/**
 * Build + publish an `agent_execute_<peer>` envelope. Returns the
 * envelope so the caller (or audit ledger) can record what was emitted.
 */
export async function submitMission(
  queue: WarpQueueClient,
  input: SubmitMissionInput,
): Promise<SubmitMissionResult> {
  if (!input.tenant_id || !input.user_id) {
    throw new Error('submitMission: tenant_id and user_id are required (security invariant)');
  }

  const envelope: AgentExecuteEnvelope = {
    mission_id: input.mission_id ?? `mis-${randomUUID()}`,
    task_id: input.task_id ?? `task-${randomUUID()}`,
    agent_type: input.agent_type,
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    parent_agent_id: input.parent_agent_id ?? null,
    role: input.role,
    goal: input.goal,
    context: input.context ?? {},
    budget: {
      max_tokens: input.budget?.max_tokens ?? 200_000,
      max_wall_seconds: input.budget?.max_wall_seconds ?? 1800,
      max_concurrent_t3: input.budget?.max_concurrent_t3 ?? 2,
      max_spawn_depth: input.budget?.max_spawn_depth ?? 0,
    },
    cancellation_token: `ct-${randomUUID()}`,
    idempotency_key: `idem-${randomUUID()}`,
    audit_event_id: `evt-${randomUUID()}`,
  };

  const queueName = `agent_execute_${input.agent_type.replace(/-/g, '_')}`;
  const ok = await queue.publish(queueName, envelope, { priority: 5 });
  if (!ok) {
    log(
      `WARN: failed to publish ${envelope.mission_id} to ${queueName} — ` +
        `peer dispatch did not enqueue`,
    );
  } else {
    log(`submitted ${input.agent_type} mission ${envelope.mission_id} (task ${envelope.task_id})`);
  }
  return { ok, envelope };
}
