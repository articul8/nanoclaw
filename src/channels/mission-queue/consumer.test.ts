/**
 * MissionConsumer tests — the cloud pod's main loop.
 *
 * Covers:
 *   - happy path: poll → parse → runner → publish completion → exit
 *   - filters foreign agent_type (skip without running runner)
 *   - drops malformed envelopes (no infinite loop on poison pills)
 *   - completion publish failure logs but doesn't throw
 *   - runner exceptions converted to status=failed completion
 *   - stop() halts the loop on next poll iteration
 *   - duration is auto-filled when runner omits it
 *
 * WarpQueueClient is mocked via the public constructor (no fetch stub
 * needed at this layer — the queue client wraps fetch already).
 */
import { describe, expect, it, vi } from 'vitest';

import { MissionConsumer, type MissionRunner, type RunnerResult } from './consumer.js';
import { WarpQueueClient } from './warp-queue-client.js';

function validEnvelope(): Record<string, unknown> {
  return {
    mission_id: 'mis-1',
    task_id: 'task-1',
    agent_type: 'a8-claw',
    tenant_id: 'tenant-acme',
    user_id: 'user-arun',
    parent_agent_id: null,
    role: 'data-analyst',
    goal: 'g',
    context: {},
    budget: { max_tokens: 1, max_wall_seconds: 1, max_concurrent_t3: 1, max_spawn_depth: 1 },
    cancellation_token: 'ct-1',
    idempotency_key: 'idem-1',
    audit_event_id: 'evt-1',
  };
}

/** Build a queue client whose poll returns a queued sequence + records publishes. */
function fakeQueue(pollSequence: Array<Record<string, unknown>[]>) {
  let i = 0;
  const published: Array<{ queue: string; body: unknown }> = [];
  let publishOk = true;

  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (init?.method === 'POST') {
      const sent = init.body ? JSON.parse(init.body as string) : null;
      const m = url.match(/\/queues\/([^/]+)\/messages/);
      published.push({ queue: m ? decodeURIComponent(m[1]) : url, body: sent?.body });
      return new Response('', { status: publishOk ? 202 : 500 });
    }
    // GET poll
    const batch = pollSequence[i] ?? [];
    if (i < pollSequence.length) i += 1;
    if (batch.length === 0) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ messages: batch }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return {
    queue: new WarpQueueClient({
      baseUrl: 'http://warp.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
    published,
    setPublishOk: (v: boolean) => {
      publishOk = v;
    },
  };
}

describe('MissionConsumer.consumeOneAndExit', () => {
  it('polls until a message arrives, runs it, publishes a completion, exits', async () => {
    const { queue, published } = fakeQueue([[], [], [validEnvelope()]]);
    const runner: MissionRunner = vi.fn(
      async (env): Promise<RunnerResult> => ({
        status: 'success',
        result: { summary: `analyzed ${env.role}` },
        usage: { tokens_in: 10, tokens_out: 5, model_calls: 1, tool_calls: 0 },
        audit_event_count: 3,
      }),
    );

    const consumer = new MissionConsumer({
      queue,
      runner,
      agentId: 'pod-test-1',
      sleepImpl: () => Promise.resolve(),
    });
    const completion = await consumer.consumeOneAndExit();

    expect(completion?.status).toBe('success');
    expect(completion?.mission_id).toBe('mis-1');
    expect(completion?.agent_id).toBe('pod-test-1');
    expect(completion?.audit_event_count).toBe(3);
    expect(runner).toHaveBeenCalledTimes(1);
    // Two publishes per successful non-incognito mission: an
    // agent_execute_a8_claw for the autoskill reflector trigger (fire-
    // and-forget; runs in a parallel session), plus the mission_completions
    // entry the coordinator consumes. Assert the completion specifically;
    // the reflector dispatch shape is covered in reflector-trigger.test.ts.
    expect(published.filter((p) => p.queue === 'mission_completions')).toEqual([
      { queue: 'mission_completions', body: completion },
    ]);
    expect(published.some((p) => p.queue === 'agent_execute_a8_claw')).toBe(true);
  });

  it('skips foreign agent_type without invoking the runner', async () => {
    const { queue, published } = fakeQueue([
      [{ ...validEnvelope(), agent_type: 'a8-code' }],
      [],
      [validEnvelope()],
    ]);
    const runner: MissionRunner = vi.fn(async (): Promise<RunnerResult> => ({
      status: 'success',
      result: { summary: 'ok' },
    }));
    const consumer = new MissionConsumer({
      queue,
      runner,
      agentId: 'pod-test-2',
      sleepImpl: () => Promise.resolve(),
    });
    const completion = await consumer.consumeOneAndExit();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(completion?.mission_id).toBe('mis-1');
    // 1 completion + 1 reflector dispatch = 2 publishes total on a successful run.
    expect(published.filter((p) => p.queue === 'mission_completions').length).toBe(1);
  });

  it('drops a malformed envelope (no runner invocation, no completion published for that message)', async () => {
    const { queue, published } = fakeQueue([
      [{ mission_id: 'broken' /* missing required fields */ }],
      [],
      [validEnvelope()],
    ]);
    const runner: MissionRunner = vi.fn(async (): Promise<RunnerResult> => ({
      status: 'success',
      result: { summary: 'ok' },
    }));
    const consumer = new MissionConsumer({
      queue,
      runner,
      agentId: 'pod-test-3',
      sleepImpl: () => Promise.resolve(),
    });
    const completion = await consumer.consumeOneAndExit();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(completion?.mission_id).toBe('mis-1');
    // Exactly one completion published (for the valid message). The dropped
    // malformed envelope produced no completion at all. The reflector
    // trigger for the successful run adds an agent_execute_a8_claw publish;
    // assert on completions specifically.
    expect(published.filter((p) => p.queue === 'mission_completions').length).toBe(1);
  });

  it('converts runner exceptions to status=failed without crashing the pod', async () => {
    const { queue, published } = fakeQueue([[validEnvelope()]]);
    const runner: MissionRunner = vi.fn(async () => {
      throw new Error('runner OOM');
    });
    const consumer = new MissionConsumer({
      queue,
      runner,
      agentId: 'pod-test-4',
      sleepImpl: () => Promise.resolve(),
    });
    const completion = await consumer.consumeOneAndExit();
    expect(completion?.status).toBe('failed');
    expect(completion?.result.summary).toContain('runner OOM');
    expect(published.length).toBe(1);
  });

  it('logs but does not throw when completion publish fails (operational warning)', async () => {
    const fake = fakeQueue([[validEnvelope()]]);
    fake.setPublishOk(false);
    const runner: MissionRunner = vi.fn(async (): Promise<RunnerResult> => ({
      status: 'success',
      result: { summary: 'ok' },
    }));
    const consumer = new MissionConsumer({
      queue: fake.queue,
      runner,
      agentId: 'pod-test-5',
      sleepImpl: () => Promise.resolve(),
    });
    // Must complete without throwing.
    const completion = await consumer.consumeOneAndExit();
    expect(completion).not.toBeNull();
    expect(completion?.status).toBe('success');
  });

  it('auto-fills duration_ms when runner omits it', async () => {
    const { queue } = fakeQueue([[validEnvelope()]]);
    const runner: MissionRunner = vi.fn(
      async (): Promise<RunnerResult> => ({ status: 'success', result: { summary: 'ok' } }),
    );
    const consumer = new MissionConsumer({
      queue,
      runner,
      agentId: 'pod-test-6',
      sleepImpl: () => Promise.resolve(),
    });
    const completion = await consumer.consumeOneAndExit();
    expect(completion?.usage.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('respects stop() — exits the poll loop without picking up another mission', async () => {
    // Empty forever; stop() flips the flag.
    const { queue } = fakeQueue([[], [], []]);
    const runner: MissionRunner = vi.fn();
    const consumer = new MissionConsumer({
      queue,
      runner,
      agentId: 'pod-test-7',
      sleepImpl: () => Promise.resolve(),
    });
    const promise = consumer.consumeOneAndExit();
    // Stop immediately — the loop should exit on next iteration.
    consumer.stop();
    const result = await promise;
    expect(result).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
});
