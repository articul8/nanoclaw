/**
 * Self-modification module — admin-approved container mutations.
 *
 * Optional tier. Depends on the approvals default module for the request/
 * handler plumbing. On install the module registers:
 *   - Two delivery actions (install_packages, add_mcp_server) that validate
 *     input and queue an approval via requestApproval().
 *   - Two matching approval handlers that run on approve and perform the
 *     complete follow-up:
 *       install_packages → update container.json, rebuild image, kill
 *         container (next wake respawns on the new image), schedule a
 *         verify-and-report follow-up prompt.
 *       add_mcp_server → update container.json, kill container. No image
 *         rebuild — bun runs TS directly, so the new MCP server is wired
 *         by the next container start.
 *
 * Without this module: the MCP tools in the container still write outbound
 * system messages with these actions, but delivery logs "Unknown system
 * action" and drops them. Admin never sees a card; nothing changes.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { applyAddMcpServer, applyAddMcpServerFromRegistry, applyInstallPackages } from './apply.js';
import {
  handleAddMcpServer,
  handleAddMcpServerFromRegistry,
  handleInstallPackages,
  handleRequestExtension,
} from './request.js';

registerDeliveryAction('install_packages', handleInstallPackages);
registerDeliveryAction('add_mcp_server', handleAddMcpServer);
// Registry-aware path — the agent's add_mcp_server with `id` form
// emits this action. Auto-approved entries skip the approval card and
// land via applyAddMcpServerFromRegistry directly. Admin/compliance
// entries route through the same approval flow as legacy add_mcp_server
// but with the registry entry attached for context.
registerDeliveryAction('add_mcp_server_from_registry', handleAddMcpServerFromRegistry);
registerDeliveryAction('request_extension', handleRequestExtension);

registerApprovalHandler('install_packages', applyInstallPackages);
registerApprovalHandler('add_mcp_server', applyAddMcpServer);
registerApprovalHandler('add_mcp_server_from_registry', applyAddMcpServerFromRegistry);
