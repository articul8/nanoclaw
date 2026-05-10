/**
 * Live-render side-channel — bypass the session DB for streaming token
 * output so the user sees reply text + tool calls in real time, instead
 * of waiting for the whole turn to land in outbound.db.
 *
 * Mechanism: write JSON-line events to stdout. The host's container-runner
 * captures stdout and forwards each line to whichever channel adapter
 * owns the active client socket for this session (cli today; future
 * channels opt in by handling LiveEvent shapes they care about).
 *
 * outbound.db is still written at end of turn for durable audit. The
 * live channel never blocks on disk; the audit write is fire-and-forget
 * after rendering is done. If the container dies mid-stream, the user
 * loses the live render but the audit row survives once it lands.
 *
 * Channels that don't subscribe to live events (Slack, Telegram, etc.)
 * see no change — they continue to consume final accumulated rows from
 * outbound.db.
 */

export type LiveEvent =
  /** Streaming text chunk from the assistant. */
  | { type: 'text'; text: string }
  /**
   * Pre-action narration — Claude-Code-style "I'm about to do X because Y"
   * sentence emitted BEFORE the action it describes. Carries a `category`
   * so the renderer can distinguish a routine tool announcement from a
   * structural decision (peer delegation, MCP install, tier bump) which
   * may want stronger UI emphasis. Captured on the audit ledger too so
   * the rationale survives compaction.
   */
  | {
      type: 'narration';
      intent: string;
      category:
        | 'plan' // overall turn plan ("Going to search, then summarize")
        | 'tool' // about to invoke a tool (paired with tool_call)
        | 'delegate' // peer-runtime delegation (claw → a8-code, etc.)
        | 'install' // MCP / channel / extension addition
        | 'approval' // requesting human approval
        | 'route' // channel / runtime / model routing decision
        | 'memory' // memory write / recall
        | 'tier' // tier escalation / resource decision
        | 'sdk'; // forwarded from SDK task_notification etc.
    }
  /** Assistant invoked a tool — render a brief status line. */
  | { type: 'tool_call'; name: string; input?: unknown }
  /** Tool returned — optional summary for the user. */
  | { type: 'tool_result'; name: string; ok: boolean; summary?: string }
  /** Turn finished — render trailing newline + re-prompt. */
  | { type: 'done' };

const LIVE_PREFIX = '__a8_live__:';

/**
 * Emit a single live-render event. Prefixes with a magic token so the
 * host-side parser can tell live events apart from any incidental
 * stdout noise (logs, debugger output, etc.). Stdout is shared with
 * `console.error`-routed agent-runner logs, so we can't assume each
 * line is one of ours.
 */
export function emitLive(event: LiveEvent): void {
  try {
    process.stdout.write(LIVE_PREFIX + JSON.stringify(event) + '\n');
  } catch {
    // EPIPE if host stopped reading — never fatal; audit DB still gets
    // the final row.
  }
}

/**
 * Convenience: emit a narration event from anywhere in the agent-runner
 * (orchestration code, MCP tools, peer-delegation paths) without
 * constructing the union by hand. Mirror sites: every narrate() call
 * site should also fire a writeMissionEvent({event_kind, rationale}) on
 * the audit ledger — the wrapper in src/audit.ts handles both via
 * `narrateAndAudit()`.
 */
export type NarrationCategory = 'plan' | 'tool' | 'delegate' | 'install' | 'approval' | 'route' | 'memory' | 'tier' | 'sdk';

export function narrate(intent: string, category: NarrationCategory): void {
  emitLive({ type: 'narration', intent, category });
}

/**
 * Narration + audit in one call. The narration lands on the live channel
 * for the user; the audit lands on the durable ledger for compliance.
 * Mirrors §4 of the runtime contract — every state-changing decision
 * gets a ledger row with the same rationale the user just saw.
 *
 * `event_kind` is the closed enum from the contract. For state changes
 * that don't have a perfect kind, pick the closest mapping (typically
 * `tool_call` for tool invocations, `bus_message_out` / `dispatch` /
 * `spawn` for peer comms, `model_call` for model invocations).
 *
 * Fire-and-forget — never awaits. The audit call returns a Promise that
 * resolves quickly even on Warp-side error (fallback to local JSONL).
 */
export function narrateAndAudit(opts: {
  intent: string;
  category: NarrationCategory;
  // Late-binding via dynamic import to avoid a circular dep between
  // live-render (used by every module) and audit (uses NarrationCategory
  // from this file).
  event_kind: string; // EventKind from audit.ts — strung here to dodge import
  payload?: Record<string, unknown>;
  task_id?: string | null;
}): void {
  emitLive({ type: 'narration', intent: opts.intent, category: opts.category });
  // Lazy import — keeps the live-render hot path zero-dep on audit.
  void import('./audit.js').then(({ writeMissionEvent }) =>
    writeMissionEvent({
      event_kind: opts.event_kind as never,
      payload: opts.payload ?? {},
      rationale: opts.intent,
      narration_category: opts.category,
      task_id: opts.task_id ?? null,
    }),
  );
}

export const LIVE_EVENT_PREFIX = LIVE_PREFIX;
