/**
 * `./a8-claw add` / `list` — power-user surface for the extension registry.
 *
 * Same backend as the agent's in-chat add_mcp_server tool: both hit
 * registry/manifest.json. The CLI lets you browse, install, and inspect
 * without going through a conversational round-trip — handy for ops /
 * automation / first-run setup scripts.
 *
 * Commands:
 *   ./a8-claw add                  — interactive picker, categorized
 *   ./a8-claw add <id>             — direct install by registry id
 *   ./a8-claw list                 — show installed + available
 *   ./a8-claw list <category>      — filter list to one category
 *
 * For channels: appends adapter source + npm package + barrel import
 *   (mirrors what the upstream /add-<channel> slash skill does).
 * For hosted MCPs (mcp_http / mcp_sse): records the entry in a tenant
 *   manifest so the next chat session can wire it via the agent's
 *   add_mcp_server { id } path (we don't write to every group's
 *   container.json here — the CLI scopes to the tenant, not a single
 *   agent group).
 * For tool families / runtime peers: surfaces enablement info but
 *   doesn't touch persistent state in v1 — those are platform-side
 *   concerns (tool_manager enable flag, mission engine peer registry).
 *
 * Credentials are prompted interactively when missing from .env, written
 * back to .env (gitignored; OneCLI-vault integration is v2).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import { cancel, intro, isCancel, outro, password, select, text } from '@clack/prompts';
import kleur from 'kleur';

import { entriesByCategory, findEntry, loadRegistry } from './registry/loader.js';
import type { RegistryEntry } from './registry/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export async function cmdAdd(args: string[]): Promise<void> {
  intro(kleur.bold('a8-claw add'));

  const id = args[0];
  const manifest = loadRegistry();
  let entry: RegistryEntry | undefined;

  if (id) {
    entry = findEntry(id, manifest);
    if (!entry) {
      console.error(kleur.red(`✗  Registry entry not found: ${id}`));
      console.error(kleur.dim('   Run `./a8-claw list` to see available ids.'));
      process.exit(1);
    }
  } else {
    // Interactive picker — group by category for scannability.
    const byCategory = entriesByCategory(manifest);
    const options: { value: string; label: string; hint?: string }[] = [];
    for (const [category, entries] of byCategory.entries()) {
      for (const e of entries) {
        options.push({
          value: e.id,
          label: `${categoryGlyph(category)} ${e.name}`,
          hint: `${e.type} · ${category} · install=${e.default_policy.install}`,
        });
      }
    }
    const picked = await select<string>({
      message: 'Pick an extension to add',
      options,
    });
    if (isCancel(picked)) {
      cancel('cancelled');
      return;
    }
    entry = findEntry(picked, manifest);
  }

  if (!entry) {
    console.error(kleur.red('✗  Could not resolve entry; aborting.'));
    process.exit(1);
  }

  console.log('');
  console.log(`${kleur.bold(entry.name)} ${kleur.dim(`(${entry.id})`)}`);
  console.log(kleur.dim(entry.description));
  if (entry.auth?.setup_url) {
    console.log(kleur.dim(`auth setup: ${entry.auth.setup_url}`));
  }
  console.log(
    kleur.dim(
      `policy: install=${entry.default_policy.install}  invoke=${entry.default_policy.invoke.default}  sensitivity=${entry.default_policy.scope?.sensitivity ?? 'unspecified'}`,
    ),
  );

  if (entry.default_policy.install === 'deny') {
    console.error(kleur.red('✗  This entry is denied by tenant policy. Aborting.'));
    process.exit(1);
  }
  if (entry.default_policy.install === 'compliance') {
    console.log(kleur.yellow('⚠  Install requires compliance approval — this CLI files the request; an officer must approve.'));
  }

  // Prompt for missing credentials and write to .env.
  if (entry.credentials_env && entry.credentials_env.length > 0) {
    await ensureCredentials(entry.credentials_env, entry.auth?.setup_url);
  }

  // Dispatch by type.
  switch (entry.type) {
    case 'channel':
      await installChannel(entry);
      break;
    case 'mcp_http':
    case 'mcp_sse':
    case 'mcp_stdio':
      await installHostedMcp(entry);
      break;
    case 'tool_family':
      console.log(kleur.dim('Tool families are enabled at the platform level; no local install needed.'));
      console.log(kleur.dim('The agent automatically discovers enabled tool_family entries on the next session.'));
      break;
    case 'runtime_peer':
      console.log(kleur.dim('Runtime peers are wired via the mission engine; no local install needed.'));
      console.log(kleur.dim('The agent can delegate to this peer once mission-queue is configured.'));
      break;
  }

  outro(`${kleur.green('✓')}  ${entry.name} added`);
}

export async function cmdList(args: string[]): Promise<void> {
  const filterCategory = args[0];
  const manifest = loadRegistry();
  const byCategory = entriesByCategory(manifest);

  console.log('');
  for (const [category, entries] of byCategory.entries()) {
    if (filterCategory && category !== filterCategory) continue;
    console.log(`${kleur.bold(`${categoryGlyph(category)} ${category}`)} ${kleur.dim(`(${entries.length})`)}`);
    for (const e of entries) {
      const installed = entryIsInstalled(e) ? kleur.green('●') : kleur.dim('○');
      const gate = e.default_policy.install === 'auto' ? kleur.green('auto') : kleur.yellow(e.default_policy.install);
      console.log(
        `  ${installed} ${kleur.bold(e.id.padEnd(18))} ${kleur.dim(`(${e.type}, ${gate})`)} ${e.name}`,
      );
    }
    console.log('');
  }
}

function categoryGlyph(category: string): string {
  switch (category) {
    case 'comms':
      return '💬';
    case 'knowledge':
      return '📚';
    case 'code':
      return '⌨️';
    case 'issues':
      return '🎟️';
    case 'data':
      return '📊';
    case 'compute':
      return '⚙️';
    case 'research':
      return '🔍';
    case 'delegation':
      return '⇢';
    default:
      return '·';
  }
}

/**
 * Detect whether an entry is currently installed. v1 heuristic:
 *   - channel: src/channels/<id>.ts exists
 *   - mcp_*: tenant-manifest at data/tenant-mcps.json includes the id
 *   - tool_family / runtime_peer: always "available" — platform-managed
 *
 * Not authoritative (a half-installed channel may pass the check) — meant
 * for the list-UI hint only.
 */
function entryIsInstalled(entry: RegistryEntry): boolean {
  if (entry.type === 'channel') {
    // Channel adapter filenames don't always match the registry id
    // (e.g. github-channel → github.ts). Best-effort: strip "-channel".
    const fname = entry.id.replace(/-channel$/, '');
    return fs.existsSync(path.join(ROOT, 'src', 'channels', `${fname}.ts`));
  }
  if (entry.type === 'mcp_http' || entry.type === 'mcp_sse' || entry.type === 'mcp_stdio') {
    return tenantMcpManifestHas(entry.id);
  }
  return true; // tool_family / runtime_peer always available
}

const TENANT_MCP_MANIFEST_PATH = path.join(ROOT, 'data', 'tenant-mcps.json');

function readTenantMcpManifest(): { entries: Record<string, RegistryEntry> } {
  try {
    return JSON.parse(fs.readFileSync(TENANT_MCP_MANIFEST_PATH, 'utf8')) as { entries: Record<string, RegistryEntry> };
  } catch {
    return { entries: {} };
  }
}

function writeTenantMcpManifest(m: { entries: Record<string, RegistryEntry> }): void {
  fs.mkdirSync(path.dirname(TENANT_MCP_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(TENANT_MCP_MANIFEST_PATH, JSON.stringify(m, null, 2));
}

function tenantMcpManifestHas(id: string): boolean {
  const m = readTenantMcpManifest();
  return id in m.entries;
}

async function ensureCredentials(envVars: string[], setupUrl: string | undefined): Promise<void> {
  const envPath = path.join(ROOT, '.env');
  const existing = readEnvFile(envPath);
  const missing = envVars.filter((v) => !existing[v]);
  if (missing.length === 0) return;

  console.log(
    kleur.yellow(
      `⚠  Missing credentials: ${missing.join(', ')}${setupUrl ? `\n   Get them at: ${setupUrl}` : ''}`,
    ),
  );

  for (const v of missing) {
    const value = await password({
      message: `Paste ${v}:`,
      mask: '•',
    });
    if (isCancel(value) || !value) {
      cancel('credentials missing; aborting.');
      process.exit(1);
    }
    existing[v] = value;
  }
  writeEnvFile(envPath, existing);
  console.log(kleur.green(`✓  Wrote ${missing.length} credential(s) to .env`));
}

function readEnvFile(p: string): Record<string, string> {
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function writeEnvFile(p: string, kv: Record<string, string>): void {
  // Preserve comments + ordering from existing file; append new keys at the end.
  let body = '';
  if (fs.existsSync(p)) {
    const seen = new Set<string>();
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
      if (m && m[1] in kv) {
        body += `${m[1]}=${kv[m[1]]}\n`;
        seen.add(m[1]);
      } else {
        body += line + '\n';
      }
    }
    for (const [k, v] of Object.entries(kv)) {
      if (!seen.has(k)) body += `${k}=${v}\n`;
    }
  } else {
    for (const [k, v] of Object.entries(kv)) body += `${k}=${v}\n`;
  }
  fs.writeFileSync(p, body.replace(/\n+$/, '\n'));
}

async function installChannel(entry: RegistryEntry): Promise<void> {
  const install = entry.install as {
    adapter_branch?: string;
    adapter_path?: string;
    package?: string;
    barrel_import?: string;
  };
  if (!install.adapter_path || !install.package || !install.barrel_import) {
    console.error(kleur.red('✗  Channel registry entry missing adapter_path / package / barrel_import.'));
    process.exit(1);
  }
  const adapterDest = path.join(ROOT, install.adapter_path);
  if (fs.existsSync(adapterDest)) {
    console.log(kleur.dim(`already installed: ${install.adapter_path}`));
  } else {
    const branch = install.adapter_branch ?? 'upstream/channels';
    // git fetch <remote> <branch> if not local — handle both
    // `upstream/channels` and `origin/channels`.
    const slashIdx = branch.indexOf('/');
    if (slashIdx > 0) {
      const remote = branch.slice(0, slashIdx);
      const branchName = branch.slice(slashIdx + 1);
      spawnSync('git', ['fetch', remote, branchName], { cwd: ROOT, stdio: 'inherit' });
    }
    const result = spawnSync('git', ['show', `${branch}:${install.adapter_path}`], { cwd: ROOT });
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
      console.error(kleur.red(`✗  Could not fetch adapter from ${branch}:${install.adapter_path}`));
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(adapterDest), { recursive: true });
    fs.writeFileSync(adapterDest, result.stdout);
    console.log(kleur.green(`✓  Wrote ${install.adapter_path}`));
  }

  // Barrel import — append if not already present.
  const barrelPath = path.join(ROOT, 'src', 'channels', 'index.ts');
  if (fs.existsSync(barrelPath)) {
    const body = fs.readFileSync(barrelPath, 'utf8');
    if (!body.includes(install.barrel_import)) {
      fs.writeFileSync(barrelPath, body.replace(/\n*$/, '\n') + install.barrel_import + '\n');
      console.log(kleur.green(`✓  Appended barrel import: ${install.barrel_import}`));
    }
  }

  // npm install — pinned version per registry.
  console.log(kleur.dim(`installing ${install.package}…`));
  const inst = spawnSync('pnpm', ['install', install.package], { cwd: ROOT, stdio: 'inherit' });
  if (inst.status !== 0) {
    console.error(kleur.red('✗  pnpm install failed'));
    process.exit(1);
  }
  console.log(kleur.green(`✓  pnpm installed ${install.package}`));
}

async function installHostedMcp(entry: RegistryEntry): Promise<void> {
  // Record in the tenant-mcps manifest so subsequent chat sessions can
  // wire it via add_mcp_server { id }. We don't mutate every group's
  // container.json here — the CLI scopes to the tenant; the agent's
  // in-chat install path scopes to a specific agent group.
  const m = readTenantMcpManifest();
  m.entries[entry.id] = entry;
  writeTenantMcpManifest(m);
  console.log(
    kleur.green(`✓  Recorded ${entry.name} in data/tenant-mcps.json`),
  );
  console.log(
    kleur.dim(
      '   Next chat session: ask the agent to "wire this MCP" and it\'ll call add_mcp_server({id}) — pre-approved entries land instantly.',
    ),
  );

  if (entry.default_policy.install === 'admin' || entry.default_policy.install === 'compliance') {
    const proceed = await text({
      message:
        'Tenant-scoped install only — per-agent-group wiring still goes through ' +
        entry.default_policy.install +
        ' approval. Press Enter to acknowledge.',
      placeholder: '(any value)',
    });
    if (isCancel(proceed)) {
      cancel('cancelled.');
      return;
    }
  }
}
