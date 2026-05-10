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
import * as os from 'os';
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
const ONESHOT_TURN_HARD_TIMEOUT_MS = 600_000; // 10 min upper bound — covers long web searches + tool chains
const ONESHOT_SILENCE_MS = 5_000; // batch-fallback only — `done` event preempts

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
  throw new Error(`daemon failed to start within ${DAEMON_BOOT_TIMEOUT_MS}ms — see ${logPath} for details`);
}

// ─── Reply parser (shared) ──────────────────────────────────────────

/**
 * Frame parsed off the cli socket. Two flavors share the same wire:
 *   - Final / batch reply:  { text: "...", partial?: false }
 *   - Live stream event:    { partial: true, text: "..." }
 *                            { kind: "tool_call", name, input }
 *                            { kind: "tool_result", name, ok, summary }
 *                            { kind: "done" }
 *
 * The live-stream events come from the container's stdout via
 * deliverLive(); they bypass the outbound.db audit cycle so the user
 * sees the agent's reply form in real time. Final batch frames are the
 * audit fall-back, suppressed by the cli adapter when live render
 * already covered the turn.
 */
type ReplyFrame =
  | { kind?: 'narration'; intent: string; category: string }
  | { kind?: 'tool_call'; name: string; input?: unknown }
  | { kind?: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { kind?: 'done' }
  | { partial?: boolean; text: string };

/**
 * Narration category → display glyph. The glyph carries semantic weight
 * (▸ generic intent, ⇢ delegation, + install, ⚐ approval, ↻ route, …
 * memory, ↑ tier) so a reader scanning the transcript can pick out
 * structural decisions from routine tool announcements at a glance.
 */
function narrationGlyph(category: string): string {
  switch (category) {
    case 'delegate':
      return '⇢';
    case 'install':
      return '+';
    case 'approval':
      return '⚐';
    case 'route':
      return '↻';
    case 'memory':
      return '…';
    case 'tier':
      return '↑';
    case 'tool':
    case 'sdk':
    case 'plan':
    default:
      return '▸';
  }
}

interface SocketReader {
  onFrame(handler: (frame: ReplyFrame) => void): void;
}

function attachReader(socket: net.Socket): SocketReader {
  let buffer = '';
  let handler: ((frame: ReplyFrame) => void) | null = null;
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as ReplyFrame;
        if (handler) handler(msg);
      } catch {
        // Ignore non-JSON lines — forward compatibility.
      }
    }
  });
  return {
    onFrame(h) {
      handler = h;
    },
  };
}

function describeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const i = input as Record<string, unknown>;
  // Hand-pick the most identifying field for common tools so the user
  // sees something meaningful ("WebSearch: tamilnadu elections") rather
  // than the bare tool name.
  if (typeof i.query === 'string') return `${name}: ${i.query}`;
  if (typeof i.url === 'string') return `${name}: ${i.url}`;
  if (typeof i.command === 'string') return `${name}: ${i.command.slice(0, 80)}`;
  if (typeof i.file_path === 'string') return `${name}: ${i.file_path}`;
  if (typeof i.path === 'string') return `${name}: ${i.path}`;
  if (typeof i.pattern === 'string') return `${name}: ${i.pattern}`;
  return name;
}

function truncate(s: string, n: number): string {
  // Collapse whitespace so a result with newlines / lots of spaces still
  // fits on one line — important because tool results can be huge JSON
  // blobs or multi-paragraph search summaries.
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

/**
 * State machine for rendering tool_call → … (waiting) → tool_result on
 * a single growing line. Without this, a long-running tool (web search,
 * remote API) shows `→ WebSearch: query` and then leaves the user
 * staring at silence until the agent's prose starts streaming.
 *
 * Output shape:
 *   → WebSearch: tamil nadu cm 2026 ......... ← Found: TVK won 108 …
 *
 * Dots are appended every TOOL_TICK_MS so the user can see the wait is
 * intentional. On result we emit the summary on the same line and
 * newline-terminate. Ownership of `lineDirty` belongs to the caller —
 * we set it true while the tool line is open.
 */
const TOOL_TICK_MS = 700;
function makeToolRenderer(setDirty: (dirty: boolean) => void): {
  onCall: (name: string, input: unknown) => void;
  onResult: (ok: boolean, summary?: string) => void;
  cleanup: () => void;
} {
  let tickTimer: NodeJS.Timeout | null = null;
  let active = false;

  function stopTimer(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  return {
    onCall(name, input) {
      // Defensive: if a prior tool didn't get its result event, close it.
      if (active) {
        stopTimer();
        process.stdout.write('\n');
      }
      process.stdout.write(kleur.dim(`→ ${describeToolInput(name, input)} `));
      active = true;
      setDirty(true);
      tickTimer = setInterval(() => {
        process.stdout.write(kleur.dim('.'));
      }, TOOL_TICK_MS);
    },
    onResult(ok, summary) {
      stopTimer();
      if (!active) {
        // Tool result without a preceding call — render bare.
        const tag = ok ? kleur.green('←') : kleur.red('← err');
        const detail = summary ? kleur.dim(' ' + truncate(summary, 120)) : '';
        process.stdout.write(tag + detail + '\n');
        return;
      }
      const tag = ok ? kleur.green(' ←') : kleur.red(' ← err');
      const detail = summary ? kleur.dim(' ' + truncate(summary, 120)) : kleur.dim(ok ? ' ok' : '');
      process.stdout.write(tag + detail + '\n');
      active = false;
      setDirty(false);
    },
    cleanup() {
      stopTimer();
      if (active) {
        process.stdout.write('\n');
        active = false;
        setDirty(false);
      }
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
    let firstReplyTimer: NodeJS.Timeout | null = null;
    let turnHardTimer: NodeJS.Timeout | null = null;
    let lineDirty = false; // true when the current line has unflushed live text
    const tools = makeToolRenderer((dirty) => {
      lineDirty = dirty;
    });

    const exit = (code: number): void => {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (firstReplyTimer) clearTimeout(firstReplyTimer);
      if (turnHardTimer) clearTimeout(turnHardTimer);
      tools.cleanup();
      if (lineDirty) process.stdout.write('\n');
      socket.end();
      resolve(code);
    };

    const armSilence = (): void => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => exit(0), ONESHOT_SILENCE_MS);
    };

    socket.on('error', (e: NodeJS.ErrnoException) => {
      console.error(kleur.red('socket error:'), e.message);
      exit(2);
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify({ text }) + '\n');
      // Two distinct safety nets:
      //   firstReplyTimer — bail out fast if the daemon never sends anything
      //                     (likely wiring problem, not a slow tool)
      //   turnHardTimer   — absolute ceiling for the whole turn, in case
      //                     `done` never arrives (agent hung mid-tool, etc.)
      firstReplyTimer = setTimeout(() => {
        if (!firstReply) {
          console.error(kleur.red(`timeout: no reply in ${ONESHOT_FIRST_REPLY_TIMEOUT_MS}ms`));
          exit(3);
        }
      }, ONESHOT_FIRST_REPLY_TIMEOUT_MS);
      turnHardTimer = setTimeout(() => {
        console.error(kleur.red(`timeout: turn exceeded ${ONESHOT_TURN_HARD_TIMEOUT_MS / 1000}s`));
        exit(4);
      }, ONESHOT_TURN_HARD_TIMEOUT_MS);
    });

    reader.onFrame((frame) => {
      firstReply = true;
      if (firstReplyTimer) {
        clearTimeout(firstReplyTimer);
        firstReplyTimer = null;
      }
      if ('kind' in frame && frame.kind) {
        if (frame.kind === 'narration') {
          if (lineDirty) {
            process.stdout.write('\n');
            lineDirty = false;
          }
          // Italic+dim with a category glyph — visually quieter than
          // the substantive answer text but legible enough that a user
          // scanning the transcript can spot decisions and rationale.
          const glyph = narrationGlyph(frame.category);
          process.stdout.write(kleur.italic(kleur.dim(`${glyph} ${frame.intent}`)) + '\n');
        } else if (frame.kind === 'tool_call') {
          if (lineDirty) {
            process.stdout.write('\n');
            lineDirty = false;
          }
          tools.onCall(frame.name, frame.input);
          // Tool call started — agent will be busy for a while (web
          // search, bash, etc.). Cancel any silence timer so we don't
          // bail mid-tool. The `done` event will trigger exit.
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
        } else if (frame.kind === 'tool_result') {
          tools.onResult(frame.ok, frame.summary);
        } else if (frame.kind === 'done') {
          if (lineDirty) {
            process.stdout.write('\n');
            lineDirty = false;
          }
          // Authoritative end-of-turn — exit immediately rather than
          // waiting for the silence timer.
          exit(0);
        }
        return;
      }
      // Text frame — partial or batch.
      const f = frame as { partial?: boolean; text: string };
      if (f.partial) {
        process.stdout.write(f.text);
        lineDirty = !f.text.endsWith('\n');
        // Don't arm silence on partial text — we're mid-stream. Wait for
        // `done` (or a long quiet from a non-live channel).
      } else {
        if (lineDirty) {
          process.stdout.write('\n');
          lineDirty = false;
        }
        process.stdout.write(f.text + '\n');
        armSilence();
      }
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
  const stateColor = state === 'connected' ? kleur.green : state === 'incognito' ? kleur.magenta : kleur.yellow;
  console.log('');
  console.log(
    `${kleur.bold('a8-claw')}  ${kleur.dim('•')}  ${user}@${tenant}  ${kleur.dim('•')}  ${stateColor(state)}  ${kleur.dim('•')}  ${provider} / ${model}`,
  );
  console.log(kleur.dim('─────────────────────────────────────────────────────────────────'));
  console.log(kleur.dim('Type a message, or /help for commands. /exit to leave.'));
  console.log('');
}

/**
 * Persistent input history. Loaded once at REPL start, appended on each
 * non-empty line entry. Lets up-arrow recall both this session's lines
 * and prior sessions'.
 */
const HISTORY_FILE = path.join(process.env.HOME || os.homedir(), '.a8', 'a8-claw-history');
const HISTORY_MAX = 1000;

function loadReplHistory(): string[] {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // readline expects newest-first.
    return lines.slice(-HISTORY_MAX).reverse();
  } catch {
    return [];
  }
}

function appendReplHistory(line: string): void {
  if (!line.trim()) return;
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, line + '\n');
  } catch {
    // Best-effort; history persistence is a nicety, not a requirement.
  }
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
    history: loadReplHistory(),
    historySize: HISTORY_MAX,
    removeHistoryDuplicates: true,
    terminal: true,
  });

  let waitingForReply = false;
  let lastActivity = Date.now();
  let quietTimer: NodeJS.Timeout | null = null;
  const QUIET_MS = 1_500;

  let lineDirty = false;
  const tools = makeToolRenderer((dirty) => {
    lineDirty = dirty;
  });

  function rePrompt(): void {
    waitingForReply = false;
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    tools.cleanup();
    rl.prompt();
  }

  reader.onFrame((frame) => {
    lastActivity = Date.now();

    if ('kind' in frame && frame.kind) {
      if (frame.kind === 'narration') {
        if (lineDirty) {
          process.stdout.write('\n');
          lineDirty = false;
        }
        const glyph = narrationGlyph(frame.category);
        process.stdout.write(kleur.italic(kleur.dim(`${glyph} ${frame.intent}`)) + '\n');
        return;
      } else if (frame.kind === 'tool_call') {
        if (lineDirty) {
          process.stdout.write('\n');
          lineDirty = false;
        }
        tools.onCall(frame.name, frame.input);
        // Tool work in progress — cancel the quiet timer so we don't
        // re-prompt mid-tool. `done` (or text frames) will rearm it.
        if (quietTimer) {
          clearTimeout(quietTimer);
          quietTimer = null;
        }
        return;
      } else if (frame.kind === 'tool_result') {
        tools.onResult(frame.ok, frame.summary);
      } else if (frame.kind === 'done') {
        if (lineDirty) {
          process.stdout.write('\n');
          lineDirty = false;
        }
        // Authoritative end-of-turn — re-prompt immediately rather than
        // waiting for the quiet timer.
        rePrompt();
        return;
      }
    } else {
      const f = frame as { partial?: boolean; text: string };
      if (f.partial) {
        // First chunk after sending: drop a leading newline so the
        // streamed reply doesn't start on the same line as `you > foo`.
        if (!waitingForReply && !lineDirty) process.stdout.write('\n');
        process.stdout.write(f.text);
        lineDirty = !f.text.endsWith('\n');
      } else {
        if (!waitingForReply) process.stdout.write('\n');
        if (lineDirty) {
          process.stdout.write('\n');
          lineDirty = false;
        }
        process.stdout.write(f.text + '\n');
      }
    }

    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (Date.now() - lastActivity >= QUIET_MS) {
        if (lineDirty) {
          process.stdout.write('\n');
          lineDirty = false;
        }
        rePrompt();
      }
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
      appendReplHistory(text);
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
