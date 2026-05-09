/**
 * Tests for the onboarding affirmation persistence + hash. The
 * interactive prompt + screen rendering aren't covered (TTY).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AFFIRMATION_TEXT,
  AFFIRMATION_VERSION,
  affirmationFilePath,
  affirmationTextHash,
  isAffirmationCurrent,
  readAffirmation,
  revokeAffirmation,
  writeAffirmation,
} from './onboarding.js';

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  // Sandbox ~/.a8 to a tmpdir so tests don't touch the real one. The
  // onboarding module reads process.env.HOME first (lazily), so just
  // overriding HOME is enough — no spy on os.homedir needed.
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'a8-claw-onboarding-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  // Best-effort cleanup
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('affirmationTextHash', () => {
  it('is stable for the canonical text', () => {
    const a = affirmationTextHash();
    const b = affirmationTextHash();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes if the text changes (any whitespace edit re-prompts users)', () => {
    const canonical = affirmationTextHash(AFFIRMATION_TEXT);
    const tweaked = affirmationTextHash(AFFIRMATION_TEXT + ' '); // one extra space
    expect(canonical).not.toBe(tweaked);
  });
});

describe('readAffirmation / writeAffirmation', () => {
  it('returns null when no file exists', () => {
    expect(readAffirmation()).toBeNull();
  });

  it('roundtrips a record with the right schema', () => {
    const before = Date.now();
    const rec = writeAffirmation('Arun Subramaniyan');
    const read = readAffirmation();

    expect(read).not.toBeNull();
    expect(read).toEqual(rec);
    expect(rec.schema_version).toBe(1);
    expect(rec.affirmation_version).toBe(AFFIRMATION_VERSION);
    expect(rec.affirmation_text_sha256).toBe(affirmationTextHash());
    expect(rec.signed_by_typed_name).toBe('Arun Subramaniyan');
    expect(rec.tool).toBe('a8-claw');
    expect(new Date(rec.signed_at_utc).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('writes JSON-formatted file at the expected path', () => {
    writeAffirmation('Alice Example');
    // affirmationFilePath() reads os.homedir() at call time — test-friendly
    const filePath = affirmationFilePath();
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ signed_by_typed_name: 'Alice Example' });
  });

  it('overwrites a previous record on re-sign', () => {
    writeAffirmation('First Signer');
    writeAffirmation('Second Signer');
    expect(readAffirmation()?.signed_by_typed_name).toBe('Second Signer');
  });
});

describe('isAffirmationCurrent', () => {
  it('false when no file exists', () => {
    expect(isAffirmationCurrent()).toBe(false);
  });

  it('true after a fresh sign with current text', () => {
    writeAffirmation('Arun Subramaniyan');
    expect(isAffirmationCurrent()).toBe(true);
  });

  it('false when stored hash mismatches the current text (we amended wording)', () => {
    writeAffirmation('Arun Subramaniyan');
    // Simulate amendment: rewrite the file with a different hash
    const filePath = affirmationFilePath();
    const rec = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    rec.affirmation_text_sha256 = 'deadbeef'.repeat(8);
    fs.writeFileSync(filePath, JSON.stringify(rec));
    expect(isAffirmationCurrent()).toBe(false);
  });
});

describe('revokeAffirmation', () => {
  it('returns false when no file exists', () => {
    expect(revokeAffirmation()).toBe(false);
  });

  it('deletes the file and returns true', () => {
    writeAffirmation('Arun');
    expect(revokeAffirmation()).toBe(true);
    expect(fs.existsSync(affirmationFilePath())).toBe(false);
    expect(isAffirmationCurrent()).toBe(false);
  });
});
