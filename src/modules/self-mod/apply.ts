/**
 * Approval handlers for self-modification actions.
 *
 * The approvals module calls these when an admin clicks Approve on a
 * pending_approvals row whose action matches. Each handler mutates the
 * container config, rebuilds/kills the container as needed, and lets the
 * host sweep respawn it on the new image on the next message.
 *
 * install_packages: rebuild image + kill container (apt/npm global installs
 *   must be baked into the image layer).
 * add_mcp_server: kill container only — bun runs TS directly, so a pure
 *   MCP wiring change needs nothing more than a process restart.
 */
import { updateContainerConfig, type McpServerConfig } from '../../container-config.js';
import { buildAgentGroupImage, killContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { ApprovalHandler } from '../approvals/index.js';

export const applyInstallPackages: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_packages approved but agent group missing.');
    return;
  }
  updateContainerConfig(agentGroup.folder, (cfg) => {
    if (payload.apt) cfg.packages.apt.push(...(payload.apt as string[]));
    if (payload.npm) cfg.packages.npm.push(...(payload.npm as string[]));
  });

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id, userId });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    killContainer(session.id, 'rebuild applied');
    // Schedule a follow-up prompt a few seconds after kill so the host sweep
    // respawns the container on the new image and the agent verifies + reports.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
        sender: 'system',
        senderId: 'system',
      }),
      processAfter: new Date(Date.now() + 5000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ''),
    });
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    notify(
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
};

export const applyAddMcpServer: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('add_mcp_server approved but agent group missing.');
    return;
  }
  updateContainerConfig(agentGroup.folder, (cfg) => {
    cfg.mcpServers[payload.name as string] = {
      command: payload.command as string,
      args: (payload.args as string[]) || [],
      env: (payload.env as Record<string, string>) || {},
    };
  });

  killContainer(session.id, 'mcp server added');
  notify(`MCP server "${payload.name}" added. Your container will restart with it on the next message.`);
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id, userId });
};

/**
 * Apply a registry-resolved MCP entry. Handles all three transports
 * (mcp_http / mcp_sse / mcp_stdio) by reading `entry.install` and
 * producing the right McpServerConfig shape. Header / env template
 * substitution: ${ENV_VAR} placeholders are filled from process.env
 * (host-side; the secrets get baked into the container.json that the
 * container mounts RO — future v2 will resolve from OneCLI vault at
 * spawn time instead so secrets don't sit on disk).
 *
 * For mcp_http / mcp_sse — appended verbatim with type and headers.
 * For mcp_stdio — command + args + env baked from install info.
 * For non-MCP types (channel, tool_family, runtime_peer) — return a
 * specific error: those go through their own install paths, not the
 * container.json mcpServers map. The agent shouldn't have routed them
 * here, but defense-in-depth.
 */
export const applyAddMcpServerFromRegistry: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('add_mcp_server_from_registry approved but agent group missing.');
    return;
  }
  const entry = payload.entry as RegistryEntryShape | undefined;
  const registryId = payload.registry_id as string | undefined;
  if (!entry || !registryId) {
    notify('add_mcp_server_from_registry: entry / registry_id missing in payload.');
    return;
  }
  if (entry.type !== 'mcp_http' && entry.type !== 'mcp_sse' && entry.type !== 'mcp_stdio') {
    notify(
      `"${entry.name}" is a ${entry.type}, not an MCP server — it needs its own install path (channel install / tool family enable / runtime-peer wire), not container.json mcpServers.`,
    );
    log.warn('add_mcp_server_from_registry: non-MCP entry routed here', { registry_id: registryId, type: entry.type });
    return;
  }

  const cfg = buildMcpConfigFromEntry(entry, process.env);
  updateContainerConfig(agentGroup.folder, (containerCfg) => {
    // buildMcpConfigFromEntry returns the union shape; the
    // container-config typedef accepts the same union (see
    // src/container-config.ts).
    containerCfg.mcpServers[registryId] = cfg as unknown as McpServerConfig;
  });

  killContainer(session.id, `registry mcp added: ${registryId}`);
  notify(`${entry.name} wired (${entry.type}). Your container will restart with it on the next message.`);
  log.info('MCP server (registry) applied', { agentGroupId: session.agent_group_id, registryId, type: entry.type, userId });
};

/** Minimal local shape — keeps this file independent of the host registry types module. */
interface RegistryEntryShape {
  id: string;
  type: 'channel' | 'mcp_http' | 'mcp_sse' | 'mcp_stdio' | 'tool_family' | 'runtime_peer';
  name: string;
  install: Record<string, unknown>;
  credentials_env?: string[];
}

function buildMcpConfigFromEntry(entry: RegistryEntryShape, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const install = entry.install;
  if (entry.type === 'mcp_http' || entry.type === 'mcp_sse') {
    const headers: Record<string, string> = {
      ...((install.static_headers as Record<string, string>) ?? {}),
      ...substituteHeaderTemplate((install.headers_from_credentials as Record<string, string>) ?? {}, env),
    };
    return {
      type: entry.type === 'mcp_http' ? 'http' : 'sse',
      url: install.url as string,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  // mcp_stdio
  return {
    type: 'stdio',
    command: install.command as string,
    args: (install.args as string[]) ?? [],
    env: substituteEnvTemplate((install.env_from_credentials as Record<string, string>) ?? {}, env),
  };
}

/** Replace `${FOO}` placeholders in header values with process.env.FOO. */
function substituteHeaderTemplate(tpl: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl)) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, varName: string) => env[varName] ?? '');
  }
  return out;
}

/** Same as header substitution but for env-var maps used by stdio MCPs. */
function substituteEnvTemplate(tpl: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  return substituteHeaderTemplate(tpl, env);
}
