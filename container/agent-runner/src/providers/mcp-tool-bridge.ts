/**
 * MCP-tool bridge for non-Claude providers.
 *
 * The Claude SDK has built-in MCP integration — it spawns each McpServerConfig
 * as a child process, discovers tools via `tools/list`, and dispatches calls
 * via `tools/call`. Our OpenAI / Google providers don't have that built in,
 * so this module wraps `@modelcontextprotocol/sdk`'s Client + StdioClientTransport
 * to give them the same capability:
 *
 *   const bridge = await createMcpToolBridge(mcpServers);
 *   bridge.tools  // discovered tools (qualified by server)
 *   await bridge.dispatch(qualifiedName, args)
 *   await bridge.close()
 *
 * Tool names are qualified `<serverName>__<toolName>` so multiple servers
 * with overlapping tool names don't collide. Providers translate this to
 * their own tool spec format (OpenAI function spec, Google functionDeclaration).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpServerConfig } from './types.js';

export interface BridgedTool {
  /** `<serverName>__<rawName>` — what the LLM sees (collision-safe). */
  qualifiedName: string;
  serverName: string;
  rawName: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolBridge {
  tools: BridgedTool[];
  dispatch(qualifiedName: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

const QUALIFIED_NAME_SEP = '__';

function log(msg: string): void {
  console.error(`[mcp-tool-bridge] ${msg}`);
}

/**
 * Spawn each configured MCP server, discover its tools, and return a bridge
 * for dispatching calls. Failures during connect/list for any one server are
 * logged and that server is skipped — others continue to work.
 */
export async function createMcpToolBridge(mcpServers: Record<string, McpServerConfig>): Promise<ToolBridge> {
  const clients = new Map<string, Client>();
  const tools: BridgedTool[] = [];

  for (const [serverName, cfg] of Object.entries(mcpServers)) {
    // The bridge currently only handles stdio transports (the Claude
    // SDK handles http/sse natively when the Claude provider is used).
    // openai / google providers go through this bridge, so for those
    // we skip remote MCPs with a clear log line. Future: extend bridge
    // to streamableHttp + sse transports here.
    const isStdio = !cfg.type || cfg.type === 'stdio';
    if (!isStdio) {
      log(`MCP server "${serverName}" uses ${cfg.type} transport — non-Claude providers skip it (Claude SDK handles natively).`);
      continue;
    }
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
      });
      const client = new Client({ name: 'a8-claw-provider', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const list = await client.listTools();
      for (const t of list.tools as Array<{ name: string; description?: string; inputSchema?: unknown }>) {
        tools.push({
          qualifiedName: `${serverName}${QUALIFIED_NAME_SEP}${t.name}`,
          serverName,
          rawName: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        });
      }
      clients.set(serverName, client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to connect MCP server "${serverName}": ${msg}`);
    }
  }

  log(`bridge ready: ${tools.length} tools across ${clients.size} server(s)`);

  async function dispatch(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const sepIdx = qualifiedName.indexOf(QUALIFIED_NAME_SEP);
    if (sepIdx < 0) {
      throw new Error(`[mcp-tool-bridge] qualified name missing '${QUALIFIED_NAME_SEP}' separator: ${qualifiedName}`);
    }
    const serverName = qualifiedName.slice(0, sepIdx);
    const rawName = qualifiedName.slice(sepIdx + QUALIFIED_NAME_SEP.length);
    const client = clients.get(serverName);
    if (!client) {
      throw new Error(`[mcp-tool-bridge] no live client for server "${serverName}"`);
    }
    const result = (await client.callTool({ name: rawName, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const parts = result.content ?? [];
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('');
    if (result.isError) {
      // Surface the error text without throwing — the LLM should see it as a normal
      // tool result so it can react / retry / explain to the user.
      return `[tool error] ${text || 'unknown error'}`;
    }
    return text || JSON.stringify(result);
  }

  async function close(): Promise<void> {
    for (const client of clients.values()) {
      try {
        await client.close();
      } catch {
        // Closing a transport can race with stdout buffering — best effort.
      }
    }
  }

  return { tools, dispatch, close };
}
