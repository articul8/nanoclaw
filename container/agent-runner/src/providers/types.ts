export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

/**
 * MCP server config — discriminated union over the three transports
 * the Claude Agent SDK supports.
 *
 *   - stdio: local subprocess; the SDK spawns it
 *   - http: remote HTTP endpoint with optional bearer / custom headers
 *   - sse:  remote Server-Sent Events endpoint with optional headers
 *
 * Hosted MCP servers (Notion, GitHub MCP, Linear MCP, Asana, Atlassian,
 * Drive, Dropbox) are reachable via `type: 'http'` without any local
 * server. Wire them by appending an entry to container.json's
 * `mcpServers` map; the agent-runner passes the config through to
 * sdkQuery() unchanged.
 *
 * `type` is optional on the stdio form for backward compatibility with
 * existing container.json files written before the union was widened.
 * Default is `stdio` when `type` is missing AND `command` is set.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSSEServerConfig;

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  /** Bearer tokens, custom auth headers, etc. Populated at spawn time from credential vault. */
  headers?: Record<string, string>;
}

export interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
