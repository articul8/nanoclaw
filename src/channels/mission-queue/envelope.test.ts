/**
 * Envelope parser tests — RUNTIME_CONTRACT_20260505 §2.1 conformance.
 *
 * The parser must REJECT malformed envelopes (and let the consumer drop
 * them) rather than producing partial data. These tests pin the strict-
 * validation behavior so we don't regress to silent fallthrough.
 */
import { describe, expect, it } from 'vitest';

import { buildCompletion, parseEnvelope, type AgentExecuteEnvelope } from './envelope.js';

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mission_id: 'mis-1',
    task_id: 'task-1',
    agent_type: 'a8-claw',
    tenant_id: 'tenant-acme',
    user_id: 'user-arun',
    parent_agent_id: null,
    role: 'data-analyst',
    goal: 'Analyze procurement data',
    context: { session_id: 's-1', domain_hint: 'procurement' },
    budget: {
      max_tokens: 200_000,
      max_wall_seconds: 1800,
      max_concurrent_t3: 2,
      max_spawn_depth: 1,
    },
    cancellation_token: 'ct-1',
    idempotency_key: 'idem-1',
    audit_event_id: 'evt-1',
    ...overrides,
  };
}

describe('parseEnvelope', () => {
  it('parses a fully-formed envelope', () => {
    const r = parseEnvelope(validRaw());
    expect(r.error).toBeUndefined();
    expect(r.envelope?.mission_id).toBe('mis-1');
    expect(r.envelope?.agent_type).toBe('a8-claw');
    expect(r.envelope?.budget.max_tokens).toBe(200_000);
  });

  it('unwraps a body-wrapped envelope (orchestrator publish_message shape)', () => {
    const r = parseEnvelope({ body: validRaw() });
    expect(r.error).toBeUndefined();
    expect(r.envelope?.mission_id).toBe('mis-1');
  });

  it('unwraps a data-wrapped envelope (some Warp variants)', () => {
    const r = parseEnvelope({ data: validRaw() });
    expect(r.error).toBeUndefined();
    expect(r.envelope?.mission_id).toBe('mis-1');
  });

  it('rejects missing mission_id', () => {
    const r = parseEnvelope(validRaw({ mission_id: undefined }));
    expect(r.envelope).toBeUndefined();
    expect(r.error).toContain('mission_id');
  });

  it('rejects empty-string tenant_id (security invariant — never accept empty)', () => {
    const r = parseEnvelope(validRaw({ tenant_id: '' }));
    expect(r.error).toContain('tenant_id');
  });

  it('rejects unknown agent_type', () => {
    const r = parseEnvelope(validRaw({ agent_type: 'mystery-runtime' }));
    expect(r.error).toContain('unknown agent_type');
  });

  it('rejects missing budget object', () => {
    const r = parseEnvelope(validRaw({ budget: undefined }));
    expect(r.error).toContain('budget');
  });

  it('rejects non-numeric budget field', () => {
    const r = parseEnvelope(
      validRaw({
        budget: {
          max_tokens: '200000', // string instead of number
          max_wall_seconds: 1800,
          max_concurrent_t3: 2,
          max_spawn_depth: 1,
        },
      }),
    );
    expect(r.error).toContain('max_tokens');
  });

  it('accepts parent_agent_id null AND absent', () => {
    expect(parseEnvelope(validRaw({ parent_agent_id: null })).error).toBeUndefined();
    const obj = validRaw();
    delete obj.parent_agent_id;
    expect(parseEnvelope(obj).error).toBeUndefined();
  });

  it('parses each known agent_type', () => {
    for (const t of ['atomic-agent', 'a8-code', 'a8-claw']) {
      expect(parseEnvelope(validRaw({ agent_type: t })).error).toBeUndefined();
    }
  });

  it('produces typed envelope with all required fields', () => {
    const r = parseEnvelope(validRaw());
    const env = r.envelope as AgentExecuteEnvelope;
    expect(env.mission_id).toBe('mis-1');
    expect(env.role).toBe('data-analyst');
    expect(env.cancellation_token).toBe('ct-1');
    expect(env.context).toEqual({ session_id: 's-1', domain_hint: 'procurement' });
  });
});

describe('buildCompletion', () => {
  const envelope: AgentExecuteEnvelope = {
    mission_id: 'mis-1',
    task_id: 'task-1',
    agent_type: 'a8-claw',
    tenant_id: 't',
    user_id: 'u',
    parent_agent_id: null,
    role: 'analyst',
    goal: 'do thing',
    context: {},
    budget: { max_tokens: 1, max_wall_seconds: 1, max_concurrent_t3: 1, max_spawn_depth: 1 },
    cancellation_token: 'ct',
    idempotency_key: 'idem',
    audit_event_id: 'evt',
  };

  it('builds a success completion with provided result + usage', () => {
    const c = buildCompletion({
      envelope,
      agent_id: 'pod-1',
      status: 'success',
      result: { summary: 'done', findings: ['a', 'b'] },
      usage: { tokens_in: 100, tokens_out: 50, model_calls: 3, tool_calls: 7, duration_ms: 1234 },
      audit_event_count: 42,
    });
    expect(c.mission_id).toBe('mis-1');
    expect(c.agent_id).toBe('pod-1');
    expect(c.status).toBe('success');
    expect(c.result.summary).toBe('done');
    expect(c.usage.tokens_in).toBe(100);
    expect(c.audit_event_count).toBe(42);
    expect(c.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('synthesizes a summary from error when result omitted on failure', () => {
    const c = buildCompletion({
      envelope,
      agent_id: 'pod-1',
      status: 'failed',
      error: 'OOM at turn 3',
    });
    expect(c.result.summary).toBe('OOM at turn 3');
  });

  it('zeros usage fields when runner omitted them (contract: usage REQUIRED)', () => {
    const c = buildCompletion({ envelope, agent_id: 'pod-1', status: 'success' });
    expect(c.usage).toEqual({
      tokens_in: 0,
      tokens_out: 0,
      model_calls: 0,
      tool_calls: 0,
      duration_ms: 0,
    });
  });
});
