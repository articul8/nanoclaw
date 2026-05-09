# Runtime Contract — atomic-agent | a8-code | a8-claw

**Document version:** `v1.1`
**Last updated (UTC):** `2026-05-08 00:00 UTC`
**Owner:** Mission engine (defined by ADR-20680a6f)
**Implementers:** All three runtime sessions (atomic-agent, a8-code, a8-claw)

---

## 1. What this is and why it exists

This file is the **single source of truth** for the wire contract between the mission engine and any agent runtime. atomic-agent, a8-code, and a8-claw all conform to this contract. New runtimes plug in by conforming to this contract — the mission engine learns nothing runtime-specific.

It exists because three runtime implementations are being built in parallel sessions. Without a locked contract, each session will quietly invent slightly different envelope shapes, header names, and audit payloads. Drift caught at week boundary is cheap. Drift caught at month boundary is a refactor.

**Read-only after first commit.** Changes require coordinated PRs across all three runtimes. If you find yourself wanting to change something here as you build a8-claw, **stop, raise it, get cross-runtime sign-off, then change**. Do not silently extend the contract from inside a runtime.

---

## 2. Dispatch — coordinator → runtime

The mission coordinator publishes one message per agent invocation to RabbitMQ exchange `agent_execute`. Every runtime's pods subscribe to the same exchange and **filter strictly** on `agent_type`, **nacking** any message whose `agent_type` doesn't match.

### 2.1 `agent_execute` envelope (REQUIRED shape)

```jsonc
{
  "mission_id":      "mis-7a8f...",          // string, required
  "task_id":         "task-3e1c...",          // string, required
  "agent_type":      "a8-claw",               // enum: "atomic-agent" | "a8-code" | "a8-claw"  (REQUIRED — runtime selector)
  "tenant_id":       "tenant-acme",           // string, required
  "user_id":         "user-arun",             // string, required
  "parent_agent_id": "ag-9b21...",            // string | null  (set when spawned by another agent)
  "role":            "data-analyst",          // string  (drives CLAUDE.md interpolation; required for spawned agents)
  "goal":            "...",                   // string  (the agent's brief, in natural language)
  "context": {                                // object  (mission-specific handoff)
    "session_id":         "...",
    "domain_hint":        "procurement",
    "candidate_entities": ["...", "..."],
    "blackboard_keys":    ["..."]              // keys the agent should read from the mission blackboard
  },
  "budget": {                                  // object, REQUIRED
    "max_tokens":          200000,             // integer  (Model Manager spend cap)
    "max_wall_seconds":    1800,               // integer  (kernel-enforced where possible)
    "max_concurrent_t3":   2,                  // integer  (perception drill-downs in flight)
    "max_spawn_depth":     1                   // integer  (0 = cannot spawn; 1 = can spawn leaf agents)
  },
  "cancellation_token": "ct-...",              // string  (opaque; the runtime listens for this on the bus)
  "idempotency_key":    "...",                 // string  (coordinator-side dedup)
  "audit_event_id":     "evt-..."              // string  (the dispatch event that produced this envelope)
}
```

**Invariants:**
- All eight top-level fields except `parent_agent_id` are required.
- `agent_type` MUST be one of the enumerated values. Unknown values → runtime rejects, coordinator audit-logs.
- `tenant_id` and `user_id` are non-empty strings — never null, never empty, never `"system"` from a customer-originated mission.
- `budget.*` fields are integer caps. The runtime is responsible for enforcing them; the coordinator does not retroactively kill on overrun (that's a runtime contract violation).
- `cancellation_token` MUST be subscribed to on `mission.{mission_id}.bus.control` per Section 5.

### 2.2 Field provenance

| Field | Set by | Notes |
|---|---|---|
| `mission_id`, `task_id` | coordinator | UUIDs |
| `agent_type` | coordinator dispatcher (runtime-selection rules per ADR-20680a6f) | overridable by mission template |
| `tenant_id`, `user_id` | inherited from the mission's owning context | non-negotiable per CLAUDE.md rule 0.5 |
| `parent_agent_id` | spawn API (`POST /missions/{id}/spawn`) | null for top-level dispatches |
| `role` | mission template OR spawn API request | runtime uses this to interpolate CLAUDE.md |
| `budget` | coordinator computes from mission caps + parent budget (when spawned) | spawned agent's caps ≤ parent's remaining caps |
| `cancellation_token` | coordinator | unique per dispatch |

---

## 3. Completion — runtime → coordinator

On task completion (success, failure, partial, or cancelled), the runtime publishes ONE message to RabbitMQ queue `mission_completions`.

### 3.1 `mission_completions` envelope (REQUIRED shape)

```jsonc
{
  "mission_id": "mis-7a8f...",
  "task_id":    "task-3e1c...",
  "agent_id":   "ag-...",                       // runtime-assigned identifier (e.g. container id for a8-claw)
  "agent_type": "a8-claw",
  "status":     "success",                      // enum: "success" | "partial" | "failed" | "cancelled"
  "result": {                                    // object  (role-specific result shape; the runtime defines this)
    "summary":   "...",
    "entities":  [...],
    "findings":  [...]
  },
  "usage": {                                     // object, REQUIRED on every completion
    "tokens_in":   12345,
    "tokens_out":  4567,
    "model_calls": 23,
    "tool_calls":  41,
    "duration_ms": 8410
  },
  "audit_event_count": 187,                     // integer  (events written to mission_events for this task)
  "completed_at":      "2026-05-05T06:42:00Z"   // ISO-8601
}
```

**Invariants:**
- One completion per `(mission_id, task_id)`. Idempotent if redelivered.
- `usage` is REQUIRED even on failure / cancellation (record what was spent before the exit).
- `result.summary` is required and human-readable.
- `audit_event_count` lets the coordinator detect runtimes that under-emit (e.g. expected 50 events for a 1800s session, got 3).

---

## 4. Audit ledger — every state change

All three runtimes write to one shared ledger: ClickHouse table `mission_events`, ingested via `POST {WARP_URL}/missions/{mission_id}/events`. Schema is defined in ADR-20680a6f and is read-only after Bundle 1 ships.

### 4.1 Event row shape

```jsonc
{
  "event_id":        "evt-...",                  // UUID, runtime-generated
  "tenant_id":       "tenant-acme",
  "user_id":         "user-arun",
  "mission_id":      "mis-...",
  "task_id":         "task-...",                 // nullable for mission-level events
  "agent_id":        "ag-...",                   // nullable for coordinator events
  "parent_agent_id": "ag-parent-...",            // nullable
  "agent_type":      "a8-claw",                  // REQUIRED for runtime events
  "event_kind":      "tool_call",                // enum (see 4.2)
  "payload":         { ... },                    // JSON, schema per event_kind (see 4.3)
  "timestamp":       "2026-05-05T06:42:00.123Z"  // ISO-8601 millisecond precision
}
```

### 4.2 Canonical `event_kind` values (read-only enum)

```
mission_submit          mission_complete         mission_cancel
dispatch                spawn                    spawn_rejected
bus_message_in          bus_message_out          broadcast
blackboard_read         blackboard_write         blackboard_conflict
budget_reserve          budget_commit            budget_release
tool_call               model_call               heartbeat
exit                    checkpoint               replay
```

**No runtime invents new `event_kind` values.** New kinds require coordinated cross-runtime PRs and a small follow-up ADR.

### 4.3 Payload schemas per event_kind

- `dispatch` — `{ runtime, role, goal_summary }`
- `spawn` — `{ child_agent_id, role, reason_for_spawn, spawn_depth, allowed_caps }`
- `tool_call` — `{ tool_name, tokens_in?, tokens_out?, latency_ms, success, reservation_id? }`
- `model_call` — `{ model_uuid, tokens_in, tokens_out, latency_ms, prompt_version?, reservation_id }`
- `bus_message_in` / `bus_message_out` — `{ topic, message_kind, peer_agent_id?, byte_count }`
- `blackboard_write` — `{ key, version_after, conflict: bool, byte_count }`
- `budget_reserve` — `{ reservation_id, dimension, requested, granted }`
- `budget_commit` / `budget_release` — `{ reservation_id, actual_usage }`
- `heartbeat` — `{}` (presence is the signal; payload empty)
- `cancel` — `{ reason, initiated_by: "user|coordinator|budget|timeout|peer", at }`
- `exit` — `{ code, final_state: "success|partial|failed|cancelled", duration_ms }`

### 4.4 Emission discipline

- **Every state-changing decision** writes one event. Reads do not (except `blackboard_read` which is auditable for high-stakes missions; controlled by mission flag).
- Writes are **fire-and-forget** to the Warp ingest endpoint with retry. They MUST NOT block the agent's hot path. Buffer in memory, flush async every 1s or 100 events whichever first.
- On runtime crash, in-flight events may be lost. The coordinator detects this via heartbeat absence and writes a synthetic `exit { final_state: "failed", reason: "lost_runtime" }`.

---

## 5. Inter-agent message bus

RabbitMQ topic exchange per mission: `mission.{mission_id}.bus`.

### 5.1 Subtopic structure

| Subtopic | Direction | Used for |
|---|---|---|
| `agents.{agent_id}` | inbox | direct messages to a specific agent |
| `broadcast` | mission-wide | peer messaging (MESH / BRAINSTORM patterns) |
| `control` | coordinator → all agents | cancellation, pause, resume |
| `heartbeat` | agents → coordinator | 30s ticks; missing 3 = stuck |

### 5.2 Bus message envelope

```jsonc
{
  "from_agent_id": "ag-...",
  "to_agent_id":   "ag-..." | null,            // null on broadcast
  "kind":          "request" | "response" | "broadcast" | "control" | "heartbeat",
  "payload":       { ... },
  "correlation_id": "...",
  "ts":            "2026-05-05T06:42:00Z"
}
```

### 5.3 Control messages

```jsonc
// Cancellation — coordinator publishes; every agent listens and exits
{ "kind": "control", "subkind": "cancel", "reason": "...", "initiated_by": "user|coordinator|budget|timeout" }

// Pause / resume (Bundle 4+)
{ "kind": "control", "subkind": "pause" | "resume" }
```

### 5.4 Heartbeat tick

Every active agent emits `{ kind: "heartbeat" }` on `mission.{id}.bus.heartbeat` every **30 seconds**. The coordinator considers an agent stuck after 3 missed ticks (90s).

---

## 6. Headers (all egress HTTP)

Every HTTP call from inside a runtime container/process to a platform service MUST carry these headers. Casing matters (matches existing platform convention).

```
X-Tenant-ID:       <tenant_id from mission envelope>
X-User-ID:         <user_id from mission envelope>
X-Mission-Token:   <opaque; required only for spawn/blackboard/cancel/audit endpoints>
Content-Type:      application/json   (when body is JSON)
```

**The headers are not optional and not configurable.** Inject them at the HTTP-client layer of the runtime so every outbound call gets them automatically. Do not leave it to per-call code.

---

## 7. Egress invariants (security)

These are **infrastructure-enforced**, not runtime-enforced. Runtimes MUST NOT attempt to bypass.

| Destination | Reachable from runtime? | Notes |
|---|---|---|
| Model Manager (`http://aks-model-manager.aks-agentmesh-apps.svc.cluster.local`) | YES | Auxiliary inference (sub-agent, embeddings, OCR, judges, perception models) |
| Tool Manager (`http://aks-tool-manager.aks-tool-manager-apps.svc.cluster.local`) | YES | All platform tools (MCP) |
| Warp (`http://aks-warp-service.aks-warp-apps.svc.cluster.local:8085`) | YES | All graph / memory / audit / metering APIs |
| RabbitMQ (cluster-internal) | YES | mission queues + bus topics |
| Configured main-model provider (e.g. `api.anthropic.com`) | **CONDITIONAL** | REACHABLE when the runtime is configured for direct main-model routing (`MAIN_MODEL_ROUTE=direct`); BLOCKED otherwise. See §7.1 below. |
| Other (non-configured) model provider endpoints (e.g. `api.openai.com`, `api.cohere.ai`, …) | **BLOCKED** | runtimes that bypass the configured path fail loudly at the runtime egress allowlist; non-configured providers are never reachable |
| Channel adapter targets (per channel — Slack, Telegram, etc.) | YES, per allowlist | configured per channel |
| Public internet (general) | **BLOCKED** | tools that need it must route through Tool Manager's `web_search` builtin |

For a8-claw, this is enforced at the K8s NetworkPolicy boundary (`<A8CLAW>/k8s/network-policy.yaml`) plus the runtime-side egress allowlist (`src/auth/egress-allowlist.ts`). For a8-code, at its pod's NetworkPolicy. For atomic-agent, at its pod's NetworkPolicy.

### 7.1 Bifurcated model routing (v1.1)

Conversational and autonomous-engineer runtimes (a8-claw, a8-code) are latency-sensitive on their **main driver model** — the Claude that runs the conversation / planning loop. To avoid the Model Manager hop on the hot path, runtimes MAY be configured to route main-model traffic directly to the provider:

- `MAIN_MODEL_ROUTE = "direct"` (default for a8-claw, a8-code) — `ANTHROPIC_BASE_URL = https://api.anthropic.com`; `ANTHROPIC_API_KEY` resolved per-tenant (with per-user BYOK override) at session spawn from the platform credential service / vault. The runtime self-reports usage to metering-service after each call (async fire-and-forget) using the same row shape Model Manager would have emitted, with `source: "direct"`.
- `MAIN_MODEL_ROUTE = "model_manager"` — `ANTHROPIC_BASE_URL = ${MODEL_MANAGER_URL}/run/{uuid}` resolved via Model Manager `/resolve` at session spawn; no API key in env; Model Manager auto-meters.

**ALL OTHER model calls** (sub-agent inference, embeddings, OCR, judges, perception models, etc.) continue to route through Model Manager regardless of `MAIN_MODEL_ROUTE`. The runtime egress allowlist denies all LLM provider domains *except* the configured main-model provider when in `direct` mode. atomic-agent does not use direct routing — its workload is short-running and fan-out friendly, where Model Manager's centralized control outweighs the per-call latency.

---

## 8. CLAUDE.md per-agent persona convention

Every runtime that ships a per-agent persona uses the same authoring template (per ADR-cb87ff61's "Same authoring pattern as a8-code"):

- **Section 1**: platform brain (the perception agent template at `<WARP>/src/api/perception/session/claude_md_template.md`, with `{{TENANT_ID}}`, `{{USER_ID}}`, `{{WARP_URL}}` interpolated)
- **Section 2**: agent role addendum (`role: "data-analyst"` → "You are a data analyst...")
- **Section 3**: capability subset (the perception tools relevant to this role, emphasized; rest still callable but de-emphasized)
- **Section 4**: domain pack (when `domain_hint` provided, the matching pack's `concepts` and `query_patterns`)

The four sections are concatenated at session-spawn time. No runtime invents a different shape.

---

## 9. Tool surface

All runtimes call platform tools through Tool Manager via MCP. The 23 perception tools are catalogued in:
- `<AGENTMESH>/rust-tool-registry/PERCEPTION_TOOLS_USER_GUIDE_20260505.md`
- `<AGENTMESH>/rust-tool-registry/PERCEPTION_TOOLS_LLM_PROMPTING_GUIDE_20260505.md`

**No runtime ships its own tool implementations.** If a runtime needs a tool that doesn't exist, it requests one in the tool registry — it does not build a parallel tool surface.

---

## 10. Spawn API (Bundle 3 — defined by mission engine, called by runtimes)

```
POST {WARP_URL}/missions/{mission_id}/spawn
Headers: X-Tenant-ID, X-User-ID, X-Mission-Token
Body:
{
  "role":             "data-analyst",       // required
  "agent_type":       null,                 // null = coordinator picks by role
  "goal":             "...",                // required
  "parent_agent_id":  "<calling-agent>",    // required
  "budget": { "max_tokens": ..., "max_wall_seconds": ..., "max_concurrent_t3": ..., "max_spawn_depth": ... },
  "reason_for_spawn": "...",                 // REQUIRED, non-empty, non-boilerplate
  "context_handoff":  { "blackboard_key": "...", "candidates": [...] }
}

Response:
{
  "agent_id":             "ag-...",
  "task_id":              "task-...",
  "agent_type":           "a8-claw",
  "spawn_depth":          2,
  "budget_reservation_id": "res-...",
  "audit_event_id":       "evt-..."
}
```

Bounded by per-mission `max_spawn_depth` and `max_agents`. Refused spawns return `400 spawn_depth_exceeded` or `429 max_agents_exceeded` and write a `spawn_rejected` audit event.

---

## 11. What this contract does NOT cover

These are runtime-internal concerns; each runtime decides:

- How the runtime tokenizes / streams its LLM responses
- Container vs process model (a8-claw: container per session; a8-code: pod per session; atomic-agent: pod is shared across many invocations)
- Internal state representation (a8-claw uses NanoClaw's session DBs; atomic-agent uses in-memory; a8-code uses local scratch + S3 checkpoints)
- Channel adapters (a8-claw inherits NanoClaw's; a8-code has none)
- Local-mode / on-prem story (per-runtime; a8-code is first-class today, a8-claw is Future Work)

If you find yourself needing to standardize one of these, that's a contract extension — coordinated PR.

---

## 12. Changelog

| Date | Author | Change |
|---|---|---|
| 2026-05-05 | Arun | Initial version. Locked the wire contract for atomic-agent / a8-code / a8-claw to prevent drift while three parallel implementation sessions run. |
| 2026-05-08 | Arun | v1.1 — bifurcated model routing (§7 + §7.1): main driver model in latency-sensitive runtimes (a8-claw, a8-code) MAY route direct to the configured provider with per-tenant + per-user BYOK keys and runtime self-reported metering; all other model calls continue through Model Manager. Default for a8-claw and a8-code is `MAIN_MODEL_ROUTE=direct`. atomic-agent is unaffected. |

---

## 13. References

- **ADR-cb87ff61** — a8-claw Conversational Runtime (`<AGENTMESH>/docs/adr/ADR-cb87ff61-A8_CLAW_CONVERSATIONAL_RUNTIME_20260505T0449Z.md`)
- **ADR-20680a6f** — Multi-Runtime Mission Engine (`<AGENTMESH>/docs/adr/ADR-20680a6f-MULTI_RUNTIME_MISSION_ENGINE_20260505T0449Z.md`)
- **ADR-728dac9e** — a8-code Platform-Native AI Engineer (`<AGENTMESH>/docs/adr/ADR-728dac9e-A8_CODE_PLATFORM_NATIVE_AI_ENGINEER_20260323T0430Z.md`)
- **ADR-97b4d8fe** — Progressive Materialization (BudgetGuard pattern reused) (`<WARP>/docs/adr/ADR-97b4d8fe-TIERED_EXTRACTION_DRILL_DOWN_20260426T2207Z.md`)
- **Perception tool catalog**: `<AGENTMESH>/rust-tool-registry/PERCEPTION_TOOLS_USER_GUIDE_20260505.md`
- **Perception agent CLAUDE.md template**: `<WARP>/src/api/perception/session/claude_md_template.md`

---

*Generated: 2026-05-05T06:42Z. Read-only after first commit. Changes require coordinated PRs across all three runtimes.*
