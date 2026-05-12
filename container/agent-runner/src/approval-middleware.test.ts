/**
 * Approval middleware tests — gating logic + session cache + catalog
 * shape interop.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  _sessionGrantsSnapshot,
  buildPolicyTableFromCatalog,
  recordApproval,
  reset,
  setPolicyTable,
  shouldApprove,
} from './approval-middleware.js';

const TABLE = {
  default_invoke: 'auto' as const,
  tools: {
    warp_create_episode: { invoke: 'auto' as const },
    warp_create_semantic_item: { invoke: 'auto' as const, category: 'knowledge' },
    prompt_hub_upsert_skill: { invoke: 'per_call' as const, category: 'compute', sensitivity: 'read_write' },
    danger_op: { invoke: 'deny' as const, category: 'compute' },
    expensive_op: { invoke: 'per_session' as const, category: 'compute' },
  },
};

afterEach(() => reset());

describe('shouldApprove', () => {
  it('allows auto-policy tools without prompting', () => {
    setPolicyTable(TABLE);
    expect(shouldApprove('warp_create_episode').decision).toBe('allow');
    expect(shouldApprove('warp_create_semantic_item').decision).toBe('allow');
  });

  it('returns ask for per_call ops every time', () => {
    setPolicyTable(TABLE);
    const r1 = shouldApprove('prompt_hub_upsert_skill');
    const r2 = shouldApprove('prompt_hub_upsert_skill');
    expect(r1.decision).toBe('ask');
    expect(r2.decision).toBe('ask');
    if (r1.decision === 'ask') {
      expect(r1.gate).toBe('per_call');
      expect(r1.reason).toContain('per-call approval');
    }
  });

  it('returns ask for per_session ops on first call, allow after grant', () => {
    setPolicyTable(TABLE);
    const r1 = shouldApprove('expensive_op');
    expect(r1.decision).toBe('ask');
    if (r1.decision === 'ask') expect(r1.gate).toBe('per_session');

    recordApproval('expensive_op', true, 'per_session');

    const r2 = shouldApprove('expensive_op');
    expect(r2.decision).toBe('allow');
  });

  it('does NOT cache deny — the user may change their mind next call', () => {
    setPolicyTable(TABLE);
    recordApproval('expensive_op', false, 'per_session');
    expect(shouldApprove('expensive_op').decision).toBe('ask');
  });

  it('hard-denies deny-policy tools regardless of cache', () => {
    setPolicyTable(TABLE);
    const r = shouldApprove('danger_op');
    expect(r.decision).toBe('deny');
    if (r.decision === 'deny') expect(r.reason).toContain('hard-denied');
  });

  it('falls back to default_invoke for unknown tools', () => {
    setPolicyTable({ ...TABLE, default_invoke: 'per_call' });
    const r = shouldApprove('unknown_tool');
    expect(r.decision).toBe('ask');
    setPolicyTable({ ...TABLE, default_invoke: 'auto' });
    expect(shouldApprove('unknown_tool').decision).toBe('allow');
  });

  it('strips mcp__server__ prefix when looking up', () => {
    setPolicyTable(TABLE);
    expect(shouldApprove('mcp__articul8__prompt_hub_upsert_skill').decision).toBe('ask');
    expect(shouldApprove('mcp__nanoclaw__warp_create_episode').decision).toBe('allow');
  });

  it('strips simple mcp__ prefix as fallback', () => {
    setPolicyTable(TABLE);
    expect(shouldApprove('mcp__warp_create_episode').decision).toBe('allow');
  });

  it('allow-by-default when no table loaded (defensive)', () => {
    // We bypass setPolicyTable to simulate boot before catalog loaded.
    // reset() was called in afterEach; setPolicyTable hasn't been
    // called here.
    reset();
    // setPolicyTable is module-level state; we need to clear it. Since
    // there's no exported clearTable(), invoke with an empty-tools
    // table + default auto, which is the actual fallback.
    setPolicyTable({ default_invoke: 'auto', tools: {} });
    expect(shouldApprove('anything_at_all').decision).toBe('allow');
  });
});

describe('session cache', () => {
  it('caches granted per_session tools', () => {
    setPolicyTable(TABLE);
    recordApproval('expensive_op', true, 'per_session');
    expect(_sessionGrantsSnapshot()).toContain('expensive_op');
  });

  it('reset() clears all cached grants', () => {
    setPolicyTable(TABLE);
    recordApproval('expensive_op', true, 'per_session');
    reset();
    expect(_sessionGrantsSnapshot()).toEqual([]);
  });

  it('per_call grants are NOT cached even if granted', () => {
    setPolicyTable(TABLE);
    recordApproval('prompt_hub_upsert_skill', true, 'per_call');
    expect(_sessionGrantsSnapshot()).not.toContain('prompt_hub_upsert_skill');
    // Confirm shouldApprove still asks on the next call.
    expect(shouldApprove('prompt_hub_upsert_skill').decision).toBe('ask');
  });
});

describe('buildPolicyTableFromCatalog', () => {
  it('flattens catalog services into a tool_name → policy map', () => {
    const catalog = {
      services: [
        {
          operations: [
            { tool_name: 'a', policy: { invoke: 'auto' as const }, category: 'k' },
            { tool_name: 'b', policy: { invoke: 'per_call' as const } },
          ],
        },
        {
          operations: [
            { tool_name: 'c', policy: { invoke: 'per_session' as const } },
            { tool_name: 'd' /* no policy — falls back to default */ },
          ],
        },
      ],
    };
    const table = buildPolicyTableFromCatalog(catalog, 'auto');
    expect(table.tools.a.invoke).toBe('auto');
    expect(table.tools.b.invoke).toBe('per_call');
    expect(table.tools.c.invoke).toBe('per_session');
    expect(table.tools.d.invoke).toBe('auto');
    expect(table.default_invoke).toBe('auto');
    expect(table.tools.a.category).toBe('k');
  });
});
