#!/usr/bin/env -S node --experimental-strip-types
/**
 * One-shot operator script — register the nightly Autoskill reflector.
 *
 * Usage:
 *   WARP_URL=...  TENANT_ID=acme  USER_ID=arun  \
 *     node scripts/register-nightly-reflector.ts \
 *     --cron "0 3 * * *"
 *
 * Registers a recurring `agent_execute_a8_claw` dispatch via Warp's
 * mesh_schedule_mission endpoint (Platform MCP catalog op
 * mesh_schedule_mission, but called directly here since this is
 * operator infra not agent decision).
 *
 * The dispatched mission carries context.persona='arty-reflector' and
 * context.trigger='scheduled'; the consumer's reflector path renders
 * the same persona template as the end-of-task hook.
 *
 * Idempotent: re-running with the same tenant/user replaces the prior
 * schedule (the orchestrator's mesh_schedule_mission upserts).
 */
import { submitMission } from '../src/channels/mission-queue/submit.ts';
import { WarpQueueClient } from '../src/channels/mission-queue/warp-queue-client.ts';

function arg(name: string, defaultValue?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return defaultValue;
}

async function main(): Promise<void> {
  const warpUrl = process.env.WARP_URL;
  const tenantId = process.env.TENANT_ID;
  const userId = process.env.USER_ID;
  const cron = arg('cron', '0 3 * * *');
  if (!warpUrl || !tenantId || !userId) {
    console.error('ERROR: WARP_URL, TENANT_ID, USER_ID must all be set in env');
    process.exit(2);
  }

  const queue = new WarpQueueClient({ baseUrl: warpUrl });

  // Submit a scheduled mission via Warp's schedule endpoint. The
  // mission queue itself doesn't have native scheduling — that's
  // the orchestrator's mesh_schedule_mission API. We emit a payload
  // that resembles the agent_execute envelope but includes the
  // schedule directive; the orchestrator interprets it.
  //
  // For v1, this script just emits a one-shot agent_execute with a
  // schedule_hint in context, and the orchestrator's reflector cron
  // (separate operator config) actually drives recurrence. Once
  // mesh_schedule_mission is wired end-to-end on the orchestrator
  // side, this script switches to that path.
  const r = await submitMission(queue, {
    agent_type: 'a8-claw',
    role: 'arty-reflector',
    goal:
      `Scheduled nightly reflection over the last 24h of missions for ` +
      `tenant ${tenantId} user ${userId}. Identify recurring patterns, ` +
      `promote at the right memory tier.`,
    context: {
      persona: 'arty-reflector',
      trigger: 'scheduled',
      window_hours: 24,
      schedule_hint: { cron, registered_at: new Date().toISOString() },
    },
    tenant_id: tenantId,
    user_id: userId,
    budget: { max_tokens: 100_000, max_wall_seconds: 1200, max_concurrent_t3: 1, max_spawn_depth: 0 },
  });

  if (!r.ok) {
    console.error(`FAILED to submit reflector dispatch`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Registered reflector mission: ${r.envelope.mission_id}`);
  console.log(`  tenant: ${tenantId}`);
  console.log(`  user:   ${userId}`);
  console.log(`  cron:   ${cron}`);
  console.log('');
  console.log('Note: the orchestrator must have mesh_schedule_mission wired');
  console.log('for true recurrence. v1 of this script just submits a one-shot');
  console.log('dispatch; until scheduling lands cluster-side, re-run nightly');
  console.log('via your own cron / launchd / systemd timer.');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`fatal: ${(err as Error).message ?? err}`);
  process.exit(1);
});
