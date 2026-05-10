import fs from 'fs';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { writeMissionEvent } from '../audit.js';
import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { emitLive } from '../live-render.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Translate one SDK message into zero-or-more live-render events.
 *
 * The events are emitted via emitLive() which writes to stdout — the
 * host's container-runner parses them and forwards each to the active
 * channel adapter (cli today; mission-queue / others later).
 *
 * What we forward:
 *   - text_delta on a stream_event → live `text` chunk (token streaming)
 *   - tool_use blocks at content_block_stop → live `tool_call` carrying
 *     the fully-assembled input (renders as `→ WebSearch: <query>`).
 *     We accumulate input_json_delta chunks per block index across the
 *     stream because the input arrives token-by-token after the block
 *     opens, not at content_block_start.
 *   - tool_result blocks on user messages → live `tool_result`
 *
 * What we deliberately drop (already covered by outbound.db audit + the
 * `done` event we emit at end of stream):
 *   - whole-block 'assistant' messages — text deltas already covered the
 *     content; the assembled message is just a recap
 *   - thinking deltas — privacy default; can be opt-in later
 */

/**
 * Per-block state for in-flight tool_use blocks. Keyed by the
 * content-block index from the SDK stream. The input streams in across
 * many input_json_delta events; we accumulate the partial_json fragments
 * here and parse + emit at content_block_stop.
 *
 * Map cleared opportunistically as blocks close. If the stream aborts
 * mid-block, the entry leaks until the next process restart — harmless,
 * agent-runner is short-lived.
 */
const toolUseBlocks: Map<number, { name: string; json: string }> = new Map();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitLiveFromSdkMessage(message: any): void {
  try {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'stream_event' && message.event) {
      const ev = message.event;

      // Token-level text streaming.
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        if (ev.delta.text.length > 0) emitLive({ type: 'text', text: ev.delta.text });
        return;
      }

      // Tool block opens — record name, prepare to accumulate input.
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        const name = typeof ev.content_block.name === 'string' ? ev.content_block.name : 'tool';
        // The SDK sometimes seeds `input` with a partial object at
        // content_block_start (typically `{}`); the rest streams as
        // input_json_delta. Stringify the seed so we have a uniform
        // accumulator type.
        const seed =
          ev.content_block.input && typeof ev.content_block.input === 'object'
            ? Object.keys(ev.content_block.input).length > 0
              ? JSON.stringify(ev.content_block.input)
              : ''
            : '';
        toolUseBlocks.set(ev.index, { name, json: seed });
        return;
      }

      // Tool input streaming.
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
        const entry = toolUseBlocks.get(ev.index);
        if (entry && typeof ev.delta.partial_json === 'string') {
          entry.json += ev.delta.partial_json;
        }
        return;
      }

      // Block closes — for tool_use blocks, this is when we have the
      // full input and can emit a status line carrying the actual query.
      if (ev.type === 'content_block_stop') {
        const entry = toolUseBlocks.get(ev.index);
        if (entry) {
          let parsedInput: unknown = undefined;
          if (entry.json) {
            try {
              parsedInput = JSON.parse(entry.json);
            } catch {
              // Malformed JSON shouldn't block the live render — fall
              // back to the raw string so the REPL still has something
              // to display.
              parsedInput = entry.json;
            }
          }
          emitLive({ type: 'tool_call', name: entry.name, input: parsedInput });
          toolUseBlocks.delete(ev.index);
        }
        return;
      }

      // Turn end — clear any leftover blocks (shouldn't happen, but be
      // defensive against partial streams).
      if (ev.type === 'message_stop') {
        toolUseBlocks.clear();
        return;
      }
      return;
    }

    // Tool results land on a 'user' message after the SDK runs the tool.
    if (message.type === 'user' && message.message?.content && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block?.type === 'tool_result') {
          const ok = !block.is_error;
          // Take a short summary of the result for the status line —
          // result content is usually a string or an array of {type:'text',text}.
          let summary: string | undefined;
          if (typeof block.content === 'string') {
            summary = block.content.slice(0, 120);
          } else if (Array.isArray(block.content)) {
            const firstText = block.content.find((c: { type?: string; text?: string }) => c.type === 'text' && c.text);
            if (firstText?.text) summary = firstText.text.slice(0, 120);
          }
          // We don't have the tool name on the result block (only the
          // tool_use_id which links back). Leave name empty — the REPL
          // can render "← ok / err" without it.
          emitLive({ type: 'tool_result', name: '', ok, summary });
        }
      }
    }
  } catch {
    // Live channel is best-effort; never let it break the main translate
    // loop or the audit DB write.
  }
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    // Audit the rejection so the trail captures *why* the agent's call
    // was blocked (not just that it didn't happen). Useful for debugging
    // a stuck agent or proving an attempted-but-blocked action.
    void writeMissionEvent({
      event_kind: 'tool_call',
      payload: { tool_name: toolName, success: false, blocked: true },
      rationale: `Blocked: tool '${toolName}' is not available in this environment.`,
    });
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Audit the tool call (success TBD, will be updated by PostToolUse).
  // Record latency timestamp so the post-hook can compute latency_ms per
  // contract §4.3. We stash the start-time on a module-level Map keyed
  // by tool_use_id.
  const toolUseId = (i as { tool_use_id?: string }).tool_use_id;
  if (toolUseId) {
    toolStartTimes.set(toolUseId, Date.now());
  }
  return { continue: true };
};

/** Track tool start times for latency_ms in the post-use audit event. */
const toolStartTimes = new Map<string, number>();

/** Clear in-flight tool on PostToolUse / PostToolUseFailure + audit. */
const postToolUseHook: HookCallback = async (input) => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Audit the completion with success + latency.
  const i = input as {
    tool_name?: string;
    tool_use_id?: string;
    tool_response?: { is_error?: boolean };
  };
  const toolName = i.tool_name ?? '';
  const toolUseId = i.tool_use_id;
  const startedAt = toolUseId ? toolStartTimes.get(toolUseId) : undefined;
  const latencyMs = startedAt ? Date.now() - startedAt : null;
  if (toolUseId) toolStartTimes.delete(toolUseId);
  const success = !i.tool_response?.is_error;
  void writeMissionEvent({
    event_kind: 'tool_call',
    payload: {
      tool_name: toolName,
      success,
      ...(latencyMs != null ? { latency_ms: latencyMs } : {}),
    },
  });
  return { continue: true };
};

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find((e: { sessionId: string; summary?: string }) => e.sessionId === sessionId)?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/bin/claude',
        // includePartialMessages enables `stream_event` SDK messages, which
        // carry token-level text_delta + tool_use_start. We forward those
        // to live-render so the user's terminal sees the reply form in real
        // time. Without this, the SDK only emits whole-block 'assistant'
        // messages and the user waits in silence for the full turn.
        includePartialMessages: true,
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        allowedTools: [
          ...TOOL_ALLOWLIST,
          ...Object.keys(this.mcpServers).map(mcpAllowPattern),
        ],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        // Live render side-channel: forward token-level deltas + tool calls
        // to stdout so the host's container-runner can pipe them straight
        // to the user's terminal. This bypasses the outbound.db poll cycle
        // (which is batch + on-disk + 500ms-latency) entirely. The audit
        // row is still written at end-of-turn, async, never gating render.
        emitLiveFromSdkMessage(message);

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          const text = 'result' in message ? (message as { result?: string }).result ?? null : null;
          // SDK keeps its stream open across turns (push() feeds the same
          // query). `result` is the end-of-turn marker — that's when the
          // live channel needs its `done` so the REPL can re-prompt.
          // (Emitting `done` only at end-of-iterable would never fire.)
          emitLive({ type: 'done' });
          yield { type: 'result', text };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'result', text: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          const intent = tn.summary || 'Task notification';
          // Surface SDK task notifications as narration so the user sees
          // the same "going to do X, then Y" pre-action transparency
          // Claude Code provides natively. Category 'sdk' lets the
          // renderer/audit distinguish these from agent-authored intents
          // (which the agent emits via prose text in its replies).
          // Mission-event-kind doesn't have a perfect mapping; closest is
          // `heartbeat` (presence signal), but with a rationale payload
          // the trail captures the agent's stated plan.
          emitLive({ type: 'narration', intent, category: 'sdk' });
          void writeMissionEvent({
            event_kind: 'heartbeat',
            payload: { source: 'sdk_task_notification' },
            rationale: intent,
            narration_category: 'sdk',
          });
          yield { type: 'progress', message: intent };
        }
      }
      // End-of-turn marker on the live channel so the REPL knows to
      // flush its trailing newline + re-prompt.
      emitLive({ type: 'done' });
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
