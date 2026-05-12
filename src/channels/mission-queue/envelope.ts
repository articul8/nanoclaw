/**
 * Mission envelope types + parser.
 *
 * Locked shape per RUNTIME_CONTRACT_20260505.md §2.1 and §3.1. Read-only
 * after Bundle 1 ships — any change here requires coordinated cross-
 * runtime PR + ADR per contract §2.
 *
 * Runtimes (a8-claw / a8-code / atomic-agent) all conform to the same
 * envelopes; this module is the arty side's parser. Validation is strict:
 * an envelope missing a required field is REJECTED and an error returned,
 * the message is acked-and-skipped (drop) rather than nacked (re-queue),
 * because re-queueing a malformed message would loop forever.
 */

import type { QueueMessage } from './warp-queue-client.js';

export type AgentType = 'atomic-agent' | 'a8-code' | 'a8-claw';
export type CompletionStatus = 'success' | 'partial' | 'failed' | 'cancelled';

/** Contract §2.1 — required for every dispatch. */
export interface AgentExecuteEnvelope {
  mission_id: string;
  task_id: string;
  agent_type: AgentType;
  tenant_id: string;
  user_id: string;
  parent_agent_id: string | null;
  role: string;
  goal: string;
  context: Record<string, unknown>;
  budget: {
    max_tokens: number;
    max_wall_seconds: number;
    max_concurrent_t3: number;
    max_spawn_depth: number;
  };
  cancellation_token: string;
  idempotency_key: string;
  audit_event_id: string;
}

/** Contract §3.1 — published to `mission_completions` on session exit. */
export interface MissionCompletion {
  mission_id: string;
  task_id: string;
  agent_id: string;
  agent_type: AgentType;
  status: CompletionStatus;
  result: {
    summary: string;
    [k: string]: unknown;
  };
  usage: {
    tokens_in: number;
    tokens_out: number;
    model_calls: number;
    tool_calls: number;
    duration_ms: number;
  };
  audit_event_count: number;
  completed_at: string;
}

export interface ParseResult {
  envelope?: AgentExecuteEnvelope;
  /** Set when envelope=undefined; lists the field(s) that failed validation. */
  error?: string;
}

/**
 * Strict parser for the agent_execute envelope. Returns either a typed
 * envelope or a short error explaining what's wrong. Never throws.
 *
 * Accepts loose shapes (Warp's queue body sometimes wraps the payload).
 * If the input has a `body` or `data` field, parse drills into it once —
 * matches a8-code's tolerance for `message.payload.body` and the
 * orchestrator's `publish_message` shape which wraps under `body`.
 */
export function parseEnvelope(raw: QueueMessage): ParseResult {
  // Unwrap one level of envelope if present. a8-code's poll output already
  // returns the body via warp-client.ts's normalizer, so this is defensive
  // belt-and-suspenders for the case where the body slipped through wrapped.
  const inner = unwrap(raw);
  const obj = inner as Record<string, unknown>;

  const missing: string[] = [];
  for (const k of [
    'mission_id',
    'task_id',
    'agent_type',
    'tenant_id',
    'user_id',
    'role',
    'goal',
    'cancellation_token',
    'idempotency_key',
    'audit_event_id',
  ] as const) {
    if (typeof obj[k] !== 'string' || (obj[k] as string).length === 0) {
      missing.push(k);
    }
  }
  if (missing.length > 0) {
    return { error: `missing or non-string: ${missing.join(', ')}` };
  }

  const agentType = obj.agent_type as string;
  if (agentType !== 'atomic-agent' && agentType !== 'a8-code' && agentType !== 'a8-claw') {
    return { error: `unknown agent_type: ${agentType}` };
  }

  const context = obj.context;
  if (context !== undefined && context !== null && typeof context !== 'object') {
    return { error: 'context must be object or absent' };
  }

  const budget = obj.budget as Record<string, unknown> | undefined;
  if (!budget || typeof budget !== 'object') {
    return { error: 'budget missing or not an object' };
  }
  for (const k of ['max_tokens', 'max_wall_seconds', 'max_concurrent_t3', 'max_spawn_depth'] as const) {
    if (typeof budget[k] !== 'number') {
      return { error: `budget.${k} must be a number` };
    }
  }

  return {
    envelope: {
      mission_id: obj.mission_id as string,
      task_id: obj.task_id as string,
      agent_type: agentType as AgentType,
      tenant_id: obj.tenant_id as string,
      user_id: obj.user_id as string,
      parent_agent_id: (obj.parent_agent_id as string | null | undefined) ?? null,
      role: obj.role as string,
      goal: obj.goal as string,
      context: (context as Record<string, unknown>) ?? {},
      budget: {
        max_tokens: budget.max_tokens as number,
        max_wall_seconds: budget.max_wall_seconds as number,
        max_concurrent_t3: budget.max_concurrent_t3 as number,
        max_spawn_depth: budget.max_spawn_depth as number,
      },
      cancellation_token: obj.cancellation_token as string,
      idempotency_key: obj.idempotency_key as string,
      audit_event_id: obj.audit_event_id as string,
    },
  };
}

/**
 * Build a `mission_completions` envelope from the source mission envelope
 * + runner result. Used by the consumer to publish on session exit.
 */
export interface BuildCompletionInput {
  envelope: AgentExecuteEnvelope;
  agent_id: string;
  status: CompletionStatus;
  result?: { summary: string; [k: string]: unknown };
  usage?: Partial<MissionCompletion['usage']>;
  audit_event_count?: number;
  error?: string;
}

export function buildCompletion(input: BuildCompletionInput): MissionCompletion {
  return {
    mission_id: input.envelope.mission_id,
    task_id: input.envelope.task_id,
    agent_id: input.agent_id,
    agent_type: input.envelope.agent_type,
    status: input.status,
    result: input.result ?? {
      summary: input.error ?? (input.status === 'success' ? 'completed' : `exited ${input.status}`),
    },
    usage: {
      tokens_in: input.usage?.tokens_in ?? 0,
      tokens_out: input.usage?.tokens_out ?? 0,
      model_calls: input.usage?.model_calls ?? 0,
      tool_calls: input.usage?.tool_calls ?? 0,
      duration_ms: input.usage?.duration_ms ?? 0,
    },
    audit_event_count: input.audit_event_count ?? 0,
    completed_at: new Date().toISOString(),
  };
}

function unwrap(raw: QueueMessage): QueueMessage {
  const obj = raw as Record<string, unknown>;
  if (obj && typeof obj === 'object') {
    if ('body' in obj && typeof obj.body === 'object' && obj.body !== null) {
      return obj.body as QueueMessage;
    }
    if ('data' in obj && typeof obj.data === 'object' && obj.data !== null) {
      return obj.data as QueueMessage;
    }
  }
  return raw;
}
