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

export const LIVE_EVENT_PREFIX = LIVE_PREFIX;
