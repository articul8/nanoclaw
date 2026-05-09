/**
 * OpenAI-compatible provider — streaming + function-calling adapter.
 *
 * Targets any LLM service exposing the OpenAI Chat Completions API:
 * OpenAI itself, Together, Fireworks, Groq, vLLM, Ollama (with OpenAI
 * compat layer), or self-hosted endpoints. Env:
 *   - OPENAI_BASE_URL  (default https://api.openai.com)
 *   - OPENAI_API_KEY   (Bearer auth)
 *   - DEFAULT_LLM_MODEL
 *
 * Capabilities:
 *   - SSE streaming with per-chunk activity events for liveness
 *   - Function calling — discovers tools via the MCP-tool bridge,
 *     translates them to OpenAI's `tools: [{type: "function", ...}]` spec,
 *     drives the multi-turn tool-call loop (LLM → tool_calls → dispatch
 *     via MCP → inject as tool messages → re-stream → repeat until the
 *     LLM stops calling tools).
 *   - Multi-call dispatch: when a single response contains multiple
 *     parallel tool_calls, all are dispatched (sequentially for now);
 *     each result becomes a separate `tool` message.
 *
 * v1 limitations:
 *   - No transcript archiving (Claude provider has it; we don't)
 *   - Sequential tool dispatch (parallel could come later)
 */
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import type { BridgedTool, ToolBridge } from './mcp-tool-bridge.js';
import { createMcpToolBridge } from './mcp-tool-bridge.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface OpenAIStreamChunkChoice {
  delta?: {
    content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  choices?: OpenAIStreamChunkChoice[];
  error?: { message?: string };
}

const MAX_TOOL_LOOP_ITERATIONS = 10;

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nlIdx);
      buffer = buffer.slice(nlIdx + 1);
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      yield data;
    }
  }
  if (buffer.startsWith('data:')) {
    const data = buffer.slice(5).trim();
    if (data && data !== '[DONE]') yield data;
  }
}

/** Translate a BridgedTool into OpenAI's `tools[]` entry. */
function bridgedToOpenAI(t: BridgedTool): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  return {
    type: 'function',
    function: {
      name: t.qualifiedName,
      description: t.description,
      parameters: t.inputSchema,
    },
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  argsBuf: string;
}

interface StreamOutcome {
  /** Accumulated assistant text content for this turn (may be ''). */
  text: string;
  /** Tool calls the LLM wants dispatched, if any. */
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
}

class OpenAIQuery implements AgentQuery {
  private readonly _events: AsyncIterable<ProviderEvent>;
  private readonly userQueue: string[] = [];
  private done = false;
  private waiter: (() => void) | null = null;
  private aborted = false;
  private currentAbort: AbortController | null = null;

  constructor(
    input: QueryInput,
    baseUrl: string,
    apiKey: string,
    model: string,
    mcpServers: Record<string, McpServerConfig>,
  ) {
    const messages: ChatMessage[] = [];
    if (input.systemContext?.instructions) {
      messages.push({ role: 'system', content: input.systemContext.instructions });
    }
    this.userQueue.push(input.prompt);
    const self = this;

    /** One streaming completion call. Returns accumulated text + any tool_calls. */
    async function* streamOne(tools: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[]): AsyncGenerator<ProviderEvent, StreamOutcome> {
      const ac = new AbortController();
      self.currentAbort = ac;

      let resp: Response;
      try {
        resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, stream: true, ...(tools.length > 0 ? { tools } : {}) }),
          signal: ac.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: msg, retryable: true };
        self.currentAbort = null;
        return { text: '', toolCalls: [], finishReason: null };
      }

      if (!resp.ok) {
        const text = await resp.text();
        yield {
          type: 'error',
          message: `OpenAI-compat ${resp.status}: ${text.slice(0, 500)}`,
          retryable: resp.status >= 500 || resp.status === 429,
          classification: resp.status === 401 || resp.status === 403 ? 'auth' : `http-${resp.status}`,
        };
        self.currentAbort = null;
        return { text: '', toolCalls: [], finishReason: null };
      }
      if (!resp.body) {
        yield { type: 'error', message: 'OpenAI-compat: no response body', retryable: true };
        self.currentAbort = null;
        return { text: '', toolCalls: [], finishReason: null };
      }

      let accumulated = '';
      const pendingByIndex = new Map<number, PendingToolCall>();
      let finishReason: string | null = null;

      try {
        for await (const data of parseSSE(resp.body)) {
          if (self.aborted) {
            ac.abort();
            return { text: accumulated, toolCalls: [], finishReason: 'aborted' };
          }
          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(data) as OpenAIStreamChunk;
          } catch {
            continue;
          }
          if (chunk.error) {
            yield { type: 'error', message: chunk.error.message ?? 'stream error', retryable: false };
            self.currentAbort = null;
            return { text: accumulated, toolCalls: [], finishReason: 'error' };
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) {
            accumulated += delta.content;
            yield { type: 'activity' };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              const existing = pendingByIndex.get(idx) ?? { id: '', name: '', argsBuf: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.argsBuf += tc.function.arguments;
              pendingByIndex.set(idx, existing);
              yield { type: 'activity' };
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: `stream interrupted: ${msg}`, retryable: true };
        self.currentAbort = null;
        return { text: accumulated, toolCalls: [], finishReason: 'error' };
      }

      const toolCalls = Array.from(pendingByIndex.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: tc.argsBuf }));

      self.currentAbort = null;
      return { text: accumulated, toolCalls, finishReason };
    }

    /** Drive the tool-call loop within a single user push. */
    async function* runTurn(bridge: ToolBridge | null): AsyncGenerator<ProviderEvent> {
      const openAITools = bridge ? bridge.tools.map(bridgedToOpenAI) : [];

      for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
        yield { type: 'progress', message: `${model} → streaming…${iter > 0 ? ` (post-tool turn ${iter})` : ''}` };
        const outcome = yield* streamOne(openAITools);
        if (self.aborted) return;

        // Record the assistant turn (text and/or tool_calls — both are valid).
        if (outcome.text || outcome.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: outcome.text || null,
            tool_calls:
              outcome.toolCalls.length > 0
                ? outcome.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.name, arguments: tc.arguments },
                  }))
                : undefined,
          });
        }

        if (outcome.toolCalls.length === 0) {
          // No tools requested — terminal turn.
          yield { type: 'result', text: outcome.text || null };
          return;
        }

        // Dispatch each tool call, append the result as a `tool` message.
        for (const tc of outcome.toolCalls) {
          if (self.aborted) return;
          let resultText: string;
          try {
            const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
            resultText = await bridge!.dispatch(tc.name, args);
            yield { type: 'progress', message: `tool ${tc.name} → ok` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`tool ${tc.name} dispatch failed: ${msg}`);
            resultText = `[tool error] ${msg}`;
            yield { type: 'progress', message: `tool ${tc.name} → error` };
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
        }
        // Loop: re-stream with the tool results as new context.
      }
      // Tool loop hit the iteration cap — bail with whatever we have.
      yield { type: 'error', message: `tool-call loop exceeded ${MAX_TOOL_LOOP_ITERATIONS} iterations`, retryable: false };
    }

    this._events = (async function* generate(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: '' };

      // Bridge the MCP servers once per query (across all pushes).
      let bridge: ToolBridge | null = null;
      if (Object.keys(mcpServers).length > 0) {
        try {
          bridge = await createMcpToolBridge(mcpServers);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`mcp bridge init failed: ${msg} — proceeding without tools`);
        }
      }

      try {
        while (true) {
          while (self.userQueue.length > 0) {
            if (self.aborted) return;
            const userMsg = self.userQueue.shift()!;
            messages.push({ role: 'user', content: userMsg });
            for await (const ev of runTurn(bridge)) yield ev;
          }
          if (self.done) return;
          await new Promise<void>((r) => {
            self.waiter = r;
          });
        }
      } finally {
        if (bridge) await bridge.close().catch(() => {});
      }
    })();
  }

  push(message: string): void {
    this.userQueue.push(message);
    if (this.waiter) {
      this.waiter();
      this.waiter = null;
    }
  }

  end(): void {
    this.done = true;
    if (this.waiter) {
      this.waiter();
      this.waiter = null;
    }
  }

  abort(): void {
    this.aborted = true;
    if (this.currentAbort) this.currentAbort.abort();
    this.end();
  }

  get events(): AsyncIterable<ProviderEvent> {
    return this._events;
  }
}

class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly env: Record<string, string | undefined>;
  private readonly mcpServers: Record<string, McpServerConfig>;

  constructor(opts: ProviderOptions = {}) {
    this.env = opts.env ?? (process.env as Record<string, string | undefined>);
    this.mcpServers = opts.mcpServers ?? {};
  }

  query(input: QueryInput): AgentQuery {
    const baseUrl = (this.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/+$/, '');
    const apiKey = this.env.OPENAI_API_KEY;
    const model = this.env.DEFAULT_LLM_MODEL ?? 'gpt-4o';
    if (!apiKey) {
      throw new Error('[openai-provider] OPENAI_API_KEY env required');
    }
    log(`provider ready (model=${model}, baseUrl=${baseUrl}, mcpServers=${Object.keys(this.mcpServers).length})`);
    return new OpenAIQuery(input, baseUrl, apiKey, model, this.mcpServers);
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }
}

registerProvider('openai-compat', (opts) => new OpenAIProvider(opts));
