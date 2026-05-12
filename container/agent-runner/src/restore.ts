/**
 * Pod-boot session restore — pairs with snapshot.ts.
 *
 * When a pod boots with `RESUME_SESSION_ID` set (set by the orchestrator
 * on a re-spawn resume — same pattern as a8-code's `resume_session_id`
 * in agent_execute params), this module:
 *
 *   1. Queries Warp /files for the latest tar.gz tagged
 *      `arty-snapshot,<session_id>` (newest first).
 *   2. Streams it down via /files/{id}/download.
 *   3. Extracts into /workspace/ before the poll loop starts.
 *
 * Local mode: `RESUME_SESSION_ID` is never set (the local host mounts the
 * session dir directly from disk — no Warp roundtrip needed). Restore
 * becomes a no-op.
 *
 * Privacy: incognito sessions never have snapshots in Warp (snapshot.ts
 * refuses to upload). If `RESUME_SESSION_ID` is set on a session marked
 * incognito, that's a contract violation by the dispatcher — log and
 * skip rather than silently restoring private state.
 *
 * Failure mode: a missing snapshot (404) is non-fatal — the session
 * starts fresh, which is the same outcome as if no snapshot ever existed
 * (e.g. user stopped the session before its first checkpoint). The pod
 * continues to boot and the agent gets a clean workspace.
 *
 * Direct Warp HTTP — same rationale as snapshot.ts (runtime infra, not an
 * agent tool; mission token grants access).
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function log(msg: string): void {
  console.error(`[restore] ${msg}`);
}

export interface RestoreResult {
  restored: boolean;
  /** Reason for skip/failure. Always set when restored=false. */
  reason?: 'no-resume' | 'incognito' | 'no-warp' | 'no-snapshot' | 'mismatch' | 'workspace-not-empty' | 'error';
  /** When restored=true, the Warp file id used. */
  file_id?: string;
  /** When restored=true, the byte length downloaded. */
  size_bytes?: number;
  /** When skipped/failed, a short human-readable detail. */
  detail?: string;
}

interface RestoreContext {
  resume_session_id: string;
  session_id: string;
  privacy: 'normal' | 'incognito';
  tenant_id: string;
  user_id: string;
  warp_url: string | null;
  workspace_dir: string;
}

let _ctx: RestoreContext | null = null;

function getContext(): RestoreContext {
  if (_ctx) return _ctx;
  const rawPrivacy = (process.env.SESSION_PRIVACY ?? 'normal').toLowerCase();
  _ctx = {
    resume_session_id: process.env.RESUME_SESSION_ID ?? '',
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
export function _resetRestoreContextForTests(): void {
  _ctx = null;
}

/**
 * Attempt to restore the session-dir snapshot. Returns a structured
 * result; never throws. Caller (agent-runner/index.ts) logs the outcome
 * and proceeds — restore failure is not fatal to startup.
 */
export async function restoreSnapshot(): Promise<RestoreResult> {
  const ctx = getContext();

  if (!ctx.resume_session_id) {
    return { restored: false, reason: 'no-resume' };
  }
  if (ctx.privacy === 'incognito') {
    log(`refusing to restore — session marked incognito (dispatcher bug?)`);
    return { restored: false, reason: 'incognito' };
  }
  if (ctx.session_id && ctx.session_id !== ctx.resume_session_id) {
    log(`SESSION_ID=${ctx.session_id} does not match RESUME_SESSION_ID=${ctx.resume_session_id}`);
    return {
      restored: false,
      reason: 'mismatch',
      detail: `SESSION_ID != RESUME_SESSION_ID`,
    };
  }
  if (!ctx.warp_url || !ctx.tenant_id || !ctx.user_id) {
    return { restored: false, reason: 'no-warp' };
  }

  // Refuse to overwrite an already-populated workspace. Local mode mounts
  // the session dir from disk and there's no resume on top of an existing
  // dir — if we see one, that's a misconfigured dispatcher passing
  // RESUME_SESSION_ID into a local-mode container.
  const inboundDb = path.join(ctx.workspace_dir, 'inbound.db');
  try {
    await fsp.access(inboundDb);
    log(`workspace already has inbound.db at ${inboundDb} — skipping restore`);
    return { restored: false, reason: 'workspace-not-empty' };
  } catch {
    // ENOENT — workspace is empty, proceed.
  }

  try {
    const file = await findLatestSnapshot(ctx);
    if (!file) {
      log(`no snapshot found for session ${ctx.resume_session_id} — starting fresh`);
      return { restored: false, reason: 'no-snapshot' };
    }
    const size = await downloadAndExtract(ctx, file.file_id);
    log(`restored ${size} bytes from snapshot ${file.file_id} into ${ctx.workspace_dir}`);
    return { restored: true, file_id: file.file_id, size_bytes: size };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`restore failed: ${msg}`);
    return { restored: false, reason: 'error', detail: msg };
  }
}

interface FileListItem {
  file_id: string;
  filename?: string;
  created_at?: string;
}

async function findLatestSnapshot(ctx: RestoreContext): Promise<FileListItem | null> {
  // tags is comma-separated; both must match (AND semantics in Warp).
  const tags = `arty-snapshot,${ctx.resume_session_id}`;
  const params = new URLSearchParams({
    tags,
    sort_by: 'created_at',
    sort_order: 'desc',
    limit: '1',
  });
  const url = `${ctx.warp_url}/files?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'X-Tenant-ID': ctx.tenant_id,
      'X-User-ID': ctx.user_id,
      ...(process.env.MISSION_TOKEN ? { 'X-Mission-Token': process.env.MISSION_TOKEN } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`list HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  // Warp's list_files returns the envelope { items, total, ... } per the
  // platform's pagination convention. Accept both envelope and bare-array
  // shapes for resilience to minor surface drift.
  const body = (await res.json()) as { items?: FileListItem[] } | FileListItem[];
  const items = Array.isArray(body) ? body : (body.items ?? []);
  if (items.length === 0) return null;
  return items[0];
}

async function downloadAndExtract(ctx: RestoreContext, fileId: string): Promise<number> {
  const url = `${ctx.warp_url}/files/${encodeURIComponent(fileId)}/download`;
  const res = await fetch(url, {
    headers: {
      'X-Tenant-ID': ctx.tenant_id,
      'X-User-ID': ctx.user_id,
      ...(process.env.MISSION_TOKEN ? { 'X-Mission-Token': process.env.MISSION_TOKEN } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`download HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  // Stream to a temp file first, then tar -xzf into workspace. We don't
  // pipe directly into `tar -x -` because tar reading from stdin doesn't
  // give us a useful error path when the stream is truncated — writing
  // to disk lets us see the byte count + checksum mismatch independently.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arty-restore-'));
  const tarPath = path.join(tmpDir, `${ctx.resume_session_id}.tar.gz`);
  try {
    const buf = new Uint8Array(await res.arrayBuffer());
    await fsp.writeFile(tarPath, buf);

    await fsp.mkdir(ctx.workspace_dir, { recursive: true });
    await extractTar(tarPath, ctx.workspace_dir);

    return buf.length;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractTar(tarPath: string, destDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', tarPath, '-C', destDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar -xzf exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
    proc.on('error', reject);
  });
}
