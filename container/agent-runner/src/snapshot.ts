/**
 * Session snapshot writer — end-of-turn upload to Warp.
 *
 * Per ADR / arty-per-session-db-and-resume: each session's SQLite + workspace
 * is tarred and uploaded to Warp's file store at end-of-turn so the session
 * can be RESUMED after the pod (or host process) restarts. Mirrors
 * a8-code's `_restorePreviousSessionFiles` shape with one addition: arty
 * also includes the per-session SQLite files (inbound.db + outbound.db)
 * since arty's per-session DB design carries channel state that doesn't
 * live in Warp episodes (unlike a8-code, which has only a single shared
 * transcript).
 *
 * Privacy: when SESSION_PRIVACY=incognito the writer is a no-op. Incognito
 * sessions never leave the runtime, period.
 *
 * Direct Warp HTTP — NOT routed through Platform MCP. Snapshot is runtime
 * infra (deterministic end-of-turn lifecycle), not an agent-facing tool.
 * The mission token / X-Tenant-ID / X-User-ID headers grant access; the
 * Platform MCP catalog is reserved for ops the LLM decides to invoke.
 *
 * Fire-and-forget: never blocks the agent's hot path. Failures are
 * logged once. A missed snapshot just means resume picks up from the
 * previous turn — not a correctness bug, only a UX one.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function log(msg: string): void {
  console.error(`[snapshot] ${msg}`);
}

interface SnapshotContext {
  session_id: string;
  privacy: 'normal' | 'incognito';
  tenant_id: string;
  user_id: string;
  warp_url: string | null;
  /** Path inside the container — the host mounts the session dir here. */
  workspace_dir: string;
}

let _ctx: SnapshotContext | null = null;

function getContext(): SnapshotContext {
  if (_ctx) return _ctx;
  const rawPrivacy = (process.env.SESSION_PRIVACY ?? 'normal').toLowerCase();
  _ctx = {
    session_id: process.env.SESSION_ID ?? '',
    privacy: rawPrivacy === 'incognito' ? 'incognito' : 'normal',
    tenant_id: process.env.TENANT_ID ?? '',
    user_id: process.env.USER_ID ?? '',
    warp_url: process.env.WARP_URL || null,
    workspace_dir: process.env.WORKSPACE_DIR ?? '/workspace',
  };
  return _ctx;
}

/** For tests — reset cached env-derived context. */
export function _resetSnapshotContextForTests(): void {
  _ctx = null;
}

/**
 * Coalescing: snapshot is fire-and-forget but we don't want a fast burst
 * of turn-end events to launch overlapping `tar` processes. If one is
 * already running, drop the request (the next turn's snapshot supersedes
 * it anyway). The `pending` flag lets us promote one queued request to
 * "run again right after the current one finishes" so we don't miss the
 * latest state when bursts happen.
 */
let inFlight = false;
let pending = false;

/**
 * Write one end-of-turn session snapshot. Fire-and-forget — returns
 * immediately. Callers may await the returned promise for tests, but
 * production call sites in the poll loop should not.
 *
 * - Skips entirely when SESSION_PRIVACY=incognito or WARP_URL unset.
 * - Coalesces concurrent calls.
 * - Never throws; logs errors and moves on.
 */
export async function writeSnapshot(): Promise<void> {
  const ctx = getContext();
  if (ctx.privacy === 'incognito') return;
  if (!ctx.session_id) return;
  if (!ctx.warp_url || !ctx.tenant_id || !ctx.user_id) {
    // Standalone / offline mode — no Warp to upload to. Resume in local
    // mode reads the session dir directly from the host filesystem, so
    // skipping is correct, not a bug.
    return;
  }

  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;

  try {
    await runOnce(ctx);
  } catch (err) {
    log(`snapshot failed: ${(err as Error).message ?? err}`);
  } finally {
    inFlight = false;
    if (pending) {
      pending = false;
      // Trail edge — kick off one more without awaiting; the loop tail
      // catches the latest state after a burst.
      void writeSnapshot();
    }
  }
}

async function runOnce(ctx: SnapshotContext): Promise<void> {
  const tarPath = await makeTar(ctx);
  try {
    await upload(ctx, tarPath);
  } finally {
    // Best-effort cleanup; OS will reap /tmp anyway.
    await fsp.unlink(tarPath).catch(() => {});
  }
}

/**
 * Tar the workspace dir into a temp file. Excludes the live SQLite WAL +
 * SHM sidecars (those get rewritten on every transaction; their content
 * is captured by the main .db file's WAL checkpoint) and node_modules /
 * cache dirs that bloat the archive without contributing to resume.
 */
async function makeTar(ctx: SnapshotContext): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arty-snap-'));
  const outPath = path.join(tmpDir, `${ctx.session_id}.tar.gz`);

  return new Promise<string>((resolve, reject) => {
    const args = [
      '-czf',
      outPath,
      '-C',
      ctx.workspace_dir,
      '--exclude=*.db-wal',
      '--exclude=*.db-shm',
      '--exclude=node_modules',
      '--exclude=.cache',
      '--exclude=__pycache__',
      '.',
    ];
    const proc = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(outPath);
      } else {
        reject(new Error(`tar exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
    proc.on('error', reject);
  });
}

async function upload(ctx: SnapshotContext, tarPath: string): Promise<void> {
  // Read the tar file into a Blob for multipart upload. The archive is
  // bounded (workspace + session dbs, typically <50MB), so reading into
  // memory is fine for now. If we ever ship workspaces with large
  // artifacts, switch to a streaming form upload.
  const tarBytes = await fsp.readFile(tarPath);
  const blob = new Blob([new Uint8Array(tarBytes)], { type: 'application/gzip' });

  const form = new FormData();
  form.append('file', blob, `${ctx.session_id}.tar.gz`);
  form.append('tags', `arty-snapshot,${ctx.session_id}`);
  form.append(
    'metadata',
    JSON.stringify({
      kind: 'arty-session-snapshot',
      session_id: ctx.session_id,
      snapshot_at: new Date().toISOString(),
    }),
  );

  // auto_process=false — this is opaque infra, not user-uploaded data;
  // we don't want Warp's content sniffer to try parsing it as a time
  // series or dataframe.
  const url = `${ctx.warp_url}/files/upload?auto_process=false`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Tenant-ID': ctx.tenant_id,
      'X-User-ID': ctx.user_id,
      ...(process.env.MISSION_TOKEN ? { 'X-Mission-Token': process.env.MISSION_TOKEN } : {}),
    },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  log(`uploaded snapshot for ${ctx.session_id} (${tarBytes.length} bytes)`);
}
