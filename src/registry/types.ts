/**
 * Shared types for the a8-claw extension registry.
 *
 * The runtime ships a curated manifest at registry/manifest.json (loaded
 * by registry/loader.ts) declaring every channel, hosted MCP, local
 * MCP, tool family, and runtime peer the agent can wire on request.
 * Each entry carries a three-axis default approval policy (install,
 * invoke, scope) per the approval-policy memory.
 *
 * The same types are used host-side (./a8-claw add CLI, the registry
 * browser) and container-side (agent's add_mcp_server + list_extensions
 * MCP tools, the approval middleware).
 *
 * See registry/manifest.schema.json for the source-of-truth JSON Schema.
 */

export type EntryType = 'channel' | 'mcp_http' | 'mcp_sse' | 'mcp_stdio' | 'tool_family' | 'runtime_peer';

export type InstallGate = 'auto' | 'admin' | 'compliance' | 'deny';
export type InvokeGate = 'auto' | 'per_session' | 'per_call';
export type Sensitivity = 'read_only' | 'read_write' | 'destructive';
export type AuditLevel = 'standard' | 'enhanced';

export interface InvokePolicy {
  default: InvokeGate;
  /** Per-operation override; key is the MCP tool name. */
  scoped?: Record<string, InvokeGate>;
  /** v2: cost-gating threshold; not enforced in v1. */
  cost_gated_above_cents?: number;
}

export interface ScopePolicy {
  sensitivity?: Sensitivity;
  /** v3: resource whitelist (e.g. specific Notion workspaces). */
  allowed_resources?: string[];
  /** v3: resource blacklist. */
  denied_resources?: string[];
}

export interface ExpiresPolicy {
  session_seconds?: number;
  absolute_seconds?: number;
}

export interface ApprovalPolicy {
  install: InstallGate;
  invoke: InvokePolicy;
  scope?: ScopePolicy;
  expires?: ExpiresPolicy;
  audit_level?: AuditLevel;
}

export interface AuthInfo {
  kind: 'oauth2' | 'bot_token' | 'api_token' | 'github_app' | 'platform' | 'none';
  provider?: string;
  scopes?: string[];
  setup_url?: string;
  notes?: string;
}

/** Install instructions — type-discriminated below in {@link InstallInfo}. */
export type InstallInfo =
  | InstallChannel
  | InstallMcpHttp
  | InstallMcpSse
  | InstallMcpStdio
  | InstallToolFamily
  | InstallRuntimePeer;

export interface InstallChannel {
  /** Branch on the upstream nanoclaw remote that holds the adapter source. */
  adapter_branch: string;
  adapter_path: string;
  package: string;
  barrel_import: string;
}

export interface InstallMcpHttp {
  url: string;
  /**
   * Header template. Values may reference credentials via `${ENV_VAR}` —
   * the installer substitutes from credentials_env at wire time.
   */
  headers_from_credentials?: Record<string, string>;
  static_headers?: Record<string, string>;
}

export interface InstallMcpSse {
  url: string;
  headers_from_credentials?: Record<string, string>;
  static_headers?: Record<string, string>;
}

export interface InstallMcpStdio {
  command: string;
  args?: string[];
  env_from_credentials?: Record<string, string>;
}

export interface InstallToolFamily {
  /** Tool Manager family name; null when these are SDK-native tools. */
  tool_manager_family?: string | null;
  native?: boolean;
  tools?: string[];
}

export interface InstallRuntimePeer {
  runtime_id: string;
  /** Which dispatcher emits the agent_execute envelope. */
  dispatch_via: 'mission_engine' | 'channel';
}

export interface RegistryEntry {
  id: string;
  type: EntryType;
  name: string;
  category: string;
  description: string;
  tags?: string[];
  install: InstallInfo;
  credentials_env?: string[];
  auth?: AuthInfo;
  default_policy: ApprovalPolicy;
}

export interface RegistryManifest {
  version: string;
  updated_at?: string;
  entries: RegistryEntry[];
}
