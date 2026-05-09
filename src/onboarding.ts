/**
 * a8-claw first-run onboarding — training, security, responsibility, affirmation.
 *
 * The user runs `./a8-claw` for the first time and gets a four-screen
 * orientation BEFORE the configure prompts:
 *   1. Welcome — what a8-claw is and isn't
 *   2. When to use claw vs code, and when claw delegates to code
 *   3. Security principles (constrained network, audit-and-stop, etc.)
 *   4. Why this exists, what it'll feel like (cognitive load up, not down),
 *      Dunning-Kruger framing — ending in a typed-name affirmation
 *
 * The affirmation is persisted to ~/.a8/affirmations/a8-claw.json with a
 * sha256 hash of the literal text the user signed. Subsequent runs skip
 * onboarding when the stored hash matches the current text. If we ever
 * amend the affirmation, the hash differs and the user is re-prompted.
 *
 * Same content is reachable in the REPL via /help /security /responsibility
 * /when /affirmation (wiring done in cli.ts).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import kleur from 'kleur';

// ─── Screen content ────────────────────────────────────────────────

export const SCREEN_WELCOME = `
${kleur.bold('a8-claw v0.1')}
─────────────────────────────────────────────────────────────────
A conversational AI agent runtime for the AgentMesh platform.

${kleur.bold('What it is:')}
  • A hub for talking to AI models (Anthropic, Google, OpenAI-compat)
  • Connected to your channels — Slack, Telegram, email, and more
  • Persistent memory across sessions: it remembers what you talked
    about last week
  • A delegate to its sibling, a8-code, when work needs heavy coding

${kleur.bold("What it isn't:")}
  • An autonomous agent that decides things for you
  • A replacement for thinking critically about your own domain
  • A safe place to paste secrets or write production code unreviewed
`.trim();

export const SCREEN_WHEN = `
${kleur.bold('WHEN TO USE WHAT')}
─────────────────────────────────────────────────────────────────

  ${kleur.cyan('a8-claw')}  →  conversation, exploration, multi-turn dialog,
              channel-driven workflows, persistent memory.
              "Talk to me. Ask questions. Connect to your tools."

  ${kleur.cyan('a8-code')}  →  long-running coding sessions: refactors, multi-file
              edits, test-and-iterate loops, codebase analysis.
              File-system-heavy. Bash, Read, Write, Edit, Glob, Grep.
              "Give me a task. I'll plan, execute, report back."

  ${kleur.bold('a8-claw INVOKES a8-code when:')}
    • A conversation reveals heavy coding work
    • The user says "refactor X" / "implement Y" / "fix all Z's"
    • Anything that needs to TOUCH FILES and EXECUTE COMMANDS

  ${kleur.bold('a8-claw DOES NOT delegate when:')}
    • A single answer suffices ("what does this code do?")
    • You're thinking through a design decision together
    • You want a sounding board, not an executor

  ${kleur.dim("Rule of thumb: if you'd rather pair-program with a colleague than")}
  ${kleur.dim('hand them a ticket, stay in a8-claw.')}
`.trim();

export const SCREEN_SECURITY = `
${kleur.bold('SECURITY PRINCIPLES')}
─────────────────────────────────────────────────────────────────

  ${kleur.bold('You are in control.')}
    The agent acts on your behalf with your credentials. What it
    does is what you would have done. Treat its output the same
    way you'd treat your own.

  ${kleur.bold('Review what the agent does.')}
    Especially before destructive operations. The agent will ask
    before sending messages, deleting files, posting to GitHub,
    pushing to git, or anything else with external visible effect.

  ${kleur.bold("Don't paste secrets here you wouldn't paste in a Slack DM.")}
    The conversation goes to the model provider, gets logged in
    your platform memory (if connected), and is preserved in your
    transcript. Treat it like any chat surface: secrets-in =
    secrets-leaked.

  ${kleur.bold('Your network is constrained — not muted.')}
    Every external call the agent makes falls into one of these:
      • ${kleur.cyan('Inference')}   →  your configured model provider
      • ${kleur.cyan('Platform')}    →  AgentMesh (Warp / Tool Manager / Model Manager)
      • ${kleur.cyan('Channels')}    →  adapters you enabled (Slack / Telegram / email / …)
      • ${kleur.cyan('Tools')}       →  what the agent explicitly invokes — all
                       visible in your transcript:
                         native: WebSearch, WebFetch, Bash, file ops
                         platform: nge_search, graph_traverse, ts_query, …
                         plugins + MCP servers you've installed
    Every external move surfaces as a tool call you can audit. No
    silent exfiltration: if the agent reaches the network, you see
    what and can stop it. Bash gives broad reach — review accordingly.

  ${kleur.bold("Local data stays local — until you 'connect'.")}
    In OFFLINE mode (default first-run), nothing leaves your machine
    except inference calls to your provider. In INCOGNITO mode, not
    even those are logged. Run 'connect' to opt into platform memory
    and audit.
`.trim();

export const SCREEN_RESPONSIBILITY = `
${kleur.bold('WHY THIS EXISTS, AND WHAT IT WILL FEEL LIKE')}
─────────────────────────────────────────────────────────────────

  ${kleur.bold('We are enabling this for you to unlock more thinking time.')}

  Used correctly, you can dive 100x deeper than you used to. You
  can learn entirely new areas in days if you spend the time. The
  routine parts of your work — drafting, looking up, summarizing,
  glue code, format conversions — collapse from hours to minutes.
  The time those used to consume comes back to you for harder
  thinking, deeper learning, longer attention spans.

  ${kleur.bold("Here's the inversion that matters most:")}

    Used correctly, your cognitive load will feel ${kleur.bold('HIGHER')}, not
    lower. You will feel overwhelmed by the amount of things you
    are reading and learning. That is the right state — it means
    you're using the agent to ${kleur.bold('EXPAND')} your reach, into more domains
    and deeper into ones you already touch.

    ${kleur.yellow('If you feel like you are breezing through, you are not')}
    ${kleur.yellow('verifying enough.')}

  ─── ${kleur.bold('The Dunning-Kruger trap, refracted through AI')} ───

  The agent sounds competent in proportion to how well-trodden
  the topic is on the internet. Your judgment of whether it's
  actually correct depends on YOUR depth in that area. The gap
  between those two is where mistakes hide — and the gap is
  largest exactly when you're least equipped to see it.

  Delegating ${kleur.cyan('TASKS')} is the unlock.
  Delegating ${kleur.red('THINKING')} is the trap.

    Tasks    "look up X", "draft Y", "summarize Z", "find the bug"
    Thinking "decide for me", "is this right?", "what should I do?"

  Task-delegation makes you sharper. Thinking-delegation makes
  you worse at your job, slowly, in ways you won't notice until
  the cost is large.
`.trim();

/**
 * The literal text the user signs. Whitespace and punctuation are
 * load-bearing — the sha256 of THIS string is what gets stored. If
 * we ever amend it, the hash changes and users re-affirm.
 */
export const AFFIRMATION_TEXT = `I have read and understood the pages above. Responsibility for all actions taken with this tool is mine. I will verify the agent's work, go deep, continuously learn, and improve the quality of what I produce.`;

export const AFFIRMATION_VERSION = 'v1';

// ─── Affirmation persistence ───────────────────────────────────────

export interface AffirmationRecord {
  schema_version: 1;
  affirmation_version: string;
  affirmation_text_sha256: string;
  signed_by_typed_name: string;
  signed_at_utc: string; // ISO-8601
  machine_hostname: string;
  os_user: string;
  tool: 'a8-claw';
  tool_version: string;
}

/**
 * Lazily resolve the affirmation path so process.env.HOME overrides
 * (used in tests + when the operator has a non-standard $HOME) take effect.
 */
function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}
function affirmationDir(): string {
  return path.join(homeDir(), '.a8', 'affirmations');
}
function _affirmationPath(): string {
  return path.join(affirmationDir(), 'a8-claw.json');
}

/** sha256 of the current affirmation text, hex-encoded. */
export function affirmationTextHash(text: string = AFFIRMATION_TEXT): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Read the persisted affirmation; null if file absent or unreadable. */
export function readAffirmation(): AffirmationRecord | null {
  try {
    const p = _affirmationPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as AffirmationRecord;
  } catch {
    return null;
  }
}

/**
 * Has the user signed the CURRENT affirmation text? False if absent OR
 * if the stored hash doesn't match (we amended the wording).
 */
export function isAffirmationCurrent(): boolean {
  const rec = readAffirmation();
  if (!rec) return false;
  return rec.affirmation_text_sha256 === affirmationTextHash();
}

function readToolVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Persist the affirmation; creates ~/.a8/affirmations/ as needed. */
export function writeAffirmation(typedName: string): AffirmationRecord {
  const record: AffirmationRecord = {
    schema_version: 1,
    affirmation_version: AFFIRMATION_VERSION,
    affirmation_text_sha256: affirmationTextHash(),
    signed_by_typed_name: typedName,
    signed_at_utc: new Date().toISOString(),
    machine_hostname: os.hostname(),
    os_user: os.userInfo().username || process.env.USER || 'unknown',
    tool: 'a8-claw',
    tool_version: readToolVersion(),
  };
  const p = _affirmationPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + '\n');
  return record;
}

/** Delete the affirmation; returns true if a file was removed. */
export function revokeAffirmation(): boolean {
  const p = _affirmationPath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function affirmationFilePath(): string {
  return _affirmationPath();
}

// ─── Onboarding flow ───────────────────────────────────────────────

const SCREENS_IN_ORDER: Array<{ name: string; body: string }> = [
  { name: 'welcome', body: SCREEN_WELCOME },
  { name: 'when', body: SCREEN_WHEN },
  { name: 'security', body: SCREEN_SECURITY },
  { name: 'responsibility', body: SCREEN_RESPONSIBILITY },
];

function pause(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n${kleur.dim(prompt)} `, () => {
      rl.close();
      resolve();
    });
  });
}

const NAME_BLACKLIST = new Set([
  'skip',
  'no',
  'enter',
  'x',
  'name',
  'test',
  'tester',
  '.',
  '-',
  'me',
  'user',
  'admin',
  'a',
]);

function validateTypedName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 3) return 'Name must be at least 3 characters.';
  if (NAME_BLACKLIST.has(name.toLowerCase())) {
    return 'That looks like a bypass — type your real name.';
  }
  return null;
}

async function promptTypedName(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`  ${kleur.bold('Type your full name:')} `, (a) => resolve(a));
      });
      const error = validateTypedName(answer);
      if (!error) return answer.trim();
      console.log(`  ${kleur.red(error)}`);
    }
  } finally {
    rl.close();
  }
}

function printAffirmationScreen(): void {
  const block = [
    '',
    kleur.bold('─── Affirmation ───────────────────────────────────────────────'),
    '',
    `  ${kleur.bold('Sign your commitment.')}`,
    '',
    kleur.cyan(`    "${AFFIRMATION_TEXT}"`),
    '',
  ].join('\n');
  console.log(block);
}

function printAffirmationFooter(record: AffirmationRecord): void {
  const lines = [
    '',
    `  ${kleur.green('✓')} signed at ${record.signed_at_utc}`,
    `  ${kleur.dim(`record: ${_affirmationPath()}`)}`,
    `  ${kleur.dim(`hash:   ${record.affirmation_text_sha256.slice(0, 16)}…`)}`,
    `  ${kleur.dim('to revoke and re-affirm:  ./a8-claw revoke-affirmation')}`,
    '',
  ].join('\n');
  console.log(lines);
}

/**
 * Run the four-screen onboarding + capture the typed-name affirmation.
 * Throws if the user kills it (Ctrl-C). Idempotent in the sense that
 * a current affirmation skips the whole flow.
 */
export async function runOnboarding(opts: { force?: boolean } = {}): Promise<AffirmationRecord> {
  if (!opts.force && isAffirmationCurrent()) {
    return readAffirmation()!;
  }

  console.log('\n');
  for (let i = 0; i < SCREENS_IN_ORDER.length; i++) {
    const { body } = SCREENS_IN_ORDER[i];
    console.log(body);
    await pause(`[Press Enter to continue — ${i + 1} of ${SCREENS_IN_ORDER.length + 1}]`);
    console.log('\n');
  }

  printAffirmationScreen();
  const name = await promptTypedName();
  const record = writeAffirmation(name);
  printAffirmationFooter(record);
  return record;
}
