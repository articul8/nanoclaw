/**
 * submitMission tests — emit-side dispatch to peer queues.
 *
 * Verifies envelope construction, queue-name derivation
 * (`agent_execute_<runtime>`), required-field defaults, and the
 * tenant_id/user_id security invariant.
 */
import { describe, expect, it, vi } from 'vitest';

import { submitMission } from './submit.js';
import { WarpQueueClient } from './warp-queue-client.js';

function makeQueue() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn((url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (init?.method === 'POST') {
      const sent = JSON.parse(init.body as string);
      calls.push({ url: u, body: sent.body });
      return Promise.resolve(new Response('', { status: 202 }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const queue = new WarpQueueClient({ baseUrl: 'http://warp.test', fetchImpl: fetchImpl as unknown as typeof fetch });
  return { queue, calls };
}

describe('submitMission', () => {
  it('publishes to agent_execute_<peer> with peer-specific underscoreified queue name', async () => {
    const { queue, calls } = makeQueue();
    const r = await submitMission(queue, {
      agent_type: 'a8-code',
      role: 'engineer',
      goal: 'refactor module X',
      tenant_id: 't',
      user_id: 'u',
    });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/queues/agent_execute_a8_code/messages');
  });

  it('rejects when tenant_id is empty (security invariant)', async () => {
    const { queue } = makeQueue();
    await expect(
      submitMission(queue, {
        agent_type: 'a8-code',
        role: 'r',
        goal: 'g',
        tenant_id: '',
        user_id: 'u',
      }),
    ).rejects.toThrow(/tenant_id and user_id are required/);
  });

  it('rejects when user_id is empty (security invariant)', async () => {
    const { queue } = makeQueue();
    await expect(
      submitMission(queue, {
        agent_type: 'atomic-agent',
        role: 'r',
        goal: 'g',
        tenant_id: 't',
        user_id: '',
      }),
    ).rejects.toThrow(/tenant_id and user_id are required/);
  });

  it('mints mission_id, task_id, cancellation_token, idempotency_key, audit_event_id', async () => {
    const { queue, calls } = makeQueue();
    const r = await submitMission(queue, {
      agent_type: 'a8-claw',
      role: 'reflector',
      goal: 'reflect on yesterday',
      tenant_id: 't',
      user_id: 'u',
    });
    expect(r.envelope.mission_id).toMatch(/^mis-/);
    expect(r.envelope.task_id).toMatch(/^task-/);
    expect(r.envelope.cancellation_token).toMatch(/^ct-/);
    expect(r.envelope.idempotency_key).toMatch(/^idem-/);
    expect(r.envelope.audit_event_id).toMatch(/^evt-/);
    // Body sent on the wire matches what's returned.
    expect((calls[0].body as { mission_id: string }).mission_id).toBe(r.envelope.mission_id);
  });

  it('preserves caller-supplied mission_id (resume semantics)', async () => {
    const { queue } = makeQueue();
    const r = await submitMission(queue, {
      agent_type: 'a8-claw',
      role: 'r',
      goal: 'g',
      tenant_id: 't',
      user_id: 'u',
      mission_id: 'mis-keep-me',
    });
    expect(r.envelope.mission_id).toBe('mis-keep-me');
  });

  it('preserves caller-supplied task_id (fan-out semantics)', async () => {
    const { queue } = makeQueue();
    const r = await submitMission(queue, {
      agent_type: 'a8-claw',
      role: 'r',
      goal: 'g',
      tenant_id: 't',
      user_id: 'u',
      task_id: 'task-fanout-3',
    });
    expect(r.envelope.task_id).toBe('task-fanout-3');
  });

  it('applies conservative budget defaults when omitted', async () => {
    const { queue } = makeQueue();
    const r = await submitMission(queue, {
      agent_type: 'a8-code',
      role: 'r',
      goal: 'g',
      tenant_id: 't',
      user_id: 'u',
    });
    expect(r.envelope.budget.max_tokens).toBe(200_000);
    expect(r.envelope.budget.max_wall_seconds).toBe(1800);
    expect(r.envelope.budget.max_spawn_depth).toBe(0);
  });

  it('respects caller budget override', async () => {
    const { queue } = makeQueue();
    const r = await submitMission(queue, {
      agent_type: 'a8-code',
      role: 'r',
      goal: 'g',
      tenant_id: 't',
      user_id: 'u',
      budget: { max_tokens: 50_000, max_wall_seconds: 600 },
    });
    expect(r.envelope.budget.max_tokens).toBe(50_000);
    expect(r.envelope.budget.max_wall_seconds).toBe(600);
    // Unsupplied fields still get the conservative default.
    expect(r.envelope.budget.max_concurrent_t3).toBe(2);
  });

  it('returns ok=false (no throw) when publish fails', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    const queue = new WarpQueueClient({
      baseUrl: 'http://warp.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await submitMission(queue, {
      agent_type: 'a8-code',
      role: 'r',
      goal: 'g',
      tenant_id: 't',
      user_id: 'u',
    });
    expect(r.ok).toBe(false);
    // The envelope is still returned so the caller can audit-log what was attempted.
    expect(r.envelope.mission_id).toMatch(/^mis-/);
  });
});
