/**
 * Google Gemini provider — streaming + function-calling adapter.
 *
 * Targets the Generative Language API. Env:
 *   - GOOGLE_GENAI_BASE_URL  (default https://generativelanguage.googleapis.com)
 *   - GOOGLE_API_KEY         (x-goog-api-key header)
 *   - DEFAULT_LLM_MODEL      (e.g. gemini-2.5-flash, gemini-2.0-flash-exp)
 *
 * Capabilities (full parity with the Claude provider for chat + tools):
 *   - SSE streaming (`:streamGenerateContent?alt=sse`) with per-chunk
 *     activity events.
 *   - Function calling — discovers tools via the MCP-tool bridge,
 *     translates them to Gemini's `tools: [{functionDeclarations: [...]}]`
 *     spec, drives the multi-turn tool-call loop. Tool results go back
 *     as `{role: 'user', parts: [{functionResponse: {...}}]}` content.
 *   - Parallel tool dispatch via Promise.all; functionResponse parts
 *     batched into a single user turn.
 *   - Conversation transcript archived after every turn to
 *     /workspace/agent/conversations/<date>-<slug>.md.
 */
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import type { BridgedTool, ToolBridge } from './mcp-tool-bridge.js';
import { createMcpToolBridge } from './mcp-tool-bridge.js';
import type { FlatMessage } from './transcript-archive.js';
import { TranscriptArchiver } from './transcript-archive.js';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  /** Gemini uses 'user' and 'model' (not 'assistant'). */
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GenerateContentChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

const MAX_TOOL_LOOP_ITERATIONS = 10;

function log(msg: string): void {
  console.error(`[google-provider] ${msg}`);
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
      if (!data || data === '[DONE]') continue;
      yield data;
    }
  }
  if (buffer.startsWith('data:')) {
    const data = buffer.slice(5).trim();
    if (data && data !== '[DONE]') yield data;
  }
}

/** Translate a BridgedTool into a Gemini functionDeclaration. */
function bridgedToGemini(t: BridgedTool): { name: string; description: string; parameters: Record<string, unknown> } {
  return {
    name: t.qualifiedName,
    description: t.description,
    parameters: t.inputSchema,
  };
}

interface StreamOutcome {
  text: string;
  /** Function calls the LLM wants dispatched. */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  finishReason: string | null;
}

class GoogleQuery implements AgentQuery {
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
    assistantName: string | undefined,
  ) {
    const contents: GeminiContent[] = [];
    const systemInstruction = input.systemContext?.instructions
      ? { parts: [{ text: input.systemContext.instructions }] }
      : undefined;
    this.userQueue.push(input.prompt);
    const archiver = new TranscriptArchiver({ initialUserMessage: input.prompt, assistantName });
    const self = this;

    /** Convert Gemini contents into the flat archive format. */
    function flatten(): FlatMessage[] {
      const out: FlatMessage[] = [];
      for (const c of contents) {
        const text = c.parts
          .map((p) => p.text ?? '')
          .filter(Boolean)
          .join('');
        if (!text) continue; // skip turns that are pure functionCall / functionResponse
        if (c.role === 'user') out.push({ role: 'user', content: text });
        else if (c.role === 'model') out.push({ role: 'assistant', content: text });
      }
      return out;
    }

    async function* streamOne(toolDecls: { name: string; description: string; parameters: Record<string, unknown> }[]): AsyncGenerator<ProviderEvent, StreamOutcome> {
      const ac = new AbortController();
      self.currentAbort = ac;

      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (toolDecls.length > 0) body.tools = [{ functionDeclarations: toolDecls }];

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
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
          message: `Gemini ${resp.status}: ${text.slice(0, 500)}`,
          retryable: resp.status >= 500 || resp.status === 429,
          classification: resp.status === 401 || resp.status === 403 ? 'auth' : `http-${resp.status}`,
        };
        self.currentAbort = null;
        return { text: '', toolCalls: [], finishReason: null };
      }
      if (!resp.body) {
        yield { type: 'error', message: 'Gemini: no response body', retryable: true };
        self.currentAbort = null;
        return { text: '', toolCalls: [], finishReason: null };
      }

      let accumulated = '';
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      let finishReason: string | null = null;

      try {
        for await (const data of parseSSE(resp.body)) {
          if (self.aborted) {
            ac.abort();
            return { text: accumulated, toolCalls: [], finishReason: 'aborted' };
          }
          let chunk: GenerateContentChunk;
          try {
            chunk = JSON.parse(data) as GenerateContentChunk;
          } catch {
            continue;
          }
          if (chunk.error) {
            yield { type: 'error', message: chunk.error.message ?? 'stream error', retryable: false };
            self.currentAbort = null;
            return { text: accumulated, toolCalls: [], finishReason: 'error' };
          }
          if (chunk.promptFeedback?.blockReason) {
            yield {
              type: 'error',
              message: `Gemini blocked: ${chunk.promptFeedback.blockReason}`,
              retryable: false,
              classification: 'safety-block',
            };
            self.currentAbort = null;
            return { text: accumulated, toolCalls: [], finishReason: 'safety-block' };
          }
          const cand = chunk.candidates?.[0];
          const parts = cand?.content?.parts ?? [];
          for (const p of parts) {
            if (p.text) {
              accumulated += p.text;
              yield { type: 'activity' };
            }
            if (p.functionCall) {
              toolCalls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {} });
              yield { type: 'activity' };
            }
          }
          if (cand?.finishReason) finishReason = cand.finishReason;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: `stream interrupted: ${msg}`, retryable: true };
        self.currentAbort = null;
        return { text: accumulated, toolCalls: [], finishReason: 'error' };
      }

      self.currentAbort = null;
      return { text: accumulated, toolCalls, finishReason };
    }

    async function* runTurn(bridge: ToolBridge | null): AsyncGenerator<ProviderEvent> {
      const toolDecls = bridge ? bridge.tools.map(bridgedToGemini) : [];

      for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
        yield { type: 'progress', message: `${model} → streaming…${iter > 0 ? ` (post-tool turn ${iter})` : ''}` };
        const outcome = yield* streamOne(toolDecls);
        if (self.aborted) return;

        // Record the model turn — text and/or functionCall parts are both valid.
        const modelParts: GeminiPart[] = [];
        if (outcome.text) modelParts.push({ text: outcome.text });
        for (const tc of outcome.toolCalls) {
          modelParts.push({ functionCall: { name: tc.name, args: tc.args } });
        }
        if (modelParts.length > 0) {
          contents.push({ role: 'model', parts: modelParts });
        }

        if (outcome.toolCalls.length === 0) {
          // Terminal turn — archive the conversation.
          archiver.write(flatten());
          yield { type: 'result', text: outcome.text || null };
          return;
        }

        // Dispatch all tool calls in parallel via Promise.all; emit
        // progress events in original order after they complete; append
        // a single user turn carrying all functionResponse parts.
        const dispatched = await Promise.all(
          outcome.toolCalls.map(async (tc) => {
            if (self.aborted) {
              return { tc, resultObj: { error: 'aborted' } as Record<string, unknown>, errored: true };
            }
            try {
              const text = await bridge!.dispatch(tc.name, tc.args);
              return { tc, resultObj: { result: text } as Record<string, unknown>, errored: false };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log(`tool ${tc.name} dispatch failed: ${msg}`);
              return { tc, resultObj: { error: msg } as Record<string, unknown>, errored: true };
            }
          }),
        );
        const responseParts: GeminiPart[] = [];
        for (const { tc, resultObj, errored } of dispatched) {
          yield { type: 'progress', message: `tool ${tc.name} → ${errored ? 'error' : 'ok'}` };
          responseParts.push({ functionResponse: { name: tc.name, response: resultObj } });
        }
        contents.push({ role: 'user', parts: responseParts });
        // Loop: re-stream with the function results as new context.
      }
      yield { type: 'error', message: `tool-call loop exceeded ${MAX_TOOL_LOOP_ITERATIONS} iterations`, retryable: false };
    }

    this._events = (async function* generate(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: '' };

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
            contents.push({ role: 'user', parts: [{ text: userMsg }] });
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

class GoogleProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly env: Record<string, string | undefined>;
  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly assistantName: string | undefined;

  constructor(opts: ProviderOptions = {}) {
    this.env = opts.env ?? (process.env as Record<string, string | undefined>);
    this.mcpServers = opts.mcpServers ?? {};
    this.assistantName = opts.assistantName;
  }

  query(input: QueryInput): AgentQuery {
    const baseUrl = (this.env.GOOGLE_GENAI_BASE_URL ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const apiKey = this.env.GOOGLE_API_KEY;
    const model = this.env.DEFAULT_LLM_MODEL ?? 'gemini-2.5-flash';
    if (!apiKey) {
      throw new Error('[google-provider] GOOGLE_API_KEY env required');
    }
    log(`provider ready (model=${model}, baseUrl=${baseUrl}, mcpServers=${Object.keys(this.mcpServers).length})`);
    return new GoogleQuery(input, baseUrl, apiKey, model, this.mcpServers, this.assistantName);
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }
}

registerProvider('google', (opts) => new GoogleProvider(opts));
