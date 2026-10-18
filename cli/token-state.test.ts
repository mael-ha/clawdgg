import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearTokenRevoked,
  isTokenRevoked,
  markTokenRevoked,
  mergeState,
  readState,
  tokenFingerprint,
} from './token-state';

// A fixture path, never the real ~/.config/clawdgg.
let dir: string;
let statePath: string;

const TOKEN_A = `cgt_${'a'.repeat(32)}.${'1'.repeat(64)}`;
const TOKEN_B = `cgt_${'b'.repeat(32)}.${'2'.repeat(64)}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clawdgg-token-state-'));
  statePath = join(dir, 'nested', 'statusline-state.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readState', () => {
  it('treats a missing, empty or corrupt file as no state', async () => {
    expect(await readState(statePath)).toEqual({});

    await mkdtemp(join(tmpdir(), 'unused-'));
    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{not json');
    expect(await readState(broken)).toEqual({});

    await writeFile(broken, '[]');
    expect(await readState(broken)).toEqual({});
  });
});

describe('mergeState', () => {
  it('creates the directory and writes 0600', async () => {
    await mergeState({ lastPostAt: 42 }, statePath);

    expect(await readState(statePath)).toEqual({ lastPostAt: 42 });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it('keeps the other writer\'s fields', async () => {
    // The statusLine hook and `doctor` write different keys of this file from
    // different processes; a replace instead of a merge loses one of them.
    await markTokenRevoked(TOKEN_A, statePath);
    await mergeState({ lastPostAt: 7, fingerprint: 'snapshot' }, statePath);

    const state = await readState(statePath);
    expect(state.lastPostAt).toBe(7);
    expect(state.revokedTokenFingerprint).toBe(tokenFingerprint(TOKEN_A));
  });

  it('never writes the token itself', async () => {
    await markTokenRevoked(TOKEN_A, statePath);
    expect(await readFile(statePath, 'utf-8')).not.toContain(TOKEN_A);
  });
});

describe('isTokenRevoked', () => {
  it('is false until a 401 is recorded', async () => {
    expect(await isTokenRevoked(TOKEN_A, statePath)).toBe(false);
    await markTokenRevoked(TOKEN_A, statePath);
    expect(await isTokenRevoked(TOKEN_A, statePath)).toBe(true);
  });

  it('does not condemn a different token — a fresh login clears the alarm', async () => {
    await markTokenRevoked(TOKEN_A, statePath);
    expect(await isTokenRevoked(TOKEN_B, statePath)).toBe(false);
  });

  it('is cleared explicitly', async () => {
    await markTokenRevoked(TOKEN_A, statePath);
    await clearTokenRevoked(statePath);

    expect(await isTokenRevoked(TOKEN_A, statePath)).toBe(false);
    expect(await readState(statePath)).toEqual({});
  });

  it('keeps the throttle state when the flag is cleared', async () => {
    await mergeState({ lastPostAt: 99 }, statePath);
    await markTokenRevoked(TOKEN_A, statePath);
    await clearTokenRevoked(statePath);

    expect(await readState(statePath)).toEqual({ lastPostAt: 99 });
  });

  it('clearing nothing writes nothing', async () => {
    await clearTokenRevoked(statePath);
    expect(await readState(statePath)).toEqual({});
  });
});
