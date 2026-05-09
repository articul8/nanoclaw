/**
 * Google Gemini provider — streaming v1 adapter for the AgentMesh fork.
 *
 * Targets the Generative Language API (Gemini). Env:
 *   - GOOGLE_GENAI_BASE_URL  (default https://generativelanguage.googleapis.com)
 *   - GOOGLE_API_KEY         (required; passed via x-goog-api-key header)
 *   - DEFAULT_LLM_MODEL      (e.g. gemini-2.5-flash, gemini-2.0-flash-exp)
 *
 * Uses SSE streaming via the `:streamGenerateContent?alt=sse` endpoint —
 * yields an `activity` event per delta chunk for liveness, accumulates
 * text, emits a single `result` event when the stream closes. Errors
 * and prompt-blocks map to `error` events.
 *
 * v1 limitations (matches the openai-compat provider):
 *   - No tool use / function calling
 *   - No MCP (server registrations are silently ignored)
 *   - No transcript archiving
 *
 * Streaming is in; the rest is a follow-up phase.
 */
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

interface GeminiContent {
  /** Gemini uses 'user' and 'model' (not 'assistant'). */
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface GenerateContentChunk {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

function log(msg: string): void {
  console.error(`[google-provider] ${msg}`);
}

/** Generic SSE parser. See openai.ts for the equivalent — kept here to avoid a shared util. */
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

class GoogleQuery implements AgentQuery {
  private readonly _events: AsyncIterable<ProviderEvent>;
  private readonly userQueue: string[] = [];
  private done = false;
  private waiter: (() => void) | null = null;
  private aborted = false;
  private currentAbort: AbortController | null = null;

  constructor(input: QueryInput, baseUrl: string, apiKey: string, model: string) {
    const contents: GeminiContent[] = [];
    const systemInstruction = input.systemContext?.instructions
      ? { parts: [{ text: input.systemContext.instructions }] }
      : undefined;
    this.userQueue.push(input.prompt);

    const self = this;

    async function* streamGenerate(): AsyncGenerator<ProviderEvent> {
      const ac = new AbortController();
      self.currentAbort = ac;
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body.systemInstruction = systemInstruction;

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
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
          message: `Gemini ${resp.status}: ${text.slice(0, 500)}`,
          retryable: resp.status >= 500 || resp.status === 429,
          classification: resp.status === 401 || resp.status === 403 ? 'auth' : `http-${resp.status}`,
        };
        self.currentAbort = null;
        return;
      }
      if (!resp.body) {
        yield { type: 'error', message: 'Gemini: no response body', retryable: true };
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
          let chunk: GenerateContentChunk;
          try {
            chunk = JSON.parse(data) as GenerateContentChunk;
          } catch {
            continue;
          }
          if (chunk.error) {
            yield { type: 'error', message: chunk.error.message ?? 'stream error', retryable: false };
            self.currentAbort = null;
            return;
          }
          if (chunk.promptFeedback?.blockReason) {
            yield {
              type: 'error',
              message: `Gemini blocked: ${chunk.promptFeedback.blockReason}`,
              retryable: false,
              classification: 'safety-block',
            };
            self.currentAbort = null;
            return;
          }
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const p of parts) {
            if (p.text) {
              accumulated += p.text;
              yield { type: 'activity' };
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: `stream interrupted: ${msg}`, retryable: true };
        self.currentAbort = null;
        return;
      }

      contents.push({ role: 'model', parts: [{ text: accumulated }] });
      yield { type: 'result', text: accumulated || null };
      self.currentAbort = null;
    }

    this._events = (async function* generate(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: '' };

      while (true) {
        while (self.userQueue.length > 0) {
          if (self.aborted) return;
          const userMsg = self.userQueue.shift()!;
          contents.push({ role: 'user', parts: [{ text: userMsg }] });
          yield { type: 'progress', message: `${model} → streaming…` };
          for await (const ev of streamGenerate()) yield ev;
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

  constructor(opts: ProviderOptions = {}) {
    this.env = opts.env ?? (process.env as Record<string, string | undefined>);
  }

  query(input: QueryInput): AgentQuery {
    const baseUrl = (this.env.GOOGLE_GENAI_BASE_URL ?? 'https://generativelanguage.googleapis.com').replace(
      /\/+$/,
      '',
    );
    const apiKey = this.env.GOOGLE_API_KEY;
    const model = this.env.DEFAULT_LLM_MODEL ?? 'gemini-2.5-flash';
    if (!apiKey) {
      throw new Error('[google-provider] GOOGLE_API_KEY env required');
    }
    log(`provider ready (model=${model}, baseUrl=${baseUrl})`);
    return new GoogleQuery(input, baseUrl, apiKey, model);
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }
}

registerProvider('google', (opts) => new GoogleProvider(opts));
