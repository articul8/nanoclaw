/**
 * OpenAI-compatible provider — streaming v1 adapter for the AgentMesh fork.
 *
 * Targets any LLM service exposing the OpenAI Chat Completions API:
 * OpenAI itself, Together, Fireworks, Groq, vLLM, Ollama (with OpenAI
 * compat layer), or self-hosted endpoints. Env:
 *
 *   - OPENAI_BASE_URL  (default https://api.openai.com)
 *   - OPENAI_API_KEY   (required; Bearer auth)
 *   - DEFAULT_LLM_MODEL (the model name passed in each request)
 *
 * Uses SSE streaming (`stream: true`) — yields an `activity` event per
 * delta chunk for liveness, accumulates text, emits a single `result`
 * event with the full text when the stream closes. Errors and parse
 * failures map to `error` events.
 *
 * v1 limitations:
 *   - No tool use / function calling
 *   - No MCP (server registrations are silently ignored)
 *   - No transcript archiving
 *
 * Streaming is in; the rest is a follow-up phase.
 */
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIDeltaChoice {
  delta?: { content?: string };
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  choices?: OpenAIDeltaChoice[];
  error?: { message?: string };
}

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

/**
 * Generic SSE parser for fetch streams. Yields raw `data:` payloads,
 * stripping the prefix and ignoring empty lines / comments. Handles
 * the `[DONE]` sentinel by returning. Buffer-aware so chunks split
 * mid-line are stitched correctly.
 */
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
  // Flush any trailing data line that didn't end in \n
  if (buffer.startsWith('data:')) {
    const data = buffer.slice(5).trim();
    if (data && data !== '[DONE]') yield data;
  }
}

class OpenAIQuery implements AgentQuery {
  private readonly _events: AsyncIterable<ProviderEvent>;
  private readonly userQueue: string[] = [];
  private done = false;
  private waiter: (() => void) | null = null;
  private aborted = false;
  private currentAbort: AbortController | null = null;

  constructor(input: QueryInput, baseUrl: string, apiKey: string, model: string) {
    const messages: ChatMessage[] = [];
    if (input.systemContext?.instructions) {
      messages.push({ role: 'system', content: input.systemContext.instructions });
    }
    this.userQueue.push(input.prompt);

    const self = this;

    async function* streamCompletion(): AsyncGenerator<ProviderEvent> {
      const ac = new AbortController();
      self.currentAbort = ac;
      let resp: Response;
      try {
        resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages, stream: true }),
          signal: ac.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: msg, retryable: true };
        self.currentAbort = null;
        return;
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
        return;
      }
      if (!resp.body) {
        yield { type: 'error', message: 'OpenAI-compat: no response body', retryable: true };
        self.currentAbort = null;
        return;
      }

      let accumulated = '';
      try {
        for await (const data of parseSSE(resp.body)) {
          if (self.aborted) {
            ac.abort();
            return;
          }
          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(data) as OpenAIStreamChunk;
          } catch {
            // Tolerate malformed chunks; some compat servers emit keepalives.
            continue;
          }
          if (chunk.error) {
            yield { type: 'error', message: chunk.error.message ?? 'stream error', retryable: false };
            self.currentAbort = null;
            return;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            accumulated += delta;
            // Liveness: tell the host the stream is making progress.
            yield { type: 'activity' };
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: `stream interrupted: ${msg}`, retryable: true };
        self.currentAbort = null;
        return;
      }

      messages.push({ role: 'assistant', content: accumulated });
      yield { type: 'result', text: accumulated || null };
      self.currentAbort = null;
    }

    this._events = (async function* generate(): AsyncGenerator<ProviderEvent> {
      // Each completion is stateless — no continuation token to expose.
      yield { type: 'init', continuation: '' };

      while (true) {
        while (self.userQueue.length > 0) {
          if (self.aborted) return;
          const userMsg = self.userQueue.shift()!;
          messages.push({ role: 'user', content: userMsg });
          yield { type: 'progress', message: `${model} → streaming…` };
          for await (const ev of streamCompletion()) yield ev;
        }
        if (self.done) return;
        await new Promise<void>((r) => {
          self.waiter = r;
        });
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
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
    this.end();
  }

  get events(): AsyncIterable<ProviderEvent> {
    return this._events;
  }
}

class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly env: Record<string, string | undefined>;

  constructor(opts: ProviderOptions = {}) {
    this.env = opts.env ?? (process.env as Record<string, string | undefined>);
  }

  query(input: QueryInput): AgentQuery {
    const baseUrl = (this.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/+$/, '');
    const apiKey = this.env.OPENAI_API_KEY;
    const model = this.env.DEFAULT_LLM_MODEL ?? 'gpt-4o';
    if (!apiKey) {
      throw new Error('[openai-provider] OPENAI_API_KEY env required');
    }
    log(`provider ready (model=${model}, baseUrl=${baseUrl})`);
    return new OpenAIQuery(input, baseUrl, apiKey, model);
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }
}

registerProvider('openai-compat', (opts) => new OpenAIProvider(opts));
