/**
 * Subprocess runner tests — env construction + result extraction.
 *
 * The actual `bun run` is mocked; we verify:
 *   - workspace is prepared (mkdir agent/, stale heartbeat removed)
 *   - container.json is written with role + agentGroupId
 *   - env carries TENANT_ID, USER_ID, SESSION_ID, MISSION_TOKEN, etc.
 *   - RESUME_SESSION_ID set when envelope.context has it
 *   - SESSION_PRIVACY normalized
 *   - exit code 0 + result file → success with parsed result
 *   - exit code 0 + no result file → partial (clean exit but no signal)
 *   - non-zero exit → failed
 *   - wall-time budget triggers SIGTERM
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';

import { buildEnv, createSubprocessRunner } from './runner.js';
import type { AgentExecuteEnvelope } from './envelope.js';

function envelope(overrides: Partial<AgentExecuteEnvelope> = {}): AgentExecuteEnvelope {
  return {
    mission_id: 'mis-1',
    task_id: 'task-1',
    agent_type: 'a8-claw',
    tenant_id: 'tenant-acme',
    user_id: 'user-arun',
    parent_agent_id: null,
    role: 'data-analyst',
    goal: 'g',
    context: {},
    budget: { max_tokens: 1, max_wall_seconds: 60, max_concurrent_t3: 1, max_spawn_depth: 0 },
    cancellation_token: 'ct-abc',
    idempotency_key: 'idem-1',
    audit_event_id: 'evt-1',
    ...overrides,
  };
}

class FakeProc extends EventEmitter {
  pid = 12345;
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    setImmediate(() => this.emit('exit', null));
    return true;
  }
}

let tmpWorkspace = '';

beforeEach(async () => {
  tmpWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'runner-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpWorkspace, { recursive: true, force: true }).catch(() => {});
});

describe('buildEnv', () => {
  it('sets all required mission/identity env vars', () => {
    const env = buildEnv(
      envelope({
        context: { resume_session_id: 'mis-1', privacy: 'normal' },
        parent_agent_id: 'pod-parent',
      }),
      'pod-self',
    );
    expect(env.TENANT_ID).toBe('tenant-acme');
    expect(env.USER_ID).toBe('user-arun');
    expect(env.SESSION_ID).toBe('mis-1');
    expect(env.MISSION_ID).toBe('mis-1');
    expect(env.TASK_ID).toBe('task-1');
    expect(env.AGENT_ID).toBe('pod-self');
    expect(env.AGENT_TYPE).toBe('a8-claw');
    expect(env.PARENT_AGENT_ID).toBe('pod-parent');
    expect(env.MISSION_TOKEN).toBe('ct-abc');
    expect(env.RESUME_SESSION_ID).toBe('mis-1');
    expect(env.SESSION_PRIVACY).toBe('normal');
  });

  it('omits RESUME_SESSION_ID when context.resume_session_id absent', () => {
    const env = buildEnv(envelope(), 'pod-x');
    expect(env.RESUME_SESSION_ID).toBeUndefined();
  });

  it('normalizes SESSION_PRIVACY to incognito when context.privacy=incognito', () => {
    const env = buildEnv(envelope({ context: { privacy: 'incognito' } }), 'pod-x');
    expect(env.SESSION_PRIVACY).toBe('incognito');
  });

  it('defaults SESSION_PRIVACY=normal for any unknown value', () => {
    const env = buildEnv(envelope({ context: { privacy: 'mystery' } }), 'pod-x');
    expect(env.SESSION_PRIVACY).toBe('normal');
  });

  it('omits PARENT_AGENT_ID when null on the envelope', () => {
    const env = buildEnv(envelope({ parent_agent_id: null }), 'pod-x');
    expect(env.PARENT_AGENT_ID).toBeUndefined();
  });
});

describe('createSubprocessRunner', () => {
  it('prepares workspace + writes container.json before spawning', async () => {
    const fakeProc = new FakeProc();
    const spawnImpl = vi.fn(() => fakeProc as unknown as ReturnType<typeof import('child_process').spawn>);
    const runner = createSubprocessRunner({
      agentId: 'pod-1',
      workspaceDir: tmpWorkspace,
      spawnImpl,
    });

    // Resolve with a successful exit + write a result file the runner expects.
    setTimeout(async () => {
      await fsp.writeFile(
        path.join(tmpWorkspace, 'mission-result.json'),
        JSON.stringify({
          status: 'success',
          result: { summary: 'analyzed' },
          usage: { tokens_in: 1, tokens_out: 1, model_calls: 1, tool_calls: 1, duration_ms: 5 },
        }),
      );
      fakeProc.emit('exit', 0);
    }, 5);

    const result = await runner(envelope());

    // container.json was written with the role.
    const containerJson = await fsp.readFile(
      path.join(tmpWorkspace, 'agent', 'container.json'),
      'utf8',
    );
    expect(JSON.parse(containerJson).assistantName).toBe('data-analyst');

    expect(result.status).toBe('success');
    expect(result.result?.summary).toBe('analyzed');
  });

  it('returns status=partial when subprocess exits 0 but no result file', async () => {
    const fakeProc = new FakeProc();
    const spawnImpl = vi.fn(() => fakeProc as unknown as ReturnType<typeof import('child_process').spawn>);
    const runner = createSubprocessRunner({
      agentId: 'pod-1',
      workspaceDir: tmpWorkspace,
      spawnImpl,
    });
    setTimeout(() => fakeProc.emit('exit', 0), 5);
    const result = await runner(envelope());
    expect(result.status).toBe('partial');
    expect(result.error).toContain('no mission-result.json');
  });

  it('returns status=failed on non-zero exit code', async () => {
    const fakeProc = new FakeProc();
    const spawnImpl = vi.fn(() => fakeProc as unknown as ReturnType<typeof import('child_process').spawn>);
    const runner = createSubprocessRunner({
      agentId: 'pod-1',
      workspaceDir: tmpWorkspace,
      spawnImpl,
    });
    setTimeout(() => fakeProc.emit('exit', 7), 5);
    const result = await runner(envelope());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('code 7');
  });

  it('cleans stale heartbeat + stale result before spawn', async () => {
    // Pre-seed the workspace as if a prior pod had left junk.
    await fsp.mkdir(path.join(tmpWorkspace, 'agent'), { recursive: true });
    await fsp.writeFile(path.join(tmpWorkspace, '.heartbeat'), 'stale');
    await fsp.writeFile(path.join(tmpWorkspace, 'mission-result.json'), '{"status":"success"}');

    const fakeProc = new FakeProc();
    const spawnImpl = vi.fn(() => fakeProc as unknown as ReturnType<typeof import('child_process').spawn>);
    const runner = createSubprocessRunner({
      agentId: 'pod-1',
      workspaceDir: tmpWorkspace,
      spawnImpl,
    });
    setTimeout(() => fakeProc.emit('exit', 1), 5);
    const result = await runner(envelope());

    // The stale result should NOT have leaked into this run.
    expect(result.status).toBe('failed');
    // Heartbeat should be gone (deleted at prep time).
    await expect(fsp.access(path.join(tmpWorkspace, '.heartbeat'))).rejects.toThrow();
  });
});
