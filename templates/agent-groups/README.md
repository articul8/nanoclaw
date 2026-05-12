# Agent-group persona templates

This directory holds **personas** — parametric agent-group templates the
runtime materializes at mission-dispatch time. When a mission arrives
with `context.persona='<name>'`, the runner looks up `<name>/persona.json`
+ `<name>/CLAUDE.md` and stages an agent-group filesystem from them
before spawning the bun agent-runner.

Per fork lane discipline (`a8-claw/CLAUDE.md`): this directory is
arty-specific (AgentMesh platform integration). Adding new personas
here doesn't touch upstream nanoclaw core.

## Persona directory layout

```
templates/agent-groups/<persona-id>/
├── persona.json     — manifest: tools_allowed/denied, defaults, scheduling
├── CLAUDE.md        — system prompt (the persona's "who and how")
└── instructions.md  — optional pointer file the runner loads before chat
```

### persona.json fields

| Field | Purpose |
|---|---|
| `persona_id` | Stable identifier; matches the `context.persona` value on dispatch. |
| `version` | Semver. Bumped when CLAUDE.md or tool-set changes. |
| `description` | One-liner shown in catalog / admin UI. |
| `provider` | Default model provider (`claude` / `openai-compat` / `google`). |
| `default_model` | Resolved via Model Manager at runtime; this is the name. |
| `claude_md` | Path to the persona's CLAUDE.md (relative to this dir). |
| `tools_allowed` | Platform MCP tools the persona may invoke. Closed set. |
| `tools_denied` | Subset of Platform MCP catalog explicitly blocked. |
| `default_max_messages` | Per-prompt batching cap. |
| `max_wall_seconds` | Default mission budget if dispatcher doesn't override. |
| `scheduled_default` | Optional cron + scheduling hints for nightly-style personas. |

## Why parametric, not coded

Adding a new persona must be a **drop-in directory**, not a code change.
That's how arty stays generic — the same a8-claw binary runs as the
chat assistant, the reflector, the perception analyst, etc.; the only
difference is the persona template materialized at dispatch.

The runner's `cloud-main.ts` reads `context.persona` from the envelope
and the agent-runner's pre-boot step copies the template into
`/workspace/agent/`. Without `context.persona`, the runner falls back
to the default `assistant` persona.

## Available personas (v1)

| ID | Purpose |
|---|---|
| `arty-reflector` | Autoskill continual-learning loop — reads `mission_events`, writes tiered memory. Dispatched nightly + at end-of-task. |

More land here as the platform grows. Conventions:
- Persona ids are lowercase-hyphenated.
- Versions bump on substantive CLAUDE.md or tools_allowed changes.
- Personas that talk to a customer always belong to one tenant context;
  internal personas (like the reflector) may use the calling user's
  context.
