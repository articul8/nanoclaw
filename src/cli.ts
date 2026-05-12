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
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, spawnSync } from 'child_process';

import { cancel, intro, isCancel, note, outro, password, select, text } from '@clack/prompts';
import kleur from 'kleur';

import {
  AFFIRMATION_TEXT,
  affirmationFilePath,
  isAffirmationCurrent,
  readAffirmation,
  revokeAffirmation,
  runOnboarding,
} from './onboarding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// __dirname is dist/ after build, src/ in dev (tsx). Walk up to repo root.
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

const STAGING_WARP_URL = 'http://a7467be8f89754f7b80eff560d5e20d0-00b1550d014a24f4.elb.us-west-2.amazonaws.com:8085';
const STAGING_MM_URL = 'http://a667db70e77234d45ad009f6ad39ec73-1362220438.us-west-2.elb.amazonaws.com:8000';

type EnvDict = Record<string, string>;

/** Local-dev placeholder identity. Used in offline mode (no platform connectivity). */
const LOCAL_TENANT_PREFIX = 'local-dev-tenant';

/**
 * Connection state recorded in .env and shown via status.
 *   offline    — target connected, but auth pending (first-run default; graduates via `connect`)
 *   connected  — auth resolved; platform features enabled
 *
 * Incognito was previously an install-wide third value here; it has moved
 * to `sessions.privacy` (migration 014) — set per-session, not per-install.
 * The `--incognito` CLI flag is preserved as a "default new sessions to
 * incognito for this run" hint (DEFAULT_SESSION_PRIVACY env), not as a
 * connection-state override.
 */
type ConnectionState = 'offline' | 'connected';

/** Derive a deterministic local user id from the OS user when offline. */
function localUserId(): string {
  try {
    return os.userInfo().username || process.env.USER || 'local-user';
  } catch {
    return process.env.USER || 'local-user';
  }
}

/** Local-dev placeholder tenant — clearly identifies offline / not-yet-connected sessions. */
function localTenantId(): string {
  return LOCAL_TENANT_PREFIX;
}

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
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
 * substitutes the keys we have values for. MERGES with the existing .env
 * so partial writes (e.g. from `connect` updating only TENANT_ID +
 * USER_ID + CONNECTION_STATE) don't blow away previously-configured keys
 * like the API key.
 */
function writeEnv(updates: EnvDict): void {
  const existing = readEnv();
  const merged: EnvDict = { ...existing, ...updates };
  const tmpl = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const written = new Set<string>();
  const out: string[] = [];
  for (const line of tmpl.split('\n')) {
    const m = line.match(/^([A-Z_]+)=/);
    if (m && merged[m[1]] !== undefined) {
      out.push(`${m[1]}=${merged[m[1]]}`);
      written.add(m[1]);
    } else {
      out.push(line);
    }
  }
  // Append any keys not present in the template (defensive — keeps
  // values like CONNECTION_STATE alive even if the template doesn't list them).
  for (const [k, v] of Object.entries(merged)) {
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

/**
 * Block any platform-touching subcommand until the user has signed the
 * current affirmation. First call shows the four onboarding screens +
 * captures the typed name; subsequent calls are no-ops while the hash
 * matches. Even --incognito requires the affirmation — the responsibility
 * framing is about the user, not platform telemetry.
 */
async function ensureAffirmation(): Promise<void> {
  if (isAffirmationCurrent()) return;
  await runOnboarding();
  if (!isAffirmationCurrent()) {
    // User Ctrl-C'd the prompts. Bail.
    console.error('\nAffirmation not signed — exiting.');
    process.exit(1);
  }
}

async function configure(): Promise<void> {
  await ensureAffirmation();
  const existing = readEnv();
  intro('a8-claw configure');

  // Tenant + user are PLATFORM internals — not user-facing prompts. We
  // derive offline placeholders here; the connect subcommand resolves
  // real values from the platform once auth lands. Existing values
  // (e.g. from a prior `connect`) are preserved.
  const tenantId = existing.TENANT_ID || localTenantId();
  const userId = existing.USER_ID || localUserId();
  const priorState: ConnectionState = (existing.CONNECTION_STATE as ConnectionState) || 'offline';

  // Install-wide privacy mode is gone — incognito is per-session now
  // (sessions.privacy column). Connection state is only "offline pending
  // auth" vs "connected after `./a8-claw connect`". A previously-connected
  // install stays connected; otherwise we enter offline pending.
  const connectionState: ConnectionState = priorState === 'connected' ? 'connected' : 'offline';

  const route = await select({
    message: 'Main-model routing',
    options: [
      {
        value: 'direct',
        label: 'direct  (default — lower latency, runtime self-reports metering)',
        hint: 'recommended',
      },
      { value: 'model_manager', label: 'model_manager  (route via Model Manager gateway)' },
    ],
    initialValue: existing.MAIN_MODEL_ROUTE ?? 'direct',
  });
  if (isCancel(route)) {
    cancel('configuration cancelled');
    process.exit(0);
  }

  const provider = await select({
    message: 'Main-model provider',
    options: [
      { value: 'anthropic', label: 'Anthropic  (Claude — claude-sonnet-4-6, claude-opus-4-7, …)' },
      { value: 'google', label: 'Google Gemini' },
      { value: 'openai-compat', label: 'OpenAI-compatible  (OpenAI, Together, Fireworks, Groq, vLLM, Ollama, …)' },
    ],
    initialValue: existing.MAIN_MODEL_PROVIDER ?? 'anthropic',
  });
  if (isCancel(provider)) {
    cancel('configuration cancelled');
    process.exit(0);
  }

  const PROVIDER_DEFAULTS = {
    anthropic: {
      url: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      keyHint: 'Anthropic API key (sk-ant-...)',
    },
    google: { url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', keyHint: 'Google API key' },
    'openai-compat': { url: 'https://api.openai.com', model: 'gpt-4o', keyHint: 'API key (provider-specific format)' },
  } as const;
  const defaults = PROVIDER_DEFAULTS[provider as keyof typeof PROVIDER_DEFAULTS];

  // For openai-compat we always ask the URL (custom self-hosted / Together / Fireworks etc.).
  // For anthropic / google we prefill the default but let the operator override (proxy / custom endpoint).
  const baseUrl = await text({
    message: 'Provider base URL',
    placeholder: defaults.url,
    initialValue: existing.MAIN_MODEL_BASE_URL ?? defaults.url,
  });
  if (isCancel(baseUrl)) {
    cancel('configuration cancelled');
    process.exit(0);
  }

  let apiKey: string | undefined;
  if (route === 'direct') {
    const k = await password({
      message: `MAIN_MODEL_API_KEY — ${defaults.keyHint}`,
      validate: (v) => (v && v.length > 0 ? undefined : 'Required when MAIN_MODEL_ROUTE=direct'),
    });
    if (isCancel(k)) {
      cancel('configuration cancelled');
      process.exit(0);
    }
    apiKey = k;
  }

  const model = await text({
    message: 'Default chat model',
    initialValue: existing.DEFAULT_LLM_MODEL ?? defaults.model,
  });
  if (isCancel(model)) {
    cancel('configuration cancelled');
    process.exit(0);
  }

  const useStaging = await select({
    message: 'AgentMesh platform URLs',
    options: [
      { value: 'staging', label: 'use staging-cluster ELBs (default)' },
      { value: 'custom', label: 'enter custom URLs' },
    ],
    initialValue: 'staging',
  });
  if (isCancel(useStaging)) {
    cancel('configuration cancelled');
    process.exit(0);
  }

  let warpUrl = STAGING_WARP_URL;
  let mmUrl = STAGING_MM_URL;
  if (useStaging === 'custom') {
    const w = await text({ message: 'WARP_URL', initialValue: existing.WARP_URL ?? STAGING_WARP_URL });
    if (isCancel(w)) {
      cancel('configuration cancelled');
      process.exit(0);
    }
    warpUrl = w;
    const m = await text({ message: 'MODEL_MANAGER_URL', initialValue: existing.MODEL_MANAGER_URL ?? STAGING_MM_URL });
    if (isCancel(m)) {
      cancel('configuration cancelled');
      process.exit(0);
    }
    mmUrl = m;
  }

  const updates: EnvDict = {
    TENANT_ID: tenantId,
    USER_ID: userId,
    CONNECTION_STATE: connectionState,
    MAIN_MODEL_ROUTE: route,
    MAIN_MODEL_PROVIDER: provider,
    MAIN_MODEL_BASE_URL: baseUrl,
    DEFAULT_LLM_MODEL: model,
    WARP_URL: warpUrl,
    MODEL_MANAGER_URL: mmUrl,
  };
  if (apiKey) updates.MAIN_MODEL_API_KEY = apiKey;

  writeEnv(updates);

  if (connectionState === 'offline') {
    note(
      [
        `Identity: ${kleur.dim(`${tenantId} / ${userId}`)} ${kleur.yellow('(offline placeholder)')}`,
        '',
        `Running in ${kleur.yellow('OFFLINE')} mode — chat works but platform features (memory,`,
        `audit, cross-session graph) are pending.`,
        '',
        `When you have AgentMesh credentials, run:  ${kleur.cyan('./a8-claw connect')}`,
        '',
        `For a private chat: ${kleur.cyan('./a8-claw --incognito')} (per-session, doesn't change install).`,
      ].join('\n'),
      'configured',
    );
  }
  outro(`Wrote ${ENV_PATH}`);
}

// ─── env validation ─────────────────────────────────────────────────

function validateEnv(env: EnvDict): string[] {
  const errors: string[] = [];
  for (const k of ['TENANT_ID', 'USER_ID', 'WARP_URL', 'MODEL_MANAGER_URL']) {
    if (!env[k]) errors.push(`Missing required: ${k}`);
  }
  const route = env.MAIN_MODEL_ROUTE ?? 'direct';
  if (route === 'direct') {
    // Canonical name first; legacy ANTHROPIC_API_KEY honored as fallback
    // to keep older .env files working.
    if (!env.MAIN_MODEL_API_KEY && !env.ANTHROPIC_API_KEY) {
      errors.push('MAIN_MODEL_ROUTE=direct requires MAIN_MODEL_API_KEY (or legacy ANTHROPIC_API_KEY)');
    }
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

/**
 * If the cli/local channel hasn't been wired to an agent group yet, run
 * scripts/init-cli-agent.ts to create one. The script is idempotent
 * (reuses an existing folder + DB rows). The truth is the DB, not the
 * filesystem — a leftover `groups/<name>/` directory from a previous
 * install is not the same as a wired channel→agent edge.
 *
 * Uses a quick read-only SQLite probe: WAL mode means we can read while
 * the daemon holds the writer.
 */
function isCliChannelWired(): boolean {
  const dbPath = path.join(ROOT, 'data', 'v2.db');
  if (!fs.existsSync(dbPath)) return false;
  try {
    const requireFn = createRequire(import.meta.url);
    const Database = requireFn('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          `SELECT mga.id AS id
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
           WHERE mg.channel_type = 'cli' AND mg.platform_id = 'local'
           LIMIT 1`,
        )
        .get() as { id?: string } | undefined;
      return !!row?.id;
    } finally {
      db.close();
    }
  } catch (err) {
    // If the probe itself fails (corrupt db, missing tables on a
    // pre-migration install), fall through to the init path — it's
    // idempotent and will create what's missing.
    void err;
    return false;
  }
}

function ensureCliAgent(env: EnvDict): void {
  if (isCliChannelWired()) return;

  console.error('▶  Wiring CLI channel to a fresh agent group...');
  const displayName = env.USER_ID || os.userInfo().username || 'operator';
  const status = run('pnpm', [
    'exec',
    'tsx',
    'scripts/init-cli-agent.ts',
    '--display-name',
    displayName,
    '--agent-name',
    'Claude',
  ]);
  if (status !== 0) throw new Error('init-cli-agent.ts failed');
}

// ─── subcommands ────────────────────────────────────────────────────

async function cmdStart(): Promise<void> {
  await ensureAffirmation();
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
  ensureCliAgent(env);

  // --incognito flag is now a per-session hint: it sets the default privacy
  // for sessions created during THIS invocation only. It does NOT change
  // CONNECTION_STATE or persist anything — incognito is a session-level
  // attribute (migration 014), not an install-level one.
  if (process.argv.includes('--incognito')) {
    process.env.DEFAULT_SESSION_PRIVACY = 'incognito';
  }

  // Bare `./a8-claw` is the everyday entry point — the user wants a chat
  // REPL, not a tail of daemon logs. Defer to cmdChat which supervises
  // the daemon in the background and drops us straight into the REPL.
  // For an explicit foreground daemon (debugging, systemd), use
  // `./a8-claw daemon` (handled in main()).
  await cmdChat([]);
}

/**
 * Foreground daemon — old `cmdStart` behavior. Useful when you want to
 * see live logs without going through data/daemon.log, or for service
 * managers (launchd / systemd) that expect a foreground process.
 *
 * Most users should NOT call this directly — `./a8-claw` and
 * `./a8-claw chat` auto-supervise the daemon and drop you into a REPL.
 */
async function cmdDaemonForeground(): Promise<void> {
  await ensureAffirmation();
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
  ensureCliAgent(env);

  if (process.argv.includes('--incognito')) {
    process.env.DEFAULT_SESSION_PRIVACY = 'incognito';
  }

  console.error('');
  console.error(`✓  a8-claw daemon starting (foreground)`);
  console.error(`   ${kleur.dim('logs live in this terminal — Ctrl-C to stop')}`);
  console.error('');

  const child = spawn('pnpm', ['dev'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * Authenticate with the AgentMesh platform and resolve real tenant_id +
 * user_id, replacing the offline placeholders. The platform's auth
 * endpoint isn't exposed yet — when it is, this function will POST a
 * PAT (or initiate device-code flow) and update .env on success. Today
 * it surfaces the gap and stays offline.
 */
async function cmdConnect(): Promise<void> {
  await ensureAffirmation();
  const env = readEnv();
  if (!env.WARP_URL) {
    console.error(`✗  WARP_URL not set; run ./a8-claw configure first.`);
    process.exit(1);
  }
  intro('a8-claw connect');

  // Try the platform auth endpoint. v1 stub: assume POST {WARP_URL}/auth/whoami
  // with Bearer PAT returns {tenant_id, user_id}. If endpoint absent, fail
  // gracefully and stay offline.
  const pat = await password({
    message: 'AgentMesh PAT (paste from platform settings, or empty to cancel)',
  });
  if (isCancel(pat) || !pat) {
    cancel('connect cancelled — staying offline');
    return;
  }

  const url = `${env.WARP_URL.replace(/\/+$/, '')}/auth/whoami`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pat}` },
      body: JSON.stringify({}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note(
      [
        kleur.yellow('Could not reach the platform auth endpoint:'),
        `  ${msg}`,
        '',
        `Staying ${kleur.yellow('OFFLINE')}. Pending work will sync when the platform is reachable.`,
      ].join('\n'),
      'no platform connectivity',
    );
    outro('offline mode');
    return;
  }

  if (resp.status === 404) {
    note(
      [
        kleur.yellow('The platform auth endpoint is not yet exposed by Warp.'),
        '',
        `Tried:  ${kleur.dim(url)}`,
        '',
        'Staying offline. The runtime tags work as "first-connect-pending"',
        'and will refresh tenant + user identity on the first successful connect.',
      ].join('\n'),
      'auth endpoint pending',
    );
    outro('offline mode');
    return;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    cancel(`auth failed: ${resp.status} ${resp.statusText}  ${text.slice(0, 200)}`);
    return;
  }

  const data = (await resp.json()) as { tenant_id?: string; user_id?: string };
  if (!data.tenant_id || !data.user_id) {
    cancel(`auth response missing tenant_id / user_id: ${JSON.stringify(data)}`);
    return;
  }

  // Persist resolved identity. PAT not stored on disk — re-prompted next connect.
  writeEnv({
    TENANT_ID: data.tenant_id,
    USER_ID: data.user_id,
    CONNECTION_STATE: 'connected',
  });
  outro(`connected as ${data.tenant_id} / ${data.user_id}`);
}

async function cmdChat(args: string[]): Promise<void> {
  await ensureAffirmation();
  // Configure if no .env yet — chat with no setup is a non-starter.
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
  // Make sure the daemon will have a CLI agent wired when it boots.
  ensureDeps();
  ensureBuild();
  ensureSetup();
  ensureCliAgent(env);

  // Lazy import — keeps repl.ts off the hot path of other subcommands.
  const { runOneShot, runRepl } = await import('./repl.js');
  const msg = args.join(' ').trim();
  if (msg) {
    process.exit(await runOneShot(msg));
  } else {
    process.exit(await runRepl());
  }
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

/**
 * Revoke the persisted affirmation. Next start re-shows the four
 * onboarding screens and re-prompts for a typed-name signature.
 */
function cmdRevokeAffirmation(): void {
  const removed = revokeAffirmation();
  if (removed) {
    console.log(`${kleur.green('✓')}  Affirmation revoked. Next start will re-prompt onboarding.`);
  } else {
    console.log(`${kleur.yellow('⚠')}  No affirmation on file at ${affirmationFilePath()}.`);
  }
}

async function cmdStatus(): Promise<void> {
  const ok = (msg: string): void => console.log(`${kleur.green('✓')}  ${msg}`);
  const warn = (msg: string): void => console.log(`${kleur.yellow('⚠')}  ${msg}`);

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
    const cs = (env.CONNECTION_STATE as ConnectionState) ?? 'offline';
    if (cs === 'connected') {
      ok(`connected — tenant=${env.TENANT_ID} user=${env.USER_ID}`);
    } else {
      warn(
        `OFFLINE — using local placeholder identity (${env.TENANT_ID} / ${env.USER_ID}); run ./a8-claw connect to authenticate`,
      );
    }
    ok(
      `route=${env.MAIN_MODEL_ROUTE ?? 'direct'} provider=${env.MAIN_MODEL_PROVIDER ?? 'anthropic'} model=${env.DEFAULT_LLM_MODEL ?? 'claude-sonnet-4-6'}`,
    );
  }
  // Affirmation status
  const aff = readAffirmation();
  if (aff) {
    if (isAffirmationCurrent()) {
      ok(`affirmation signed by ${aff.signed_by_typed_name} on ${aff.signed_at_utc.slice(0, 10)}`);
    } else {
      warn(`affirmation outdated (text changed) — next start re-prompts`);
    }
  } else {
    warn(`affirmation not signed — first start runs onboarding`);
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
  a8-claw                       Open a chat REPL (first-run: onboarding → configure)
  a8-claw chat                  Same — open the REPL
  a8-claw chat MESSAGE          One-shot: send a message and print the reply
  a8-claw --incognito           Default new sessions in this run to INCOGNITO (per-session, not install-wide)
  a8-claw configure             Interactive configuration (provider, key, model)
  a8-claw --configure           Same, as a flag
  a8-claw connect               Authenticate with the AgentMesh platform
  a8-claw revoke-affirmation    Clear the signed affirmation; next start re-onboards
  a8-claw setup                 Run nanoclaw setup (DB init, container build)
  a8-claw build                 Build TypeScript
  a8-claw status                Show health, connection state, affirmation status
  a8-claw add [id]              Browse / install extensions (channels, MCPs, tools)
  a8-claw list [category]       Show installed + available extensions
  a8-claw daemon                Run the host daemon in the foreground (debugging only)
  a8-claw -h | --help           Show this help

Connection states (set during configure / connect):
  offline     auth pending; chat works, platform features dormant. Default at first run.
  connected   auth resolved; memory, audit, metering, dashboard live.

Privacy is PER-SESSION (not install-wide). Each session has its own privacy
flag — 'normal' (default, fleet-visible, resumable) or 'incognito' (no
platform calls scoped to this session ever leave the runtime). Use the
--incognito flag at launch to make new sessions in this run default to
incognito.

First run: walks through four onboarding screens (welcome / when-to-use /
security / responsibility) and asks you to sign a typed-name affirmation
before any configure prompt. Recorded at ~/.a8/affirmations/a8-claw.json
with the current text's sha256, so any future amendment re-prompts.
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
  if (args[0] === 'connect') {
    await cmdConnect();
    return;
  }
  if (args[0] === 'revoke-affirmation') {
    cmdRevokeAffirmation();
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
    case 'daemon':
      await cmdDaemonForeground();
      break;
    case 'add': {
      const { cmdAdd } = await import('./cli-add.js');
      await cmdAdd(args.slice(1));
      break;
    }
    case 'list':
    case 'ls': {
      const { cmdList } = await import('./cli-add.js');
      await cmdList(args.slice(1));
      break;
    }
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
