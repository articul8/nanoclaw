/**
 * Subprocess-backed MissionRunner — the real session executor.
 *
 * Spawns the bun agent-runner (`/app/container/agent-runner/src/index.ts`)
 * as a subprocess for one mission. The agent-runner's own poll loop reads
 * /workspace/{inbound,outbound}.db, calls the configured provider (Claude),
 * snapshots to Warp at end-of-turn (per snapshot.ts), restores at boot
 * (per restore.ts), and exits when the session loop terminates.
 *
 * Per the cloud architecture: one pod = one session. After this runner
 * returns, the pod exits and SandboxWarmPool spins up a replacement.
 *
 * Mission → env mapping (RUNTIME_CONTRACT §6 + arty-specific extras):
 *   X-Tenant-ID, X-User-ID  ← envelope.tenant_id / user_id
 *   SESSION_ID              ← envelope.mission_id (durable workstream identity)
 *   RESUME_SESSION_ID       ← envelope.context.resume_session_id (set on re-spawn resume)
 *   SESSION_PRIVACY         ← envelope.context.privacy ?? 'normal'
 *   MISSION_ID, TASK_ID     ← envelope (for audit attribution)
 *   AGENT_ID                ← agentId (this pod's identity)
 *   PARENT_AGENT_ID         ← envelope.parent_agent_id
 *   MISSION_TOKEN           ← envelope.cancellation_token (the contract calls
 *                             this token X-Mission-Token; we reuse the
 *                             dispatch's cancellation_token as the bearer)
 *
 * Platform service URLs (WARP_URL, MODEL_MANAGER_URL, TOOL_MANAGER_URL,
 * METERING_USAGE_URL) come from the pod's own env (set by the
 * SandboxTemplate's configMapKeyRef) and are passed through.
 *
 * Workspace prep: writes container.json, ensures /workspace/, removes
 * stale .heartbeat. The agent-runner's restore.ts handles snapshot
 * download when RESUME_SESSION_ID is set.
 *
 * Result extraction: tries to read /workspace/mission-result.json which
 * the agent-runner writes on clean exit. Absent file → status='failed'
 * with synthetic summary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { MissionRunner, RunnerResult } from './consumer.js';
import type { AgentExecuteEnvelope } from './envelope.js';

const AGENT_RUNNER_ENTRY = '/app/container/agent-runner/src/index.ts';
const BUN_BIN = '/usr/local/bin/bun';
const WORKSPACE_DIR = '/workspace';
const CONTAINER_JSON_PATH = '/workspace/agent/container.json';
const RESULT_PATH = '/workspace/mission-result.json';
const HEARTBEAT_PATH = '/workspace/.heartbeat';

function log(msg: string): void {
  console.error(`[mq-runner] ${msg}`);
}

export interface SubprocessRunnerOptions {
  /** This pod's identifier — emitted on completion envelope's agent_id. */
  agentId: string;
  /** Override the spawn path (tests inject `node` or echo). */
  bunBin?: string;
  /** Override the agent-runner entry (tests inject a fixture script). */
  runnerEntry?: string;
  /** Override workspace dir (tests use a tmp dir). */
  workspaceDir?: string;
  /** Maximum wall time — defaults to envelope.budget.max_wall_seconds * 1000. */
  killAfterMs?: number;
  /**
   * Override the subprocess spawner — tests inject a fake. The default
   * uses Node's child_process.spawn.
   */
  spawnImpl?: typeof spawn;
}

export function createSubprocessRunner(opts: SubprocessRunnerOptions): MissionRunner {
  const bunBin = opts.bunBin ?? BUN_BIN;
  const runnerEntry = opts.runnerEntry ?? AGENT_RUNNER_ENTRY;
  const workspaceDir = opts.workspaceDir ?? WORKSPACE_DIR;
  const spawnFn = opts.spawnImpl ?? spawn;

  return async function subprocessRunner(envelope: AgentExecuteEnvelope): Promise<RunnerResult> {
    await prepareWorkspace(workspaceDir);
    await writeContainerJson(workspaceDir, envelope);

    const env = buildEnv(envelope, opts.agentId);
    const killAfterMs = opts.killAfterMs ?? envelope.budget.max_wall_seconds * 1000;

    log(`spawning agent-runner for mission ${envelope.mission_id}, task ${envelope.task_id}`);
    const exitCode = await runSubprocess(spawnFn, bunBin, runnerEntry, env, killAfterMs);

    return buildResult(workspaceDir, exitCode);
  };
}

async function prepareWorkspace(workspaceDir: string): Promise<void> {
  await fsp.mkdir(path.join(workspaceDir, 'agent'), { recursive: true });
  // Clear stale heartbeat from a previous (failed) attempt so host-side
  // sweep logic doesn't see a phantom alive pod from before.
  await fsp.rm(path.join(workspaceDir, '.heartbeat'), { force: true }).catch(() => {});
  // Old mission-result from prior pod incarnation would lie to us about
  // this run's outcome. Drop it.
  await fsp.rm(path.join(workspaceDir, 'mission-result.json'), { force: true }).catch(() => {});
}

async function writeContainerJson(workspaceDir: string, envelope: AgentExecuteEnvelope): Promise<void> {
  // Minimal container.json the agent-runner loadConfig() expects. The
  // role from the envelope drives any CLAUDE.md interpolation. In cloud
  // mode the MCP server map is empty by default — Platform MCP is
  // bundled at startup; per-tenant MCP additions come via the registry.
  const config = {
    provider: 'claude',
    assistantName: envelope.role,
    groupName: envelope.role,
    agentGroupId: envelope.parent_agent_id ?? envelope.mission_id,
    maxMessagesPerPrompt: 10,
    mcpServers: {},
  };
  const dest = path.join(workspaceDir, 'agent', 'container.json');
  await fsp.writeFile(dest, JSON.stringify(config, null, 2), 'utf8');
}

export function buildEnv(envelope: AgentExecuteEnvelope, agentId: string): NodeJS.ProcessEnv {
  const context = envelope.context as Record<string, unknown>;
  const resumeSessionId = typeof context.resume_session_id === 'string' ? context.resume_session_id : '';
  const rawPrivacy = typeof context.privacy === 'string' ? context.privacy.toLowerCase() : 'normal';
  const privacy = rawPrivacy === 'incognito' ? 'incognito' : 'normal';
  return {
    // Pass through pod env (WARP_URL, MODEL_MANAGER_URL, etc.) — set
    // by the SandboxTemplate's configMapKeyRef block.
    ...process.env,
    // Tenant + user — REQUIRED on every platform call (X-Tenant-ID/X-User-ID).
    TENANT_ID: envelope.tenant_id,
    USER_ID: envelope.user_id,
    // Session identity — durable workstream id.
    SESSION_ID: envelope.mission_id,
    SESSION_PRIVACY: privacy,
    ...(resumeSessionId ? { RESUME_SESSION_ID: resumeSessionId } : {}),
    // Mission + audit attribution.
    MISSION_ID: envelope.mission_id,
    TASK_ID: envelope.task_id,
    AGENT_ID: agentId,
    AGENT_TYPE: envelope.agent_type,
    ...(envelope.parent_agent_id ? { PARENT_AGENT_ID: envelope.parent_agent_id } : {}),
    // The contract's cancellation_token doubles as the X-Mission-Token
    // bearer — same opaque per-dispatch identifier.
    MISSION_TOKEN: envelope.cancellation_token,
  };
}

function runSubprocess(
  spawnFn: typeof spawn,
  bunBin: string,
  entry: string,
  env: NodeJS.ProcessEnv,
  killAfterMs: number,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const proc: ChildProcess = spawnFn(bunBin, ['run', entry], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env,
    });

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      log(`wall-clock budget exhausted after ${killAfterMs}ms — SIGTERM agent-runner`);
      proc.kill('SIGTERM');
      // Hard kill if the process refuses SIGTERM after 10s.
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 10_000);
    }, killAfterMs);

    proc.on('exit', (code) => {
      clearTimeout(killTimer);
      // Coerce null (signal-killed) to non-zero so the caller treats it as failure.
      const resolvedCode = code ?? (killed ? 124 : 137);
      resolve(resolvedCode);
    });
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      log(`spawn error: ${err.message}`);
      resolve(127);
    });
  });
}

async function buildResult(workspaceDir: string, exitCode: number): Promise<RunnerResult> {
  // Agent-runner writes /workspace/mission-result.json on clean exit with
  // its self-measured usage + summary. If absent (crash / kill / no
  // result), synthesize a failed result.
  const resultPath = path.join(workspaceDir, 'mission-result.json');
  let runnerResult: Partial<RunnerResult> | null = null;
  try {
    const raw = await fsp.readFile(resultPath, 'utf8');
    runnerResult = JSON.parse(raw) as Partial<RunnerResult>;
  } catch {
    runnerResult = null;
  }

  if (exitCode === 0 && runnerResult?.status) {
    return {
      status: runnerResult.status,
      result: runnerResult.result ?? { summary: 'completed' },
      usage: runnerResult.usage,
      audit_event_count: runnerResult.audit_event_count,
    };
  }

  // Non-zero exit, or 0 exit with no result file → treat as failure but
  // preserve any partial usage info the runner managed to write.
  return {
    status: exitCode === 0 ? 'partial' : 'failed',
    error:
      exitCode === 0
        ? 'agent-runner exited cleanly but produced no mission-result.json'
        : `agent-runner exited with code ${exitCode}`,
    usage: runnerResult?.usage,
    audit_event_count: runnerResult?.audit_event_count,
  };
}
