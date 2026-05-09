/**
 * Shared conversation-transcript archiving for non-Claude providers.
 *
 * The Claude provider archives via the SDK's PreCompact hook (fires
 * just before the SDK discards old messages during context compaction).
 * Our OpenAI / Google providers don't compact — message history grows
 * until the upstream API rejects — so the analog is: archive after
 * every assistant turn. Same destination format, same overwrite-stable
 * filename per query.
 *
 * Path: /workspace/agent/conversations/<date>-<slug>.md
 * Slug: derived from the first user message (or a timestamp fallback).
 *
 * Errors are logged and swallowed — archive failure must never break
 * the chat hot path.
 */
import fs from 'fs';
import path from 'path';

const CONVERSATIONS_DIR = '/workspace/agent/conversations';
const DEFAULT_TITLE = 'Conversation';

export interface FlatMessage {
  /** 'user' | 'assistant' (translated from the provider's native role). */
  role: 'user' | 'assistant';
  content: string;
}

function log(msg: string): void {
  console.error(`[transcript-archive] ${msg}`);
}

function slugify(text: string, max = 50): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || ''
  );
}

function formatMarkdown(messages: FlatMessage[], title: string, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName ?? 'Assistant');
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * Stable per-query archiver. Construct once at query start; call write()
 * after every turn. Filename is fixed for the lifetime of this query so
 * subsequent writes overwrite (no per-turn file proliferation).
 */
export class TranscriptArchiver {
  private readonly filepath: string | null;
  private readonly title: string;
  private readonly assistantName?: string;

  constructor(opts: { initialUserMessage: string; assistantName?: string }) {
    this.assistantName = opts.assistantName;
    const slug = slugify(opts.initialUserMessage) || `conversation-${Date.now().toString(36)}`;
    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${slug}.md`;
    // Keep the title human-readable (first message, capped) instead of the slug.
    this.title = opts.initialUserMessage.slice(0, 100) || DEFAULT_TITLE;
    try {
      fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
      this.filepath = path.join(CONVERSATIONS_DIR, filename);
    } catch (err) {
      log(`mkdir ${CONVERSATIONS_DIR} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.filepath = null;
    }
  }

  /** Write the current conversation to the archive file. Errors are logged + swallowed. */
  write(messages: FlatMessage[]): void {
    if (!this.filepath || messages.length === 0) return;
    try {
      const md = formatMarkdown(messages, this.title, this.assistantName);
      fs.writeFileSync(this.filepath, md);
    } catch (err) {
      log(`write ${this.filepath} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
