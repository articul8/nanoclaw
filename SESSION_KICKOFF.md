# a8-claw — Session Kickoff

**Document version:** `v1.0`
**Last updated (UTC):** `2026-05-05 06:42 UTC`
**Audience:** Claude (or any agent/engineer) starting a fresh session in `<A8CLAW>/` to build the a8-claw runtime.

> **If you are Claude reading this at the start of a session: read this entire file before doing anything else. It is your charter. The other source you must read before writing any code is the runtime contract at `./RUNTIME_CONTRACT_20260505.md`.**

---

## 1. Why this session exists

You are building **a8-claw** — the third mission runtime in the AgentMesh platform. Two ADRs were just landed that define what to build and how it integrates:

- **`<AGENTMESH>/docs/adr/ADR-cb87ff61-A8_CLAW_CONVERSATIONAL_RUNTIME_20260505T0449Z.md`** — what a8-claw is, what shape it solves, how it differs from the other two runtimes.
- **`<AGENTMESH>/docs/adr/ADR-20680a6f-MULTI_RUNTIME_MISSION_ENGINE_20260505T0449Z.md`** — the mission engine that dispatches to all three runtimes.

**Read both ADRs end-to-end before writing any code.** They are not background reading. They are the spec.

a8-claw is a fork of `https://github.com/qwibitai/nanoclaw` v2 — a small (~21K lines TS), well-architected personal Claude assistant. We adapt it for AgentMesh's multi-tenant, mission-driven world. The fork lives at `<A8CLAW>/`.

---

## 2. Where you are

```
<A8CLAW>/                          ← your working directory
├── k8s/                           ← already present (warm-pool, sandbox-template,
│                                     network-policy, secrets-and-config)
├── RUNTIME_CONTRACT_20260505.md   ← the wire contract (READ-ONLY for you)
└── SESSION_KICKOFF.md             ← this file
```

The K8s manifests already exist — someone began the deployment plumbing before this ADR pair was written. Your job includes wiring them to the contract.

---

## 3. Lane discipline (HARD RULE)

**You only edit files inside `<A8CLAW>/`.** That includes:
- The fork's source (which you'll create by cloning `qwibitai/nanoclaw` into this directory after step 5)
- Templates, configs, K8s manifests, docs *inside this directory*
- Tests *inside this directory*

You **do not edit** outside `<A8CLAW>/`. Specifically:
- `<AGENTMESH>/backend/agentmesh/` — that's the mission engine session
- `<AGENTMESH>/backend/orchestrator/` — that's the mission engine session
- `<AGENTMESH>/a8-code/` — that's a separate parallel session
- `<AGENTMESH>/atomic-agent/` — already exists, don't touch
- `<AGENTMESH>/rust-tool-registry/` — already shipped Perception Wave 1+2; don't touch
- `<AGENTMESH>/warp/` — that's the platform; don't touch

If you find yourself needing to change something outside `<A8CLAW>/`, **stop and ask**. That's a cross-runtime change, which means a coordination event (the runtime contract document, see Section 6).

---

## 4. The user's working preferences (auto-loaded from memory)

These apply to every session, including this one:

- **Plan before code on non-trivial features.** Present a plan, wait for approval, then implement. The user has been burned by code-first approaches.
- **NEVER add `Co-Authored-By` lines to git commit messages.** Hard rule.
- **Surgical commits.** Stage exactly the files you touched. Do not use `git add -A` or `git add .`. List paths explicitly.
- **Verify before claiming done.** Run the build / test / type-check; show real output. Don't claim "should work" — confirm.
- **Honest provenance.** If you don't know something, say so. Don't invent endpoints or types from prior training. Read the source.
- **No mem0.** It was removed long ago; do not reference it.
- **Use conventional commits**: `feat(...)`, `fix(...)`, `docs(...)`, `refactor(...)`, etc.

---

## 5. v1 scope (LOCKED — anything else is v2)

a8-claw v1 ships when **all** of the following are true:

1. The fork is initialized at `<A8CLAW>/` from `qwibitai/nanoclaw` v2 trunk, with upstream remote tracked.
2. A new channel adapter `src/channels/mission-queue/` consumes RabbitMQ `agent_execute` filtered by `agent_type: "a8-claw"` and writes mission envelopes (per `RUNTIME_CONTRACT_20260505.md` §2.1) into the inbound session DB.
3. An outbound-DB tail emits `mission_completions` envelopes (§3.1) and audit events (§4) back through Warp's `POST /missions/{id}/events` ingest endpoint.
4. The container template configures Claude Agent SDK with:
   - `ANTHROPIC_BASE_URL` = Model Manager URL (so all inference routes through the gateway)
   - MCP server config = Tool Manager URL (so the 23 perception tools auto-load)
   - `WARP_URL`, `TENANT_ID`, `USER_ID` env vars
   - Egress allowlist blocking `api.anthropic.com` and `api.openai.com` (§7 of the contract)
5. CLAUDE.md interpolation produces a valid persona for at least **one** role (`perception-analyst`) per §8 of the contract.
6. K8s warm pool runs one host pod per tenant; container per session; integration test round-trips one mission task: coordinator → queue → host → container → Tool Manager call (`nge_search`) → outbound DB → `mission_completions` → `mission_events` row written.
7. Mission cancellation: coordinator publishes to `mission.{id}.bus.control`, host SIGKILLs the container, audit ledger records the exit event with `final_state: "cancelled"`.
8. Documentation: `<A8CLAW>/CLAUDE.md` documenting fork-vs-upstream deviations.

**Everything else is v2.** Multi-channel adapters (Telegram/Slack/etc.) work because nanoclaw ships them — but wiring them to AgentMesh tenants is v2. Local mode is v2. Three persona templates (only `perception-analyst` for v1; `data-analyst` and `field-engineer` are v2).

If you find yourself building something not in this list, **stop**. It belongs in a v2 ADR or a follow-up. Tell the user.

---

## 6. The runtime contract is read-only

`RUNTIME_CONTRACT_20260505.md` (sibling file) is the wire contract atomic-agent, a8-code, and a8-claw all conform to. It defines:
- `agent_execute` envelope shape (what arrives from the coordinator)
- `mission_completions` envelope shape (what you publish back)
- Audit event row shape (what you write to `mission_events`)
- `event_kind` canonical enum
- HTTP header conventions (X-Tenant-ID, X-User-ID, X-Mission-Token)
- Egress invariants (Model Manager only; `api.anthropic.com` blocked)
- Bus topic structure
- CLAUDE.md interpolation pattern
- Spawn API contract

**Conform to it. Do not deviate.** If you genuinely need to change something:
1. Stop coding.
2. Tell the user what change is needed and why.
3. The user coordinates with the parallel sessions building atomic-agent / a8-code / mission engine.
4. Cross-runtime PR locks the new contract version.
5. Then resume.

Silent contract drift is the failure mode this project is actively trying to prevent.

---

## 7. The build order I recommend (you can argue with this)

You'll want to read both ADRs first, then run a brief planning session before any code. My suggested sequence (subject to revision):

### Step 0 — Read & plan (~1-2 hours, no code)
1. Read both ADRs end-to-end.
2. Read `RUNTIME_CONTRACT_20260505.md` end-to-end.
3. Read `<A8CLAW>/k8s/*.yaml` to understand what plumbing is already there.
4. Browse `qwibitai/nanoclaw` upstream — README, CLAUDE.md, `src/` layout. Understand its IO model ("everything is a message", per-session containers, host process orchestrating).
5. Present a plan to the user: file-by-file, what you'll create / modify / leave alone. Wait for approval.

### Step 1 — Initialize the fork (small, mechanical)
- Clone `qwibitai/nanoclaw` v2 into `<A8CLAW>/` (preserving the existing K8s dir).
- Add upstream remote.
- Verify the existing K8s manifests match nanoclaw's expectations.
- Commit: `feat(a8-claw): initialize from qwibitai/nanoclaw v2 fork`.

### Step 2 — Write `<A8CLAW>/CLAUDE.md` (the fork's deviations doc)
- Document: this is a fork; upstream is at github.com/qwibitai/nanoclaw; modifications confined to `src/channels/mission-queue/`, `templates/agent-groups/`, `k8s/`, `CLAUDE.md`. Per ADR-cb87ff61.
- Migration banner from upstream stays in some form — adapt for the AgentMesh fork context.

### Step 3 — Build the `mission-queue` channel adapter
- `src/channels/mission-queue/index.ts` — RabbitMQ consumer; filter `agent_type: "a8-claw"`; write to inbound session DB.
- `src/channels/mission-queue/outbound-tail.ts` — tail outbound DB; emit `mission_completions` + audit events.
- `src/channels/mission-queue/mission-envelope.ts` — type-safe envelope (matches contract §2.1 / §3.1 exactly).
- `src/channels/mission-queue/audit-emitter.ts` — POST to Warp `/missions/{id}/events`.
- Tests: round-trip a fake mission envelope through the adapter to a stubbed session DB.

### Step 4 — Wire container env + egress
- Container template reads `MODEL_MANAGER_URL`, `TOOL_MANAGER_URL`, `WARP_URL`, `TENANT_ID`, `USER_ID` from env.
- Inject `ANTHROPIC_BASE_URL = ${MODEL_MANAGER_URL}` for the SDK.
- Configure MCP server pointing at Tool Manager so the 23 perception tools auto-load.
- NetworkPolicy (`<A8CLAW>/k8s/network-policy.yaml`) — verify egress to Model Manager / Tool Manager / Warp / RabbitMQ allowed; `api.anthropic.com` blocked.

### Step 5 — Persona template (`perception-analyst`)
- `templates/agent-groups/perception-analyst/CLAUDE.md` — interpolated from the perception agent template at `<WARP>/src/api/perception/session/claude_md_template.md` + role addendum + capability emphasis (per contract §8).
- `templates/agent-groups/perception-analyst/agent-group.json` — nanoclaw agent_group config.

### Step 6 — Multi-tenant warm pool wiring
- One host pod per tenant; K8s manifest update.
- `TENANT_ID` / `USER_ID` env injected per pod.
- NetworkPolicy denies cross-tenant pod traffic.

### Step 7 — Integration test
- `tests/integration/mission-queue/test_dispatch_round_trip.ts` — coordinator → queue → host → container → Tool Manager call → ledger event recorded.
- `tests/integration/mission-queue/test_cancellation.ts` — cancel envelope → SIGKILL → exit event.
- `tests/integration/mission-queue/test_tenant_isolation.ts` — cross-tenant access fails.

### Step 8 — Surgical commits + push
- Stage explicitly per change (see preferences §4).
- One commit per coherent unit of work, conventional-commit message.
- Push to feature branch.

---

## 8. What you have available

Already shipped, ready to use:

- **23 perception tools** in Tool Manager (Wave 1+2 already deployed):
  - Catalog: `<AGENTMESH>/rust-tool-registry/PERCEPTION_TOOLS_USER_GUIDE_20260505.md`
  - LLM prompting guide: `<AGENTMESH>/rust-tool-registry/PERCEPTION_TOOLS_LLM_PROMPTING_GUIDE_20260505.md`
  - Tools include: `nge_search`, `nge_query`, `apm_query`, `graph_schema`, `graph_get_node`, `graph_traverse`, `graph_asset360`, `graph_impact`, `graph_shortest_path`, `block_drill`, `block_get`, `intelligence_brief`, `recall_episode`, `episode_create`, `semantic_create`, `explain_node`, `ts_bridge`, `ts_query`, `ts_outliers_detect`, `dataframe_preview`, `dataframe_query`, `dataframe_insights`, `activity_for_entity`.
- **Model Manager** for inference routing.
- **Warp APIs** for graph / memory / activity / metering / spawn / blackboard / audit.
- **Perception agent template** at `<WARP>/src/api/perception/session/claude_md_template.md` — the platform brain CLAUDE.md.
- **K8s manifests** at `<A8CLAW>/k8s/` (warm-pool, sandbox-template, network-policy, secrets-and-config).
- **Existing a8-code ADR** for reference on the parallel runtime's pattern: `<AGENTMESH>/docs/adr/ADR-728dac9e-A8_CODE_PLATFORM_NATIVE_AI_ENGINEER_20260323T0430Z.md`.

---

## 9. What you should NOT do

1. **Don't replace atomic-agent or a8-code.** All three runtimes coexist. You are the third runtime, not the only one.
2. **Don't move mission orchestration into a8-claw.** The mission engine stays in `<AGENTMESH>/backend/agentmesh/` + `<AGENTMESH>/backend/orchestrator/`. You are a *runtime*, not a platform.
3. **Don't patch nanoclaw's single-user assumption inside its core.** Multi-tenancy is enforced at the K8s pod boundary above nanoclaw. The fork keeps nanoclaw's internal model intact.
4. **Don't bundle the official Anthropic SDK with hardcoded API keys.** Inference routes through Model Manager. SDK-level keys are forbidden; the container's egress allowlist blocks `api.anthropic.com`.
5. **Don't build a parallel tool surface.** The 23 perception tools are reachable via Tool Manager (MCP). If you need a tool that doesn't exist, request it in the registry — don't reimplement.
6. **Don't drift from the runtime contract.** See Section 6.
7. **Don't expand v1 scope.** See Section 5.
8. **Don't add features nanoclaw doesn't need from upstream.** Confine modifications to `src/channels/mission-queue/`, `templates/agent-groups/`, `k8s/`, `CLAUDE.md`. Channel adapters for Slack/Telegram/etc. ship with the fork — leave them alone.
9. **Don't write speculative tools or endpoints.** Only build what verifies an endpoint exists. (Lesson learned in the perception toolkit work — always grep the warp source to confirm a route is real before wrapping it.)
10. **Don't claim work is done without verification.** Run `pnpm build`, `pnpm test`, K8s apply on staging, integration test round-trip — show real output before marking anything done.

---

## 10. When stuck — what to do

1. **Re-read both ADRs.** Most "I don't know what to do" comes from skimming them.
2. **Check the runtime contract.** If your question is about wire format, header names, event shapes — it's there.
3. **Check upstream nanoclaw.** Most architectural questions are answered by reading their `CLAUDE.md` + `src/index.ts`.
4. **Ask the user.** Genuine ambiguity in the ADRs is the user's responsibility to resolve. Don't guess.
5. **Read existing platform code.** If you need to know how Tool Manager exposes MCP, read `<AGENTMESH>/rust-tool-registry/src/registry.rs`. If you need the perception agent template, read it directly.

---

## 11. The relationship to other Claude sessions

There may be a parallel session building a8-code (in `<A8CODE>/`) and a parallel session upgrading the mission engine (in `<AGENTMESH>/backend/agentmesh/` + `<AGENTMESH>/backend/orchestrator/`). You do not communicate with those sessions directly — your only shared interface is the `RUNTIME_CONTRACT_20260505.md` file (read-only for you).

If you discover that the mission engine has not yet built Bundle 1 (audit ledger ingest at `POST /missions/{id}/events`), your audit-emitter calls will return 404. That's fine for your local development; stub the endpoint with a fake server and continue. When Bundle 1 ships, the contract is unchanged, so your code works without modification.

---

## 12. Done definition

You're done with v1 when:
- All eight bullets in Section 5 are checked
- `pnpm build` succeeds
- `pnpm test` passes
- Integration test round-trips a real mission task end-to-end on staging
- Surgical commits pushed
- A v1 release notes doc lives at `<A8CLAW>/docs/V1_RELEASE_20260???.md`

Then tell the user. Don't keep adding features. v2 is a separate ADR.

---

## 13. References

- **`./RUNTIME_CONTRACT_20260505.md`** — sibling file; the wire contract (read-only)
- **ADR-cb87ff61** — `<AGENTMESH>/docs/adr/ADR-cb87ff61-A8_CLAW_CONVERSATIONAL_RUNTIME_20260505T0449Z.md`
- **ADR-20680a6f** — `<AGENTMESH>/docs/adr/ADR-20680a6f-MULTI_RUNTIME_MISSION_ENGINE_20260505T0449Z.md`
- **ADR-728dac9e** — a8-code's ADR (the parallel runtime, useful for pattern reference)
- **Upstream nanoclaw** — `https://github.com/qwibitai/nanoclaw`
- **Perception toolkit** — `<AGENTMESH>/rust-tool-registry/PERCEPTION_TOOLS_USER_GUIDE_20260505.md`
- **Perception agent template** — `<WARP>/src/api/perception/session/claude_md_template.md`

---

*Generated: 2026-05-05T06:42Z. This file is your charter for the session. Read it; follow it; ask before deviating.*
