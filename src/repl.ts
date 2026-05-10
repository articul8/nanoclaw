/**
 * Chat REPL + daemon supervision for a8-claw.
 *
 * Two entry points:
 *   - runOneShot(text)  — send one message, print replies, exit (used by
 *                         `./a8-claw chat "<message>"` for scripting)
 *   - runRepl()         — interactive multi-turn loop with slash commands
 *                         (used by `./a8-claw chat` with no args)
 *
 * Both auto-start the host daemon in the background if cli.sock isn't
 * reachable, then connect over Unix socket to send / stream replies.
 *
 * Slash commands (REPL only):
 *   /help            — list commands
 *   /security        — re-show the SECURITY screen from onboarding
 *   /responsibility  — re-show the WHY THIS EXISTS screen
 *   /when            — re-show the WHEN TO USE WHAT screen
 *   /affirmation     — show your signed affirmation record
 *   /exit (or /quit) — leave the REPL (daemon stays running)
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import kleur from 'kleur';

import { readAffirmation, SCREEN_RESPONSIBILITY, SCREEN_SECURITY, SCREEN_WHEN } from './onboarding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SOCKET_PATH = path.join(ROOT, 'data', 'cli.sock');

const DAEMON_BOOT_TIMEOUT_MS = 30_000;
const ONESHOT_FIRST_REPLY_TIMEOUT_MS = 60_000;
const ONESHOT_SILENCE_MS = 2_000;

// ─── Socket reachability + daemon supervision ──────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quick connect-then-disconnect probe. Resolves true if socket accepts a connection. */
function isSocketReachable(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(p)) {
      resolve(false);
      return;
    }
    const sock = net.connect(p);
    const cleanup = (ok: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once('error', () => cleanup(false));
    sock.once('connect', () => cleanup(true));
    setTimeout(() => cleanup(false), 1_000);
  });
}

/**
 * If the daemon socket isn't reachable, spawn `pnpm dev` detached, redirect
 * its output to data/daemon.log, and poll until cli.sock comes up. Throws
 * after DAEMON_BOOT_TIMEOUT_MS.
 *
 * Notably this does NOT propagate process.env.CONNECTION_STATE etc — the
 * daemon reads .env on its own at startup. We just need it running.
 */
export async function ensureDaemon(): Promise<{ started: boolean; pid?: number }> {
  if (await isSocketReachable(SOCKET_PATH)) return { started: false };

  console.error(kleur.dim('▸ daemon not running — starting in background...'));
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(dataDir, 'daemon.log');
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const child = spawn('pnpm', ['dev'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });
  child.unref();
  const pid = child.pid;

  const start = Date.now();
  while (Date.now() - start < DAEMON_BOOT_TIMEOUT_MS) {
    if (await isSocketReachable(SOCKET_PATH)) {
      console.error(kleur.dim(`▸ daemon up (pid ${pid}, log: ${logPath})`));
      return { started: true, pid };
    }
    await sleep(500);
  }
  throw new Error(
    `daemon failed to start within ${DAEMON_BOOT_TIMEOUT_MS}ms — see ${logPath} for details`,
  );
}

// ─── Reply parser (shared) ──────────────────────────────────────────

interface SocketReader {
  /** Forward each agent reply line (already JSON-parsed) to the handler. */
  onReply(handler: (text: string) => void): void;
}

function attachReader(socket: net.Socket): SocketReader {
  let buffer = '';
  let handler: ((text: string) => void) | null = null;
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { text?: unknown };
        if (typeof msg.text === 'string' && handler) handler(msg.text);
      } catch {
        // Ignore non-JSON lines — forward compatibility.
      }
    }
  });
  return {
    onReply(h) {
      handler = h;
    },
  };
}

// ─── One-shot mode ──────────────────────────────────────────────────

export async function runOneShot(text: string): Promise<number> {
  await ensureDaemon();
  return new Promise((resolve) => {
    const socket = net.connect(SOCKET_PATH);
    const reader = attachReader(socket);

    let firstReply = false;
    let silenceTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;

    const exit = (code: number): void => {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      socket.end();
      resolve(code);
    };

    socket.on('error', (e: NodeJS.ErrnoException) => {
      console.error(kleur.red('socket error:'), e.message);
      exit(2);
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify({ text }) + '\n');
      hardTimer = setTimeout(() => {
        if (!firstReply) {
          console.error(kleur.red(`timeout: no reply in ${ONESHOT_FIRST_REPLY_TIMEOUT_MS}ms`));
          exit(3);
        }
      }, ONESHOT_FIRST_REPLY_TIMEOUT_MS);
    });

    reader.onReply((replyText) => {
      process.stdout.write(replyText + '\n');
      firstReply = true;
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => exit(0), ONESHOT_SILENCE_MS);
    });

    socket.on('close', () => exit(firstReply ? 0 : 3));
  });
}

// ─── REPL mode ──────────────────────────────────────────────────────

const REPL_HELP = `
${kleur.bold('a8-claw REPL commands')}
  /help            list these commands
  /security        re-show the security principles
  /responsibility  re-show the why-this-exists / responsibility framing
  /when            re-show when to use a8-claw vs a8-code
  /affirmation     show your signed affirmation record
  /exit | /quit    leave the REPL (daemon keeps running)

  anything else    sent to the agent
`.trim();

function showAffirmation(): void {
  const rec = readAffirmation();
  if (!rec) {
    console.log(kleur.yellow('no affirmation on file'));
    return;
  }
  console.log(`${kleur.green('signed')} by ${rec.signed_by_typed_name}`);
  console.log(`  at      ${rec.signed_at_utc}`);
  console.log(`  host    ${rec.machine_hostname}`);
  console.log(`  os user ${rec.os_user}`);
  console.log(`  hash    ${rec.affirmation_text_sha256.slice(0, 16)}…`);
  console.log(`  version ${rec.affirmation_version}`);
}

function handleSlash(cmd: string): { handled: boolean; exit?: boolean } {
  const norm = cmd.trim().toLowerCase();
  switch (norm) {
    case '/help':
    case '/?':
      console.log('\n' + REPL_HELP + '\n');
      return { handled: true };
    case '/security':
      console.log('\n' + SCREEN_SECURITY + '\n');
      return { handled: true };
    case '/responsibility':
      console.log('\n' + SCREEN_RESPONSIBILITY + '\n');
      return { handled: true };
    case '/when':
      console.log('\n' + SCREEN_WHEN + '\n');
      return { handled: true };
    case '/affirmation':
      console.log();
      showAffirmation();
      console.log();
      return { handled: true };
    case '/exit':
    case '/quit':
    case '/bye':
      return { handled: true, exit: true };
    default:
      console.log(kleur.yellow(`unknown: ${cmd} — try /help`));
      return { handled: true };
  }
}

function printReplBanner(env: NodeJS.ProcessEnv): void {
  const tenant = env.TENANT_ID ?? '(no tenant)';
  const user = env.USER_ID ?? '(no user)';
  const provider = env.MAIN_MODEL_PROVIDER ?? 'anthropic';
  const model = env.DEFAULT_LLM_MODEL ?? 'claude-sonnet-4-6';
  const state = env.CONNECTION_STATE ?? 'offline';
  const stateColor =
    state === 'connected' ? kleur.green : state === 'incognito' ? kleur.magenta : kleur.yellow;
  console.log('');
  console.log(`${kleur.bold('a8-claw')}  ${kleur.dim('•')}  ${user}@${tenant}  ${kleur.dim('•')}  ${stateColor(state)}  ${kleur.dim('•')}  ${provider} / ${model}`);
  console.log(kleur.dim('─────────────────────────────────────────────────────────────────'));
  console.log(kleur.dim('Type a message, or /help for commands. /exit to leave.'));
  console.log('');
}

export async function runRepl(): Promise<number> {
  await ensureDaemon();
  const socket = net.connect(SOCKET_PATH);
  const reader = attachReader(socket);

  printReplBanner(process.env);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: kleur.cyan('you > '),
  });

  let waitingForReply = false;
  let lastActivity = Date.now();
  let quietTimer: NodeJS.Timeout | null = null;
  const QUIET_MS = 1_500;

  function rePrompt(): void {
    waitingForReply = false;
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    rl.prompt();
  }

  reader.onReply((text) => {
    if (!waitingForReply) {
      // Server-initiated message (rare, but allowed by the protocol).
      process.stdout.write('\n' + text + '\n');
    } else {
      process.stdout.write(text + '\n');
    }
    lastActivity = Date.now();
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (Date.now() - lastActivity >= QUIET_MS) rePrompt();
    }, QUIET_MS);
  });

  let socketClosed = false;
  socket.on('error', (e: NodeJS.ErrnoException) => {
    console.error(kleur.red('\nsocket error:'), e.message);
    socketClosed = true;
    rl.close();
  });
  socket.on('close', () => {
    socketClosed = true;
    rl.close();
  });

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) {
        rl.prompt();
        return;
      }
      if (text.startsWith('/')) {
        const result = handleSlash(text);
        if (result.exit) {
          rl.close();
          return;
        }
        rl.prompt();
        return;
      }
      if (socketClosed) {
        console.error(kleur.red('socket closed — exiting'));
        rl.close();
        return;
      }
      socket.write(JSON.stringify({ text }) + '\n');
      waitingForReply = true;
      // No prompt yet — wait for replies + quiet period to re-prompt.
    });

    rl.on('SIGINT', () => {
      console.log(kleur.dim('\n(Ctrl-C again to exit, or type /exit)'));
      rl.prompt();
    });

    rl.on('close', () => {
      if (!socketClosed) socket.end();
      console.log(kleur.dim('\ngoodbye — daemon still running. `./a8-claw chat` to resume.'));
      resolve(0);
    });

    rl.prompt();
  });
}
