/**
 * a8-claw — Cloud / Pod-Mode Entrypoint
 *
 * Mirrors a8-code/src/main.ts in shape: the pod IS one session.
 * This file is the entry the Dockerfile runs (CMD ["node", "dist/cloud-main.js"]).
 *
 * Lifecycle:
 *   1. Boot health server on :8040 immediately (K8s readiness probe).
 *   2. Build WarpQueueClient with the pod's system-level queue creds.
 *   3. Build subprocess-backed MissionRunner that spawns the bun
 *      agent-runner for each accepted mission.
 *   4. MissionConsumer polls `agent_execute_a8_claw`, runs ONE mission,
 *      publishes the completion, then exits. SandboxWarmPool spins up a
 *      replacement pod.
 *
 * Why one-mission-per-pod (not a long-lived multi-mission loop):
 *   - Per CLAUDE.md storage table: per-session scratch is emptyDir,
 *     ephemeral, dies with the container. Reusing the pod across
 *     missions would leak session-state across tenants.
 *   - Matches a8-code's pattern (one mission_execution_id per pod
 *     lifetime; resume re-spawns a fresh pod).
 *
 * Why this is a separate entry from src/index.ts:
 *   - Host-mode (src/index.ts) inits SQLite DBs, starts channel adapters,
 *     runs router + delivery + sweep — it's the upstream nanoclaw daemon
 *     orchestrating MULTIPLE per-session containers.
 *   - Pod-mode (this file) has no DB to init (state is per-mission
 *     via env + restored snapshot), no host orchestrator (the pod IS
 *     the runner), no channel adapters at boot (channels bind per-mission
 *     via the envelope's context).
 *
 * Egress: ALL outbound goes through WARP_URL / MODEL_MANAGER_URL /
 * TOOL_MANAGER_URL. The NetworkPolicy enforces it; runtime-side
 * egress-allowlist is defense-in-depth.
 */

import http from "http";
import { hostname } from "node:os";

import { log } from "./log.js";
import { MissionConsumer } from "./channels/mission-queue/consumer.js";
import { createSubprocessRunner } from "./channels/mission-queue/runner.js";
import { WarpQueueClient } from "./channels/mission-queue/warp-queue-client.js";

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT ?? "8040", 10);
const WARP_URL = process.env.WARP_URL ?? "";

interface PodState {
  ready: boolean;
  status: "booting" | "polling" | "in_mission" | "completed" | "draining" | "failed";
  startedAt: number;
  agentId: string;
  currentMissionId: string | null;
  completion: { mission_id: string; status: string } | null;
  lastError: string | null;
}

// Pod identity — used as agent_id on completion envelopes. K8s sets
// HOSTNAME to the pod name (e.g. `a8-claw-warm-pool-xyz`); fall back to
// os.hostname() if unset. Stable for the pod's lifetime.
const POD_AGENT_ID = process.env.HOSTNAME || hostname() || `a8-claw-pod-${Date.now()}`;

const state: PodState = {
  ready: false,
  status: "booting",
  startedAt: Date.now(),
  agentId: POD_AGENT_ID,
  currentMissionId: null,
  completion: null,
  lastError: null,
};

let consumer: MissionConsumer | null = null;

// ── Health endpoint ───────────────────────────────────────────────────
// 200 once the consumer is started and ready to accept missions.
// Structured JSON so warm-pool tooling can inspect pod state without exec.

function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const ok = state.ready && state.status !== "failed";
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          service: "a8-claw",
          status: state.status,
          ready: state.ready,
          uptime_seconds: Math.floor((Date.now() - state.startedAt) / 1000),
          agent_id: state.agentId,
          current_mission: state.currentMissionId,
          completion: state.completion,
          last_error: state.lastError,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(HEALTH_PORT, () => {
    log.info(`a8-claw health endpoint listening on :${HEALTH_PORT}`);
  });
  return server;
}

// ── Graceful shutdown ─────────────────────────────────────────────────

process.on("SIGTERM", () => {
  log.info("SIGTERM received — draining");
  state.status = "draining";
  state.ready = false;
  consumer?.stop();
});

process.on("SIGINT", () => {
  log.info("SIGINT received — draining");
  state.status = "draining";
  state.ready = false;
  consumer?.stop();
});

// ── Boot ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const healthServer = startHealthServer();

  if (!WARP_URL) {
    state.status = "failed";
    state.lastError = "WARP_URL not set — pod cannot poll the mission queue";
    log.error(state.lastError);
    // Keep server up so /health surfaces the diagnostic; warm-pool will
    // replace this pod via liveness probe failures.
    return;
  }

  const queue = new WarpQueueClient({
    baseUrl: WARP_URL,
    // System creds on the queue infra calls themselves — the envelope
    // body carries the real mission tenant/user. See contract §6.
    systemTenantId: process.env.WARP_SYSTEM_TENANT ?? "system",
    systemUserId: process.env.WARP_SYSTEM_USER ?? "system",
  });

  const runner = createSubprocessRunner({ agentId: state.agentId });

  consumer = new MissionConsumer({
    queue,
    runner: async (envelope) => {
      state.currentMissionId = envelope.mission_id;
      state.status = "in_mission";
      try {
        return await runner(envelope);
      } finally {
        state.currentMissionId = null;
      }
    },
    agentId: state.agentId,
  });

  state.ready = true;
  state.status = "polling";
  log.info(`a8-claw pod ${state.agentId} ready — polling for missions`);

  // Process exactly one mission then exit. SandboxWarmPool brings up a
  // fresh pod for the next mission.
  try {
    const completion = await consumer.consumeOneAndExit();
    if (completion) {
      state.completion = { mission_id: completion.mission_id, status: completion.status };
      state.status = "completed";
      log.info(`mission ${completion.mission_id} completed with status ${completion.status}`);
    } else {
      log.info("consumer stopped before any mission arrived");
    }
  } catch (err: unknown) {
    state.status = "failed";
    state.lastError = `consumer fatal: ${(err as Error).message ?? err}`;
    log.error(state.lastError);
  }

  // Give the health server a moment to report final state, then exit so
  // the warm-pool reconciler can replace us. Background daemon-style
  // pods (atomic-agent) loop here; arty's one-mission-per-pod model
  // exits cleanly. The K8s PreStop hook + SIGTERM handler give callers
  // time to scrape /health one last time.
  setTimeout(() => {
    healthServer.close();
    process.exit(state.status === "failed" ? 1 : 0);
  }, 2000);
}

main().catch((err) => {
  state.status = "failed";
  state.lastError = `fatal: ${(err as Error).message ?? err}`;
  state.ready = false;
  log.error(state.lastError);
  process.exit(1);
});
