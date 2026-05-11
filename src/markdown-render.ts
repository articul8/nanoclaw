/**
 * Block-level markdown rendering for the REPL.
 *
 * Strategy: stream raw during the turn (preserves the "live typing"
 * feel), then on `done` redraw the answer through marked-terminal so
 * tables, code blocks, bulleted / numbered lists, headers, and
 * blockquotes look like they should in a terminal.
 *
 * Only triggers when the buffered text contains block-level markdown.
 * Pure prose leaves the streamed output alone — no surprise redraw,
 * no flicker.
 *
 * Inline markdown (**bold**, `code`, _italic_) is intentionally not
 * surfaced — the user explicitly opted out.
 */
import { marked } from 'marked';
// @ts-expect-error — marked-terminal v7 ships no types; treat as any.
import { markedTerminal } from 'marked-terminal';

let _configured = false;

function configure(): void {
  if (_configured) return;
  // marked-terminal returns a Marked extension object. The cast is
  // because the type defs are loose — works at runtime, would need a
  // generic to satisfy strict TS otherwise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marked.use(markedTerminal({
    // Match REPL chrome — subdued accents so the prose stays primary.
    width: Math.min(process.stdout.columns ?? 100, 100),
    reflowText: true,
    // We disable inline emphasis (user opted out); leave block elements
    // styled at the marked-terminal defaults.
    strong: (s: string) => s, // no bold
    em: (s: string) => s, // no italic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  _configured = true;
}

const BLOCK_PATTERNS: RegExp[] = [
  /^\|.*\|\s*$/m, // table row
  /^```/m, // fenced code block
  /^#{1,6}\s/m, // ATX heading
  /^\s*[-*+]\s/m, // bulleted list item
  /^\s*\d+\.\s/m, // numbered list item
  /^>\s/m, // blockquote
];

/**
 * Quick heuristic: does the buffered text have any block-level markdown?
 * False → leave the streamed raw output alone (no redraw).
 */
export function hasBlockMarkdown(text: string): boolean {
  return BLOCK_PATTERNS.some((re) => re.test(text));
}

/**
 * Render markdown to ANSI for terminal display. Returns the rendered
 * string (with trailing newline normalized). Throws on render failure;
 * caller falls back to the raw streamed text.
 */
export function renderMarkdown(text: string): string {
  configure();
  const rendered = marked.parse(text, { async: false }) as string;
  return rendered.endsWith('\n') ? rendered : rendered + '\n';
}

/**
 * Estimate how many terminal lines a streamed string occupies, given
 * the current terminal width. Used by the cursor-up + clear redraw so
 * we land back at the right position before writing the polished
 * version.
 *
 * Counts hard newlines plus wrap lines (Math.floor(visibleLen / cols)
 * per logical line). ANSI escape sequences are stripped before
 * counting since they don't take screen columns.
 */
export function countDisplayLines(text: string, cols: number): number {
  if (cols <= 0) return text.split('\n').length;
  let lines = 0;
  // Strip ANSI for width calc: ESC[…m etc.
  const stripped = text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  const logicalLines = stripped.split('\n');
  for (const line of logicalLines) {
    // Each logical line takes at least 1 row; extra rows for wraps.
    lines += 1 + Math.max(0, Math.floor((line.length - 1) / cols));
  }
  // Trailing newline produces an empty final segment we counted as 1 —
  // drop one to match terminal behavior.
  if (text.endsWith('\n') && lines > 0) lines -= 1;
  return lines;
}
