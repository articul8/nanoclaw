/**
 * Autoskill reflector trigger — end-of-task hook.
 *
 * When a mission completes successfully and was NOT itself a reflection
 * mission AND was not incognito-scoped, fire-and-forget a peer dispatch
 * for an arty-reflector session targeting the just-completed mission.
 * That parallel session reads mission_events for the completed task,
 * promotes patterns to the right tier (episode / semantic_item / skill),
 * and exits. The user's session is already done — reflection runs in
 * the background.
 *
 * Recursion guard: a reflector session's own completion does NOT
 * trigger another reflector. We check context.persona on the source
 * envelope.
 *
 * Privacy: incognito sessions never reach the reflector (their
 * mission_events rows aren't written; the trajectory is local-only).
 * Defense-in-depth check here as well.
 *
 * Direct submitMission call — same emit-side primitive cross-runtime
 * dispatchers use. Not routed through Platform MCP (runtime infra).
 *
 * Future: nightly batch reflection is configured via mesh_schedule_mission
 * separately (scripts/register-nightly-reflector.ts) — not this module.
 */
import type { AgentExecuteEnvelope, MissionCompletion } from './envelope.js';
import { submitMission } from './submit.js';
import type { WarpQueueClient } from './warp-queue-client.js';

function log(msg: string): void {
  console.error(`[reflector-trigger] ${msg}`);
}

export interface TriggerResult {
  triggered: boolean;
  reason?: 'not-success' | 'is-reflector' | 'incognito' | 'submit-failed';
  /** When triggered=true, the reflector mission id (different from the source mission). */
  reflector_mission_id?: string;
}

/**
 * Decide whether to trigger a reflector for `completion`, and if so do it.
 *
 * Call from the consumer right after a successful runner returns,
 * BEFORE publishing the completion (so the reflector dispatch is part
 * of the same logical end-of-task flow). Fire-and-forget — the consumer
 * never awaits the reflector's completion, just emits the agent_execute
 * for it and continues.
 *
 * Returns a structured result for logging / metering. Never throws.
 */
export async function maybeTriggerReflector(
  queue: WarpQueueClient,
  source: AgentExecuteEnvelope,
  completion: MissionCompletion,
  podAgentId: string,
): Promise<TriggerResult> {
  if (completion.status !== 'success') {
    return { triggered: false, reason: 'not-success' };
  }

  // Recursion guard — reflector reflecting on a reflector loops forever.
  const sourceContext = source.context as Record<string, unknown>;
  if (sourceContext.persona === 'arty-reflector') {
    return { triggered: false, reason: 'is-reflector' };
  }

  // Privacy guard. incognito sessions don't get reflected on (their
  // trajectory isn't in mission_events anyway, but defense-in-depth).
  if (sourceContext.privacy === 'incognito') {
    return { triggered: false, reason: 'incognito' };
  }

  try {
    const r = await submitMission(queue, {
      agent_type: 'a8-claw',
      role: 'arty-reflector',
      goal:
        `Reflect on the just-completed mission ${source.mission_id} (task ` +
        `${source.task_id}). Identify recurring patterns, score novelty + confidence, ` +
        `promote at the right tier (episode / semantic_item / skill).`,
      context: {
        persona: 'arty-reflector',
        target_mission_id: source.mission_id,
        target_task_id: source.task_id,
        // Source role helps the reflector understand what kind of work was being
        // done (data-analyst, engineer, etc.) without needing to look it up.
        source_role: source.role,
        trigger: 'end-of-task',
      },
      tenant_id: source.tenant_id,
      user_id: source.user_id,
      parent_agent_id: podAgentId,
      // Conservative budget — reflection is read-heavy, write-light. Max one
      // skill proposal per run; semantic items are quick.
      budget: { max_tokens: 50_000, max_wall_seconds: 600, max_concurrent_t3: 1, max_spawn_depth: 0 },
    });
    if (!r.ok) {
      log(`reflector submitMission returned ok=false for source ${source.mission_id}`);
      return { triggered: false, reason: 'submit-failed' };
    }
    log(`triggered reflector ${r.envelope.mission_id} for source ${source.mission_id}`);
    return { triggered: true, reflector_mission_id: r.envelope.mission_id };
  } catch (err) {
    // submitMission can throw on missing tenant/user (security invariant).
    // The source envelope MUST have those, so this only fires on a bug; log
    // loudly but don't propagate.
    log(`reflector trigger threw: ${(err as Error).message ?? err}`);
    return { triggered: false, reason: 'submit-failed' };
  }
}
