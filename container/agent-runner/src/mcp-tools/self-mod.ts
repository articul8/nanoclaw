/**
 * Self-modification MCP tools: install_packages, add_mcp_server,
 * list_extensions, request_extension.
 *
 * Together these are the agent's interface for extending its own
 * capability surface during a conversation. The user says "wire
 * Notion" / "install Linear MCP" / "add a Foursquare integration" and
 * the agent picks the right tool here.
 *
 * Registry-aware path:
 *   - `list_extensions` returns the curated catalog (channels, hosted
 *     MCPs, tool families, runtime peers) the agent can offer without
 *     a developer in the loop.
 *   - `add_mcp_server` accepts a registry `id` and populates the
 *     config from the manifest. Approval policy is the entry's
 *     `default_policy.install` (auto / admin / compliance / deny).
 *     Pre-approved entries (`auto`) skip the approval DM and apply
 *     directly — only the narration + audit row land.
 *   - `request_extension` is the escape hatch for unregistered asks;
 *     it files a `pending_extensions` row + DMs admin with the
 *     justification so the operator can add a vetted entry.
 *
 * Both narration (live render) and audit (mission_events ledger) fire
 * on every code path per the transparency directive.
 */
import { writeMissionEvent } from '../audit.js';
import { writeMessageOut } from '../db/messages-out.js';
import { narrate } from '../live-render.js';
import { allEntries, findEntry, type RegistryEntry } from '../registry.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install (names only, no version specs or flags)' },
        npm: { type: 'array', items: { type: 'string' }, description: 'npm packages to install globally (names only, no version specs)' },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt) return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const reason = (args.reason as string) || '';
    const summary = `Requesting ${apt.length + npm.length} package(s)${reason ? ` — ${reason}` : ''}; admin approval pending.`;
    narrate(summary, 'install');
    void writeMissionEvent({
      event_kind: 'tool_call',
      payload: { tool_name: 'install_packages', success: true, apt, npm, reason },
      rationale: summary,
      narration_category: 'install',
    });

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason,
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

/**
 * add_mcp_server now accepts two shapes:
 *
 *   { id: "notion" }                                  ← registry-aware (preferred)
 *   { name, command, args, env }                      ← raw stdio config (legacy/custom)
 *
 * Registry path looks up the entry, resolves credentials, derives the
 * McpServerConfig from install info, and honors the entry's
 * default_policy.install gate (auto / admin / compliance / deny).
 *
 * Raw path is unchanged — uses existing admin-approval flow.
 */
export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire a third-party MCP server into YOUR per-agent runtime. Preferred form: pass `id` from the registry (call `list_extensions` first to see what\'s available — pre-approved entries apply automatically). Fallback form: pass `name` + `command` + `args` + `env` for a custom stdio MCP not in the registry (requires admin approval).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Registry id (preferred). See list_extensions for available ids.' },
        name: { type: 'string', description: 'MCP server name (custom path only).' },
        command: { type: 'string', description: 'Command to run the MCP server (custom path only).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (custom path only).' },
        env: { type: 'object', description: 'Environment variables for the server (custom path only).' },
        reason: { type: 'string', description: 'Brief justification (user-facing) for why this extension is being added.' },
      },
    },
  },
  async handler(args) {
    const id = args.id as string | undefined;
    const reason = (args.reason as string) || '';

    // Registry path — preferred.
    if (id) {
      const entry = findEntry(id);
      if (!entry) {
        return err(`Registry entry not found: "${id}". Call list_extensions for available ids, or use request_extension for a new one.`);
      }
      const gate = entry.default_policy.install;
      if (gate === 'deny') {
        const msg = `"${entry.name}" is blocked by this tenant's policy. I can't enable it.`;
        narrate(msg, 'install');
        void writeMissionEvent({
          event_kind: 'tool_call',
          payload: { tool_name: 'add_mcp_server', registry_id: id, success: false, denied_by_policy: true },
          rationale: msg,
          narration_category: 'install',
        });
        return err(msg);
      }

      const requestId = generateId();
      if (gate === 'auto') {
        // Pre-vetted — apply immediately, narrate, no approval DM.
        const intent = `Wiring ${entry.name} — pre-approved, no admin needed.${reason ? ` (${reason})` : ''}`;
        narrate(intent, 'install');
        void writeMissionEvent({
          event_kind: 'tool_call',
          payload: {
            tool_name: 'add_mcp_server',
            registry_id: id,
            entry_type: entry.type,
            success: true,
            gate: 'auto',
          },
          rationale: intent,
          narration_category: 'install',
        });
        writeMessageOut({
          id: requestId,
          kind: 'system',
          content: JSON.stringify({
            action: 'add_mcp_server_from_registry',
            registry_id: id,
            entry: entry, // host applies entry.install + entry.credentials_env
            auto: true,
            reason,
          }),
        });
        log(`add_mcp_server (auto): ${requestId} → ${entry.name} [${id}]`);
        return ok(`Wiring ${entry.name} now (pre-approved). It'll be available next message.`);
      }

      // Admin / compliance — file an approval request, narrate the wait.
      const intent =
        gate === 'compliance'
          ? `Asking compliance + admin to approve adding ${entry.name} — won't proceed until they answer.`
          : `Asking your admin to approve adding ${entry.name} — won't proceed until they answer.`;
      narrate(intent, 'approval');
      void writeMissionEvent({
        event_kind: 'tool_call',
        payload: {
          tool_name: 'add_mcp_server',
          registry_id: id,
          entry_type: entry.type,
          success: true,
          gate,
        },
        rationale: intent,
        narration_category: 'approval',
      });
      writeMessageOut({
        id: requestId,
        kind: 'system',
        content: JSON.stringify({
          action: 'add_mcp_server_from_registry',
          registry_id: id,
          entry: entry,
          auto: false,
          gate,
          reason,
        }),
      });
      log(`add_mcp_server (${gate}): ${requestId} → ${entry.name} [${id}]`);
      return ok(`Request submitted for ${entry.name}. You'll be notified when ${gate === 'compliance' ? 'compliance' : 'an admin'} approves.`);
    }

    // Custom path — legacy, still admin-gated.
    const name = args.name as string;
    const command = args.command as string;
    if (!name || !command) {
      return err('Provide either `id` (from list_extensions) or both `name` + `command` (custom MCP).');
    }
    const intent = `Asking your admin to approve adding custom MCP "${name}" (${command}).`;
    narrate(intent, 'approval');
    void writeMissionEvent({
      event_kind: 'tool_call',
      payload: { tool_name: 'add_mcp_server', name, custom: true, success: true, gate: 'admin' },
      rationale: intent,
      narration_category: 'approval',
    });
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        command,
        args: (args.args as string[]) || [],
        env: (args.env as Record<string, string>) || {},
        reason,
      }),
    });
    log(`add_mcp_server (custom): ${requestId} → "${name}" (${command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

/**
 * Catalog discovery — agent calls this when the user asks "what can
 * you do?" or "what tools are available?". Returns a compact list the
 * agent can summarize. Each entry surfaces id, type, name, category,
 * description, install_gate so the agent can tell the user upfront if
 * something needs admin approval.
 */
export const listExtensions: McpToolDefinition = {
  tool: {
    name: 'list_extensions',
    description:
      'List the curated catalog of extensions you can wire (channels, hosted MCPs, tool families, runtime peers). Use this to answer "what can you do?" and to find the right `id` to pass to add_mcp_server. Returns id, name, category, description, install gate per entry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Optional filter: comms, knowledge, code, issues, data, compute, research, delegation, …' },
        type: {
          type: 'string',
          description: 'Optional filter by type: channel, mcp_http, mcp_sse, mcp_stdio, tool_family, runtime_peer',
        },
      },
    },
  },
  async handler(args) {
    const filterCategory = args.category as string | undefined;
    const filterType = args.type as string | undefined;
    let entries: RegistryEntry[] = allEntries();
    if (entries.length === 0) {
      return ok(
        'No extension registry available in this environment. You can still add a custom MCP via add_mcp_server { name, command, args, env }.',
      );
    }
    if (filterCategory) entries = entries.filter((e) => e.category === filterCategory);
    if (filterType) entries = entries.filter((e) => e.type === filterType);
    const lines = entries.map(
      (e) =>
        `- ${e.id} (${e.type}, ${e.category}, install=${e.default_policy.install}): ${e.name} — ${e.description}`,
    );
    return ok(`${entries.length} extension(s) available:\n${lines.join('\n')}`);
  },
};

/**
 * Escape hatch for asks the registry doesn't cover. The agent files a
 * pending_extensions row + DMs admin with a free-text justification.
 * Operator then adds the entry to the registry (or rejects). Captures
 * demand signal — useful for prioritizing which integrations to vet
 * next.
 */
export const requestExtension: McpToolDefinition = {
  tool: {
    name: 'request_extension',
    description:
      'Ask your admin to add a new extension (channel / MCP / tool family / runtime peer) that ISN\'T in the registry. Use this when list_extensions doesn\'t show what the user asked for. Free-text justification; admin gets a DM with your request.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-friendly name (e.g. "Foursquare", "Datadog MCP")' },
        type: {
          type: 'string',
          description: 'Best-guess type: channel, mcp_http, mcp_sse, mcp_stdio, tool_family, runtime_peer',
        },
        url_or_command: { type: 'string', description: 'Best-known URL (for hosted MCP) or command (for stdio MCP)' },
        why: { type: 'string', description: 'Why the user needs this — drives admin prioritization.' },
      },
      required: ['name', 'why'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const why = args.why as string;
    const type = (args.type as string) || 'unknown';
    const urlOrCommand = (args.url_or_command as string) || '';
    if (!name || !why) return err('Both `name` and `why` are required.');

    const intent = `Asking your admin to add "${name}" (${type}) to the registry — ${why}`;
    narrate(intent, 'approval');
    void writeMissionEvent({
      event_kind: 'tool_call',
      payload: { tool_name: 'request_extension', name, type, url_or_command: urlOrCommand, why, success: true },
      rationale: intent,
      narration_category: 'approval',
    });

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_extension',
        name,
        type,
        url_or_command: urlOrCommand,
        why,
      }),
    });
    log(`request_extension: ${requestId} → "${name}" (${type})`);
    return ok(`Sent your admin a request for "${name}". I'll let you know if they vet and add it.`);
  },
};

registerTools([installPackages, addMcpServer, listExtensions, requestExtension]);
