/**
 * reflector-trigger tests — recursion + privacy + success gating.
 */
import { describe, expect, it, vi } from 'vitest';

import { maybeTriggerReflector } from './reflector-trigger.js';
import type { AgentExecuteEnvelope, MissionCompletion } from './envelope.js';
import { WarpQueueClient } from './warp-queue-client.js';

function envelope(overrides: Partial<AgentExecuteEnvelope> & { context?: Record<string, unknown> } = {}): AgentExecuteEnvelope {
  return {
    mission_id: 'mis-src-1',
    task_id: 'task-1',
    agent_type: 'a8-claw',
    tenant_id: 'tenant-acme',
    user_id: 'user-arun',
    parent_agent_id: null,
    role: 'data-analyst',
    goal: 'g',
    context: {},
    budget: { max_tokens: 1, max_wall_seconds: 60, max_concurrent_t3: 1, max_spawn_depth: 0 },
    cancellation_token: 'ct',
    idempotency_key: 'idem',
    audit_event_id: 'evt',
    ...overrides,
  };
}

function completion(overrides: Partial<MissionCompletion> = {}): MissionCompletion {
  return {
    mission_id: 'mis-src-1',
    task_id: 'task-1',
    agent_id: 'pod-1',
    agent_type: 'a8-claw',
    status: 'success',
    result: { summary: 'done' },
    usage: { tokens_in: 1, tokens_out: 1, model_calls: 1, tool_calls: 1, duration_ms: 100 },
    audit_event_count: 5,
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeQueue() {
  const published: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn((url: string | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST') {
      const sent = JSON.parse(init.body as string);
      published.push({ url: String(url), body: sent.body });
      return Promise.resolve(new Response('', { status: 202 }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  return {
    queue: new WarpQueueClient({ baseUrl: 'http://w', fetchImpl: fetchImpl as unknown as typeof fetch }),
    published,
  };
}

describe('maybeTriggerReflector', () => {
  it('triggers a reflector dispatch on a successful non-reflector non-incognito mission', async () => {
    const { queue, published } = fakeQueue();
    const r = await maybeTriggerReflector(queue, envelope(), completion(), 'pod-1');
    expect(r.triggered).toBe(true);
    expect(r.reflector_mission_id).toMatch(/^mis-/);
    expect(published.length).toBe(1);
    expect(published[0].url).toContain('agent_execute_a8_claw');
    const body = published[0].body as { context: Record<string, unknown>; role: string; budget: Record<string, number> };
    expect(body.role).toBe('arty-reflector');
    expect(body.context.persona).toBe('arty-reflector');
    expect(body.context.target_mission_id).toBe('mis-src-1');
    expect(body.context.trigger).toBe('end-of-task');
    expect(body.budget.max_spawn_depth).toBe(0);
  });

  it('does NOT trigger when the completion is not success', async () => {
    const { queue, published } = fakeQueue();
    const r = await maybeTriggerReflector(queue, envelope(), completion({ status: 'failed' }), 'pod-1');
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('not-success');
    expect(published.length).toBe(0);
  });

  it('does NOT trigger when source mission was itself a reflector (recursion guard)', async () => {
    const { queue, published } = fakeQueue();
    const r = await maybeTriggerReflector(
      queue,
      envelope({ context: { persona: 'arty-reflector' } }),
      completion(),
      'pod-1',
    );
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('is-reflector');
    expect(published.length).toBe(0);
  });

  it('does NOT trigger for incognito sessions (privacy guard)', async () => {
    const { queue, published } = fakeQueue();
    const r = await maybeTriggerReflector(
      queue,
      envelope({ context: { privacy: 'incognito' } }),
      completion(),
      'pod-1',
    );
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('incognito');
    expect(published.length).toBe(0);
  });

  it('returns submit-failed (no throw) when queue publish fails', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 })));
    const queue = new WarpQueueClient({ baseUrl: 'http://w', fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await maybeTriggerReflector(queue, envelope(), completion(), 'pod-1');
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('submit-failed');
  });

  it('attaches source_role + parent_agent_id for audit lineage', async () => {
    const { queue, published } = fakeQueue();
    await maybeTriggerReflector(queue, envelope({ role: 'engineer' }), completion(), 'pod-self-123');
    const body = published[0].body as { context: Record<string, unknown>; parent_agent_id: string };
    expect(body.context.source_role).toBe('engineer');
    expect(body.parent_agent_id).toBe('pod-self-123');
  });
});
