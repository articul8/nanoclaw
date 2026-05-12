/**
 * Warp queue HTTP client — low-level poll + publish.
 *
 * Mirrors a8-code/src/warp-client.ts:36-91 — uses Warp's HTTP queue API
 * (GET /queues/{name}/messages, POST /queues/{name}/messages) so the
 * runtime doesn't carry a direct AMQP client. The platform team owns
 * the queue infrastructure; runtimes are just clients of the HTTP
 * facade.
 *
 * System credentials (X-Tenant-ID: system / X-User-ID: system) on the
 * queue infra calls themselves — the queue PAYLOAD carries the real
 * per-mission tenant/user. This matches the a8-code pattern and the
 * RUNTIME_CONTRACT §6 invariant: tenant identity scopes the WORK, not
 * the queue plumbing.
 *
 * NOT routed through Platform MCP — this is runtime infra, not an
 * agent-facing tool. See feedback_runtime_infra_vs_agent_tool.
 */

function log(msg: string): void {
  console.error(`[warp-queue] ${msg}`);
}

export interface WarpQueueClientOptions {
  baseUrl: string;
  /**
   * Tenant id used on the queue HTTP calls themselves (NOT the payload's
   * mission tenant). Defaults to "system" — queue ops are system-scoped
   * because the queue infra is shared cross-tenant. The actual mission
   * tenant rides inside the envelope.
   */
  systemTenantId?: string;
  systemUserId?: string;
  /** Override for testing — swap in a stubbed fetch. */
  fetchImpl?: typeof fetch;
}

export interface PollOptions {
  /** Max messages to return per poll. Default 1 (one-at-a-time processing). */
  maxMessages?: number;
  /** Long-poll timeout in seconds. Default 1.0. */
  timeoutSeconds?: number;
}

/**
 * Loose envelope. Warp's exact wrapper shape has evolved (sometimes
 * `{messages: [...]}`, sometimes `{message: {payload: {body: ...}}}`,
 * sometimes a bare array) — the client normalizes to a flat array of
 * payload bodies. Callers parse the body shape themselves.
 */
export type QueueMessage = Record<string, unknown>;

export interface PublishOptions {
  /** Queue priority 0-9; default 5 (a8-code uses this default too). */
  priority?: number;
}

export class WarpQueueClient {
  private baseUrl: string;
  private systemTenantId: string;
  private systemUserId: string;
  private fetchImpl: typeof fetch;

  constructor(opts: WarpQueueClientOptions) {
    if (!opts.baseUrl) {
      throw new Error('WarpQueueClient: baseUrl is required');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.systemTenantId = opts.systemTenantId ?? 'system';
    this.systemUserId = opts.systemUserId ?? 'system';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'X-Tenant-ID': this.systemTenantId,
      'X-User-ID': this.systemUserId,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Poll a queue for messages. Returns a flat array of payload bodies —
   * caller doesn't need to know about Warp's response envelope variants.
   *
   * Never throws. On error returns []. Pollers run in a tight loop; an
   * intermittent 5xx must not crash the loop, just yield zero results
   * and try again on next tick.
   */
  async pollMessages(queueName: string, opts: PollOptions = {}): Promise<QueueMessage[]> {
    const maxMessages = opts.maxMessages ?? 1;
    const timeoutSeconds = opts.timeoutSeconds ?? 1.0;
    const url =
      `${this.baseUrl}/queues/${encodeURIComponent(queueName)}/messages` +
      `?max_messages=${maxMessages}&timeout=${timeoutSeconds}`;
    try {
      const resp = await this.fetchImpl(url, { headers: this.headers() });
      // 204 No Content = empty queue, normal long-poll timeout result.
      if (resp.status === 204) return [];
      if (!resp.ok) {
        log(`poll ${queueName} HTTP ${resp.status}: ${resp.statusText}`);
        return [];
      }
      const data = (await resp.json().catch(() => null)) as unknown;
      return normalizeMessages(data);
    } catch (err) {
      log(`poll ${queueName} error: ${(err as Error).message ?? err}`);
      return [];
    }
  }

  /**
   * Publish one message body to a queue. Returns whether the publish
   * succeeded (2xx). Caller decides what to do on failure — usually log +
   * surface to the caller; the queue is at-least-once so retries are
   * acceptable but may produce duplicates.
   */
  async publish(queueName: string, body: unknown, opts: PublishOptions = {}): Promise<boolean> {
    const url = `${this.baseUrl}/queues/${encodeURIComponent(queueName)}/messages`;
    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ body, priority: opts.priority ?? 5 }),
      });
      if (!resp.ok) {
        log(`publish ${queueName} HTTP ${resp.status}: ${resp.statusText}`);
        return false;
      }
      return true;
    } catch (err) {
      log(`publish ${queueName} error: ${(err as Error).message ?? err}`);
      return false;
    }
  }
}

/**
 * Normalize Warp's queue response envelope variants to a flat array of
 * payload bodies. Three shapes seen in the wild (per a8-code/warp-client.ts):
 *   - { messages: [body, ...] }
 *   - { message: { payload: { body: <one> } } }   (single-message variant)
 *   - bare array [body, ...]
 * Anything else returns [] (defensive).
 */
export function normalizeMessages(data: unknown): QueueMessage[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data as QueueMessage[];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.messages)) return obj.messages as QueueMessage[];
  const single = obj.message as Record<string, unknown> | undefined;
  const body = (single?.payload as Record<string, unknown> | undefined)?.body;
  if (body) return [body as QueueMessage];
  return [];
}
