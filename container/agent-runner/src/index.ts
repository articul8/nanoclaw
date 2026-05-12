/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import { fetchSessionRecall, withRecall } from './recall.js';
import { restoreSnapshot } from './restore.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  // Pod-boot session restore — pairs with end-of-turn snapshot.ts. When
  // RESUME_SESSION_ID is set (set by the orchestrator on a re-spawn
  // resume), download the latest snapshot from Warp and extract into
  // /workspace/ BEFORE loadConfig() / poll-loop touch any session files.
  // No-op when not resuming, when SESSION_PRIVACY=incognito, or in
  // local mode (workspace already on disk).
  const restoreResult = await restoreSnapshot();
  if (restoreResult.restored) {
    log(`Restored session snapshot ${restoreResult.file_id} (${restoreResult.size_bytes} bytes)`);
  } else if (restoreResult.reason && restoreResult.reason !== 'no-resume') {
    log(`Restore skipped: ${restoreResult.reason}${restoreResult.detail ? ' — ' + restoreResult.detail : ''}`);
  }

  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  let instructions = buildSystemPromptAddendum(config.assistantName || undefined);

  // Session-boot recall — Autoskill recall tier. Calls IntelligenceService
  // once at boot and appends pre-ranked context to the system prompt so
  // the agent doesn't burn context-window tokens on search round-trips.
  // No-op for incognito sessions, standalone mode, or HTTP failures.
  const recall = await fetchSessionRecall();
  if (recall.prompt_snippet) {
    instructions = withRecall(instructions, recall.prompt_snippet);
    log(`Recall: injected ${recall.items.length} item(s) into system prompt`);
  } else if (recall.skipped_reason && recall.skipped_reason !== 'no-warp') {
    log(`Recall skipped: ${recall.skipped_reason}${recall.detail ? ' — ' + recall.detail : ''}`);
  }

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in (always stdio) +
  // articul8 platform MCP (always stdio, when present) + any extras
  // from container.json (stdio | http | sse).
  //
  // articul8 is the Platform MCP federation library — bundles 25 ops
  // across warp, intelligence, agentmesh, prompt_hub, model_manager,
  // tool_manager (catalog v0.2). Bundled into the image at
  // /app/platform-mcp/ by build-and-deploy.sh; we conditionally enable
  // it when the entrypoint file is present, so local-mode setups
  // that don't sync the sibling dir still boot.
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      type: 'stdio',
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  const platformMcpEntry = '/app/platform-mcp/src/stdio-entrypoint.ts';
  if (fs.existsSync(platformMcpEntry)) {
    // Forward only the env the platform MCP library needs — explicit
    // allowlist so the catalog can audit what's exposed. Empty values
    // are dropped to keep the child process env tidy.
    const forward: Record<string, string> = {};
    for (const k of [
      'TENANT_ID',
      'USER_ID',
      'WARP_URL',
      'MODEL_MANAGER_URL',
      'TOOL_MANAGER_URL',
      'PROMPT_HUB_URL',
      'METERING_USAGE_URL',
      'MISSION_TOKEN',
      'MISSION_ID',
      'TASK_ID',
      'AGENT_ID',
      'AGENT_TYPE',
      'SESSION_ID',
      'SESSION_PRIVACY',
    ]) {
      const v = process.env[k];
      if (v) forward[k] = v;
    }
    mcpServers.articul8 = {
      type: 'stdio',
      command: 'bun',
      args: ['run', platformMcpEntry],
      env: forward,
    };
    log(`Platform MCP (articul8) enabled: ${platformMcpEntry}`);
  } else {
    log(`Platform MCP not present at ${platformMcpEntry} — skipping (local-mode setup likely)`);
  }

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    const transport = serverConfig.type ?? 'stdio';
    const detail = transport === 'stdio' ? (serverConfig as { command: string }).command : (serverConfig as { url: string }).url;
    log(`Additional MCP server: ${name} (${transport}: ${detail})`);
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
