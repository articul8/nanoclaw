#!/usr/bin/env node
/**
 * a8-claw CLI — one-command launcher for the AgentMesh conversational runtime.
 *
 *   a8-claw                  Start the host (auto-bootstrap + first-run configure)
 *   a8-claw chat MESSAGE     Send a chat message via local CLI socket
 *   a8-claw configure        Interactive (re)configuration of .env
 *   a8-claw --configure      Same, as flag
 *   a8-claw setup            Run nanoclaw setup (DB init, container build)
 *   a8-claw build            Build TypeScript
 *   a8-claw status           Show health/state
 *   a8-claw -h | --help      Show this help
 *
 * Mirrors a8-code's CLI pattern (manual arg parsing in TS, no external CLI lib)
 * for cross-runtime consistency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

import { cancel, intro, isCancel, outro, password, select, text } from '@clack/prompts';
import kleur from 'kleur';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// __dirname is dist/ after build, src/ in dev (tsx). Walk up to repo root.
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

const STAGING_WARP_URL =
  'http://a7467be8f89754f7b80eff560d5e20d0-00b1550d014a24f4.elb.us-west-2.amazonaws.com:8085';
const STAGING_MM_URL =
  'http://a667db70e77234d45ad009f6ad39ec73-1362220438.us-west-2.elb.amazonaws.com:8000';

type EnvDict = Record<string, string>;

// ─── env file IO ────────────────────────────────────────────────────

function parseEnv(content: string): EnvDict {
  const env: EnvDict = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val) env[key] = val;
  }
  return env;
}

function readEnv(): EnvDict {
  if (!fs.existsSync(ENV_PATH)) return {};
  return parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
}

/**
 * Write .env by templating .env.example — preserves comments + structure,
 * substitutes the keys we have values for.
 */
function writeEnv(updates: EnvDict): void {
  const tmpl = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const written = new Set<string>();
  const out: string[] = [];
  for (const line of tmpl.split('\n')) {
    const m = line.match(/^([A-Z_]+)=/);
    if (m && updates[m[1]] !== undefined) {
      out.push(`${m[1]}=${updates[m[1]]}`);
      written.add(m[1]);
    } else {
      out.push(line);
    }
  }
  // Append any keys not present in the template (rare; defensive)
  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k)) out.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_PATH, out.join('\n'), 'utf8');
}

function loadIntoProcessEnv(env: EnvDict): void {
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// ─── interactive configure ──────────────────────────────────────────

async function configure(): Promise<void> {
  const existing = readEnv();
  intro('a8-claw configure');

  const tenantId = await text({
    message: 'TENANT_ID',
    placeholder: 'tenant-acme',
    initialValue: existing.TENANT_ID,
    validate: (v) => (v && v.length > 0 ? undefined : 'Required (tenant-only scoping is a security breach)'),
  });
  if (isCancel(tenantId)) { cancel('configuration cancelled'); process.exit(0); }

  const userId = await text({
    message: 'USER_ID',
    placeholder: 'user-arun',
    initialValue: existing.USER_ID,
    validate: (v) => (v && v.length > 0 ? undefined : 'Required'),
  });
  if (isCancel(userId)) { cancel('configuration cancelled'); process.exit(0); }

  const route = await select({
    message: 'Main-model routing',
    options: [
      { value: 'direct', label: 'direct  (default — lower latency, runtime self-reports metering)', hint: 'recommended' },
      { value: 'model_manager', label: 'model_manager  (route via Model Manager gateway)' },
    ],
    initialValue: existing.MAIN_MODEL_ROUTE ?? 'direct',
  });
  if (isCancel(route)) { cancel('configuration cancelled'); process.exit(0); }

  let apiKey: string | undefined;
  if (route === 'direct') {
    const k = await password({
      message: 'ANTHROPIC_API_KEY (your own Anthropic key for local dev)',
      validate: (v) => (v && v.length > 0 ? undefined : 'Required when MAIN_MODEL_ROUTE=direct'),
    });
    if (isCancel(k)) { cancel('configuration cancelled'); process.exit(0); }
    apiKey = k;
  }

  const model = await text({
    message: 'Default chat model',
    initialValue: existing.DEFAULT_LLM_MODEL ?? 'claude-sonnet-4-6',
  });
  if (isCancel(model)) { cancel('configuration cancelled'); process.exit(0); }

  const useStaging = await select({
    message: 'AgentMesh platform URLs',
    options: [
      { value: 'staging', label: 'use staging-cluster ELBs (default)' },
      { value: 'custom', label: 'enter custom URLs' },
    ],
    initialValue: 'staging',
  });
  if (isCancel(useStaging)) { cancel('configuration cancelled'); process.exit(0); }

  let warpUrl = STAGING_WARP_URL;
  let mmUrl = STAGING_MM_URL;
  if (useStaging === 'custom') {
    const w = await text({ message: 'WARP_URL', initialValue: existing.WARP_URL ?? STAGING_WARP_URL });
    if (isCancel(w)) { cancel('configuration cancelled'); process.exit(0); }
    warpUrl = w;
    const m = await text({ message: 'MODEL_MANAGER_URL', initialValue: existing.MODEL_MANAGER_URL ?? STAGING_MM_URL });
    if (isCancel(m)) { cancel('configuration cancelled'); process.exit(0); }
    mmUrl = m;
  }

  const updates: EnvDict = {
    TENANT_ID: tenantId,
    USER_ID: userId,
    MAIN_MODEL_ROUTE: route,
    DEFAULT_LLM_MODEL: model,
    WARP_URL: warpUrl,
    MODEL_MANAGER_URL: mmUrl,
  };
  if (apiKey) updates.ANTHROPIC_API_KEY = apiKey;

  writeEnv(updates);
  outro(`Wrote ${ENV_PATH}`);
}

// ─── env validation ─────────────────────────────────────────────────

function validateEnv(env: EnvDict): string[] {
  const errors: string[] = [];
  for (const k of ['TENANT_ID', 'USER_ID', 'WARP_URL', 'MODEL_MANAGER_URL']) {
    if (!env[k]) errors.push(`Missing required: ${k}`);
  }
  const route = env.MAIN_MODEL_ROUTE ?? 'direct';
  if (route === 'direct' && !env.ANTHROPIC_API_KEY) {
    errors.push('MAIN_MODEL_ROUTE=direct requires ANTHROPIC_API_KEY');
  }
  return errors;
}

// ─── command runners ────────────────────────────────────────────────

function run(cmd: string, args: string[], opts: { inherit?: boolean } = {}): number {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: opts.inherit !== false ? 'inherit' : 'pipe',
    env: process.env,
  });
  return result.status ?? 1;
}

function ensureDeps(): void {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('▶  Installing dependencies (first time)...');
    if (run('pnpm', ['install']) !== 0) throw new Error('pnpm install failed');
  }
}

function ensureBuild(): void {
  const distIndex = path.join(ROOT, 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) {
    console.error('▶  Building...');
    if (run('pnpm', ['build']) !== 0) throw new Error('pnpm build failed');
  }
}

function ensureSetup(): void {
  if (!fs.existsSync(path.join(ROOT, 'data', 'v2.db'))) {
    console.error('▶  First-run setup (DB, container, channels)...');
    if (run('bash', ['setup.sh']) !== 0) throw new Error('setup.sh failed');
  }
}

// ─── subcommands ────────────────────────────────────────────────────

async function cmdStart(): Promise<void> {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('▶  No .env yet — running first-time configure');
    await configure();
  }
  const env = readEnv();
  const errors = validateEnv(env);
  if (errors.length > 0) {
    console.error('✗  .env is incomplete:');
    for (const e of errors) console.error(`    ${e}`);
    console.error('   Re-run:  ./a8-claw --configure');
    process.exit(1);
  }
  loadIntoProcessEnv(env);
  ensureDeps();
  ensureBuild();
  ensureSetup();

  console.error('');
  console.error(`✓  a8-claw starting`);
  console.error(`   tenant=${env.TENANT_ID}  user=${env.USER_ID}  route=${env.MAIN_MODEL_ROUTE ?? 'direct'}`);
  console.error(`   warp=${env.WARP_URL}`);
  console.error(`   model_manager=${env.MODEL_MANAGER_URL}`);
  console.error('');
  console.error(`   In another terminal:  ./a8-claw chat 'hello'`);
  console.error('');

  const child = spawn('pnpm', ['dev'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdChat(args: string[]): Promise<void> {
  const msg = args.join(' ');
  if (!msg) {
    console.error('Usage: a8-claw chat <message>');
    process.exit(1);
  }
  const env = readEnv();
  loadIntoProcessEnv(env);
  process.exit(run('pnpm', ['chat', msg]));
}

async function cmdSetup(): Promise<void> {
  const env = readEnv();
  loadIntoProcessEnv(env);
  ensureDeps();
  process.exit(run('bash', ['setup.sh']));
}

async function cmdBuild(): Promise<void> {
  ensureDeps();
  process.exit(run('pnpm', ['build']));
}

async function cmdStatus(): Promise<void> {
  const ok = (msg: string): void => console.log(`${kleur.green("✓")}  ${msg}`);
  const warn = (msg: string): void => console.log(`${kleur.yellow("⚠")}  ${msg}`);

  if (!fs.existsSync(ENV_PATH)) {
    warn('.env missing — run ./a8-claw to bootstrap');
    return;
  }
  ok('.env present');
  const env = readEnv();
  const errors = validateEnv(env);
  if (errors.length > 0) {
    for (const e of errors) warn(e);
  } else {
    ok(`tenant=${env.TENANT_ID} user=${env.USER_ID} route=${env.MAIN_MODEL_ROUTE ?? 'direct'}`);
  }
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) ok('node_modules present');
  else warn('deps not installed (run ./a8-claw build)');
  if (fs.existsSync(path.join(ROOT, 'dist', 'index.js'))) ok('build present');
  else warn('not built (run ./a8-claw build)');
  if (fs.existsSync(path.join(ROOT, 'data', 'v2.db'))) ok('DB present');
  else warn('DB not initialized (run ./a8-claw setup)');
  const sock = path.join(ROOT, 'data', 'cli.sock');
  if (fs.existsSync(sock)) ok(`daemon socket present (${sock})`);
  else warn(`daemon not running (no socket at ${sock})`);
}

function printHelp(): void {
  const help = `a8-claw — AgentMesh conversational runtime launcher

Usage:
  a8-claw                  Start the host (auto-bootstrap + first-run configure)
  a8-claw chat MESSAGE     Send a chat message via local CLI socket
  a8-claw configure        Interactive (re)configuration of .env
  a8-claw --configure      Same, as a flag
  a8-claw setup            Run nanoclaw setup (DB init, container build)
  a8-claw build            Build TypeScript
  a8-claw status           Show health / state
  a8-claw -h | --help      Show this help

First run: prompts you for tenant, user, API key, and routing — then writes
.env and starts the host. Re-run --configure any time to update.
`;
  console.log(help);
}

// ─── main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }
  if (args.includes('--configure') || args[0] === 'configure') {
    await configure();
    return;
  }

  const cmd = args[0] ?? 'start';
  switch (cmd) {
    case 'start':
      await cmdStart();
      break;
    case 'chat':
      await cmdChat(args.slice(1));
      break;
    case 'setup':
      await cmdSetup();
      break;
    case 'build':
      await cmdBuild();
      break;
    case 'status':
      await cmdStatus();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✗  ${msg}`);
  process.exit(1);
});
