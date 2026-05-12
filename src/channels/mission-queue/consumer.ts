/**
 * Mission-queue consumer — the cloud pod's main loop.
 *
 * One-mission-per-pod model: the pod polls `agent_execute_a8_claw`,
 * processes one mission via the injected runner, publishes the
 * completion, and exits. The K8s SandboxWarmPool reconciler spins up a
 * replacement pod for the next mission. This matches a8-code's pattern
 * AND the storage architecture in CLAUDE.md: per-session container
 * scratch is emptyDir, ephemeral, dies with the container.
 *
 * Polling cadence:
 *   - poll one message at a time (maxMessages=1) — concurrency lives at
 *     the warm-pool level, not inside a pod
 *   - 1s long-poll timeout — matches a8-code
 *   - exponential backoff 2s → 5s when the queue is empty
 *   - on transient HTTP errors, keep polling (poll-loop must stay alive)
 *
 * Filtering: messages whose `agent_type !== "a8-claw"` are skipped (not
 * NAcked — per a8-code's pattern, an HTTP queue facade has no nack;
 * misrouting must be rare and warns loudly). Bad envelopes (missing
 * required fields) are dropped (logged); they're poison-pill candidates
 * and must not loop forever in the queue.
 *
 * NEVER routed through Platform MCP — this is runtime infra.
 */
import {
  buildCompletion,
  parseEnvelope,
  type AgentExecuteEnvelope,
  type CompletionStatus,
  type MissionCompletion,
} from './envelope.js';
import { maybeTriggerReflector } from './reflector-trigger.js';
import type { WarpQueueClient } from './warp-queue-client.js';

const COMPLETIONS_QUEUE = 'mission_completions';
const AGENT_TYPE = 'a8-claw';
const POLL_QUEUE_DEFAULT = 'agent_execute_a8_claw';

function log(msg: string): void {
  console.error(`[mq-consumer] ${msg}`);
}

/** What a runner returns to the consumer for the completion envelope. */
export interface RunnerResult {
  status: CompletionStatus;
  result?: { summary: string; [k: string]: unknown };
  usage?: Partial<MissionCompletion['usage']>;
  audit_event_count?: number;
  /** When status=failed, a short message that ends up in result.summary if no result provided. */
  error?: string;
}

/**
 * Injectable runner — receives the validated envelope, runs the actual
 * session work, returns the completion result. Real implementation is
 * the subprocess spawner in next commit; tests inject a stub.
 *
 * MUST NOT throw — the consumer catches and converts to status=failed,
 * but a clean runner contract is "always return a structured result."
 */
export type MissionRunner = (envelope: AgentExecuteEnvelope) => Promise<RunnerResult>;

export interface ConsumerOptions {
  queue: WarpQueueClient;
  runner: MissionRunner;
  /** Override the consume queue name. Default `agent_execute_a8_claw`. */
  pollQueueName?: string;
  /** Pod identifier emitted as `agent_id` on completions. */
  agentId: string;
  /** Sleep override for tests so the backoff loop can be deterministic. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class MissionConsumer {
  private opts: ConsumerOptions;
  private running = false;
  private currentMissionId: string | null = null;

  constructor(opts: ConsumerOptions) {
    this.opts = opts;
  }

  /**
   * Process exactly one mission then exit. Returns the completion that
   * was published, or null if shutdown was requested before any message
   * arrived.
   *
   * The pod's main() should call this and then exit — warm pool spawns
   * a replacement for the next mission.
   */
  async consumeOneAndExit(): Promise<MissionCompletion | null> {
    this.running = true;
    const queueName = this.opts.pollQueueName ?? POLL_QUEUE_DEFAULT;
    const sleep = this.opts.sleepImpl ?? defaultSleep;

    let backoffMs = 2000;
    while (this.running) {
      const msgs = await this.opts.queue.pollMessages(queueName, {
        maxMessages: 1,
        timeoutSeconds: 1.0,
      });
      if (msgs.length === 0) {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 5000);
        continue;
      }
      backoffMs = 2000;

      const parse = parseEnvelope(msgs[0]);
      if (parse.error) {
        // Poison pill — drop and continue. Re-queueing would loop forever
        // since the message body is malformed.
        log(`drop malformed envelope: ${parse.error}`);
        continue;
      }
      const envelope = parse.envelope!;
      if (envelope.agent_type !== AGENT_TYPE) {
        log(`skip agent_type=${envelope.agent_type} (not for us)`);
        continue;
      }

      this.currentMissionId = envelope.mission_id;
      log(
        `accepted mission_id=${envelope.mission_id} task_id=${envelope.task_id} ` +
          `tenant=${envelope.tenant_id} user=${envelope.user_id}`,
      );

      const completion = await this.runOne(envelope);
      // Autoskill end-of-task hook — fire-and-forget a reflector mission
      // for non-incognito, non-reflector successes. Doesn't block the
      // completion publish; the reflector picks up later from its own
      // queue entry. Failures are logged, never thrown.
      const triggered = await maybeTriggerReflector(
        this.opts.queue,
        envelope,
        completion,
        this.opts.agentId,
      );
      if (triggered.triggered) {
        log(`reflector queued: ${triggered.reflector_mission_id}`);
      }
      await this.publishCompletion(completion);
      this.currentMissionId = null;
      this.running = false;
      return completion;
    }
    return null;
  }

  /**
   * Shutdown signal — flips the running flag. If a mission is in flight
   * the runner is responsible for its own SIGTERM handling (subprocess
   * forwarding); the consumer just won't pick up another after this.
   */
  stop(): void {
    this.running = false;
  }

  /** For tests + observability — which mission_id is currently being processed, if any. */
  current(): string | null {
    return this.currentMissionId;
  }

  /**
   * Invoke the runner and translate exceptions to a failed completion.
   * Runners SHOULD not throw — but if they do (bug, OOM, etc.) we surface
   * a structured failed completion rather than crashing the pod silently.
   */
  private async runOne(envelope: AgentExecuteEnvelope): Promise<MissionCompletion> {
    const start = Date.now();
    let result: RunnerResult;
    try {
      result = await this.opts.runner(envelope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`runner threw — converting to status=failed: ${msg}`);
      result = { status: 'failed', error: `runner threw: ${msg}` };
    }
    const durationMs = Date.now() - start;
    // Fill in duration if the runner didn't report it.
    const usage: Partial<MissionCompletion['usage']> = {
      ...result.usage,
      duration_ms: result.usage?.duration_ms ?? durationMs,
    };
    return buildCompletion({
      envelope,
      agent_id: this.opts.agentId,
      status: result.status,
      result: result.result,
      usage,
      audit_event_count: result.audit_event_count,
      error: result.error,
    });
  }

  private async publishCompletion(completion: MissionCompletion): Promise<void> {
    const ok = await this.opts.queue.publish(COMPLETIONS_QUEUE, completion, { priority: 5 });
    if (!ok) {
      // Completion publish failure is a serious operational concern — the
      // coordinator won't see this mission's result. Log loudly. v1 has
      // no retry buffer here; future: persist to local jsonl + retry on
      // next pod boot.
      log(
        `WARN: failed to publish completion for ${completion.mission_id}/${completion.task_id} — ` +
          `coordinator will not see status=${completion.status}`,
      );
    } else {
      log(`published completion mission_id=${completion.mission_id} status=${completion.status}`);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
