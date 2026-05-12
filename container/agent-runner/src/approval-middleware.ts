/**
 * Approval middleware — three-axis policy gate for tool invocations.
 *
 * Per a8-claw-approval-policy memory + ADR-a7c91e3f:
 *
 *   INSTALL  — auto / admin / compliance / deny   (when an extension is
 *              registered; enforced by the host-side registry, not here)
 *   INVOKE   — auto / per_session / per_call      (per-call gating on
 *              each tool invocation; THIS module enforces it)
 *   SCOPE    — sensitivity + resource ACLs        (out of v1 scope)
 *
 * The catalog (platform-mcp/catalog/platform-tool-catalog.json) declares
 * the per-op default invoke policy. Tenant admins override via tenant
 * overlay (also out of v1). Per-call gates surface as conversational
 * approval requests to the user via the existing ask_user_question
 * channel (handled in agent-runner's outbox).
 *
 * v1 enforcement surface:
 *   - shouldApprove(toolName)  → decision (allow / ask / deny)
 *   - recordApproval(toolName, granted)  → cache for per_session
 *   - reset()                  → forget cached approvals (testing / new session)
 *
 * Real wiring to the Claude SDK's PreToolUse hook is a follow-up
 * commit; this module isolates the policy logic so the SDK shim can
 * call it and unit tests can verify gating without the SDK in scope.
 */

export type InvokeGate = 'auto' | 'per_session' | 'per_call' | 'deny';

export type ApprovalDecision =
  /** Tool runs without prompting. */
  | { decision: 'allow' }
  /** Caller must surface an approval request to the user. */
  | { decision: 'ask'; gate: 'per_session' | 'per_call'; reason: string }
  /** Tool is hard-denied regardless of user response. */
  | { decision: 'deny'; reason: string };

interface ToolPolicy {
  invoke: InvokeGate;
  /** Per-op override of category, used for human-friendly reason strings. */
  category?: string;
  sensitivity?: string;
}

/**
 * Read-only snapshot of the catalog's invoke policies. Keyed by
 * tool_name (the LLM-visible name, e.g. "prompt_hub_upsert_skill" or
 * "mcp__articul8__prompt_hub_upsert_skill"). Both forms are accepted —
 * see resolveTool() for the lookup logic.
 */
export interface PolicyTable {
  tools: Record<string, ToolPolicy>;
  /** Default for tools NOT in the table. v1 = 'auto' for backward compat. */
  default_invoke: InvokeGate;
}

/**
 * Cached per-session decisions. Keys are tool_names that have been
 * approved-once (per_session). Resets when the session ends or when
 * .reset() is called.
 */
const _sessionGrants = new Set<string>();
let _table: PolicyTable | null = null;

/** Inject the policy table (called once at runner boot, after catalog load). */
export function setPolicyTable(table: PolicyTable): void {
  _table = table;
}

/** Get the current policy table — exposed for tests + diagnostics. */
export function getPolicyTable(): PolicyTable | null {
  return _table;
}

/** Reset per-session grant cache. Called at session end or in tests. */
export function reset(): void {
  _sessionGrants.clear();
}

/**
 * Look up the gating decision for one tool invocation. Pure function
 * over the loaded policy table + the session grant cache; doesn't
 * surface UI / wait on input. Caller (the SDK PreToolUse shim) handles
 * the actual approval round-trip when decision='ask'.
 */
export function shouldApprove(toolName: string): ApprovalDecision {
  const policy = resolveTool(toolName);

  // No table loaded → default-allow. The catalog ships with the image;
  // if it's missing the runtime has bigger problems than approval.
  if (!_table) return { decision: 'allow' };

  if (policy.invoke === 'deny') {
    return {
      decision: 'deny',
      reason: `Tool ${toolName} is hard-denied in the active policy.`,
    };
  }

  if (policy.invoke === 'per_call') {
    return {
      decision: 'ask',
      gate: 'per_call',
      reason: humanReason(toolName, policy, 'per_call'),
    };
  }

  if (policy.invoke === 'per_session') {
    if (_sessionGrants.has(toolName)) {
      return { decision: 'allow' };
    }
    return {
      decision: 'ask',
      gate: 'per_session',
      reason: humanReason(toolName, policy, 'per_session'),
    };
  }

  // 'auto' (the default for read-only ops in v1)
  return { decision: 'allow' };
}

/**
 * Record the outcome of an ask-prompt. For per_session grants, caches
 * the allow so we don't re-prompt. Deny is NOT cached (the user might
 * change their mind next call); only allow.
 */
export function recordApproval(toolName: string, granted: boolean, gate: 'per_session' | 'per_call'): void {
  if (granted && gate === 'per_session') {
    _sessionGrants.add(toolName);
  }
}

/** For tests + debug — surface the cache contents. */
export function _sessionGrantsSnapshot(): string[] {
  return Array.from(_sessionGrants).sort();
}

// ── internals ─────────────────────────────────────────────────────────

function resolveTool(toolName: string): ToolPolicy {
  if (!_table) return { invoke: 'auto' };
  // Accept either the bare tool_name ("prompt_hub_upsert_skill") or
  // the MCP-prefixed form ("mcp__articul8__prompt_hub_upsert_skill")
  // the Claude SDK presents at the call site.
  const direct = _table.tools[toolName];
  if (direct) return direct;
  // Strip MCP prefix if present.
  const m = toolName.match(/^mcp__[^_]+__(.+)$/);
  if (m && _table.tools[m[1]]) return _table.tools[m[1]];
  // Strip "mcp__" prefix without server name (some SDKs flatten).
  const m2 = toolName.match(/^mcp__(.+)$/);
  if (m2 && _table.tools[m2[1]]) return _table.tools[m2[1]];
  return { invoke: _table.default_invoke };
}

function humanReason(toolName: string, policy: ToolPolicy, gate: 'per_session' | 'per_call'): string {
  const base = gate === 'per_call' ? 'requires per-call approval' : 'requires session-level approval';
  const cat = policy.category ? ` (${policy.category})` : '';
  const sens = policy.sensitivity ? ` [${policy.sensitivity}]` : '';
  return `Tool ${toolName}${cat}${sens} ${base}.`;
}

/**
 * Convenience loader — given a parsed catalog JSON (the shape exported
 * by platform-mcp/catalog), build the PolicyTable. Allows the agent-
 * runner to wire policy without manually walking the services tree.
 */
export interface CatalogShape {
  services: Array<{
    operations: Array<{
      tool_name: string;
      policy?: { invoke?: InvokeGate };
      category?: string;
      sensitivity?: string;
    }>;
  }>;
}

export function buildPolicyTableFromCatalog(catalog: CatalogShape, defaultInvoke: InvokeGate = 'auto'): PolicyTable {
  const tools: Record<string, ToolPolicy> = {};
  for (const svc of catalog.services) {
    for (const op of svc.operations) {
      tools[op.tool_name] = {
        invoke: op.policy?.invoke ?? defaultInvoke,
        category: op.category,
        sensitivity: op.sensitivity,
      };
    }
  }
  return { tools, default_invoke: defaultInvoke };
}
