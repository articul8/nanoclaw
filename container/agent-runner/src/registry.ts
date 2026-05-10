/**
 * Container-side registry loader.
 *
 * The host mounts repo-root/registry/ at /app/registry/ readonly (see
 * src/container-runner.ts). This module reads manifest.json from that
 * path and exposes the same lookup helpers as the host's loader, so
 * the agent's add_mcp_server / list_extensions / request_extension
 * tools (and the approval middleware) can hit the same source of truth.
 *
 * Types are duplicated here rather than imported from the host package
 * because the container is a separate runtime (bun + tsconfig) and
 * can't import across the bind-mount boundary. The risk of drift is
 * low because both files render the JSON Schema in registry/
 * manifest.schema.json — keep them in sync when the schema changes.
 */
import fs from 'fs';

const MANIFEST_PATH = '/app/registry/manifest.json';

export type EntryType = 'channel' | 'mcp_http' | 'mcp_sse' | 'mcp_stdio' | 'tool_family' | 'runtime_peer';
export type InstallGate = 'auto' | 'admin' | 'compliance' | 'deny';
export type InvokeGate = 'auto' | 'per_session' | 'per_call';
export type Sensitivity = 'read_only' | 'read_write' | 'destructive';

export interface InvokePolicy {
  default: InvokeGate;
  scoped?: Record<string, InvokeGate>;
  cost_gated_above_cents?: number;
}

export interface ApprovalPolicy {
  install: InstallGate;
  invoke: InvokePolicy;
  scope?: { sensitivity?: Sensitivity; allowed_resources?: string[]; denied_resources?: string[] };
  expires?: { session_seconds?: number; absolute_seconds?: number };
  audit_level?: 'standard' | 'enhanced';
}

export interface RegistryEntry {
  id: string;
  type: EntryType;
  name: string;
  category: string;
  description: string;
  tags?: string[];
  install: Record<string, unknown>;
  credentials_env?: string[];
  auth?: Record<string, unknown>;
  default_policy: ApprovalPolicy;
}

export interface RegistryManifest {
  version: string;
  updated_at?: string;
  entries: RegistryEntry[];
}

let _cached: RegistryManifest | null = null;

export function loadRegistry(): RegistryManifest | null {
  if (_cached) return _cached;
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    _cached = JSON.parse(raw) as RegistryManifest;
    return _cached;
  } catch {
    // Manifest not mounted (e.g. running against an old host without
    // the registry mount, or local-dev outside docker). Return null;
    // callers fall back to "no registry available" semantics.
    return null;
  }
}

export function findEntry(id: string): RegistryEntry | undefined {
  const m = loadRegistry();
  if (!m) return undefined;
  return m.entries.find((e) => e.id === id);
}

export function findByName(query: string): RegistryEntry[] {
  const m = loadRegistry();
  if (!m) return [];
  const q = query.toLowerCase();
  return m.entries.filter(
    (e) => e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
  );
}

export function allEntries(): RegistryEntry[] {
  return loadRegistry()?.entries ?? [];
}

/**
 * Resolve the invocation gate for a specific tool call.
 *
 * @param entry — the registry entry whose policy we're consulting
 * @param toolName — the bare MCP tool name (e.g. 'notion_delete_page')
 *
 * Returns 'auto' / 'per_session' / 'per_call'. Scoped overrides take
 * precedence over default; if no entry / no policy is found, callers
 * default to 'auto' since policy absence means no opinion (not "deny").
 */
export function resolveInvokeGate(entry: RegistryEntry | undefined, toolName: string): InvokeGate {
  if (!entry) return 'auto';
  const p = entry.default_policy.invoke;
  return p.scoped?.[toolName] ?? p.default;
}
