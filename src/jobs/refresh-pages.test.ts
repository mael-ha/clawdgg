import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  MAX_DIRTY_MS,
  QUIET_MS,
  dueUsers,
  isDirty,
  markDirty,
  refreshNow,
  resetDirty,
} from '../lib/dirty';
import {
  evictPublicFingerprint,
  publicFingerprint,
  publicFingerprintBuilds,
  refreshPublicFingerprint,
  resetPublicFingerprintCache,
} from '../lib/public-fingerprint';
import { insert } from '../db/clickhouse';
import {
  refreshCycle,
  setRefreshSteps,
  startRefreshJob,
  stopRefreshJob,
  type RefreshSteps,
} from './refresh-pages';
import { pageMarkReason, syncKey } from './sync-clickhouse';

/**
 * The job's claims are COST claims — an idle server does no ClickHouse work, a
 * refreshed page costs its next reader nothing — so ClickHouse is counted, not
 * described: `fetch` is stubbed and every call to it recorded, the technique
 * src/lib/public-fingerprint.test.ts uses. The steps are swapped for ones that
 * need no SQLite (this process's database has no tables), except where the
 * test is that the REAL steps are never reached.
 */

const USER = { id: 'github_refresh', githubUsername: 'refresh', timezone: 'Europe/Paris' };

const realFetch = globalThis.fetch;
let chCalls = 0;
let gate: Promise<void> | null = null;

function stubClickHouse(): void {
  globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
    chCalls++;
    if (gate) await gate;
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

/** A mark old enough to be due now. */
function markDue(userId: string, reason = 'events_raw'): void {
  markDirty(userId, reason, Date.now() - QUIET_MS - 1);
}

function counting(overrides: Partial<RefreshSteps> = {}) {
  const calls = { users: [] as string[], boards: 0 };
  const steps: RefreshSteps = {
    rebuildUser: async (userId) => {
      calls.users.push(userId);
      await refreshPublicFingerprint(USER, []);
    },
    rebuildBoards: async () => {
      calls.boards++;
    },
    ...overrides,
  };
  setRefreshSteps(steps);
  return calls;
}

const quiet = () => {};

beforeEach(() => {
  resetDirty();
  resetPublicFingerprintCache();
  chCalls = 0;
  gate = null;
  stubClickHouse();
});

afterEach(() => {
  stopRefreshJob();
  setRefreshSteps(null);
  globalThis.fetch = realFetch;
  resetDirty();
  resetPublicFingerprintCache();
});

describe('a mark, a refresh, a free read', () => {
  it('rebuilds a due user, after which the next read asks ClickHouse nothing', async () => {
    counting();
    await publicFingerprint(USER, []);
    markDue(USER.id);

    const before = chCalls;
    const report = await refreshCycle(quiet);
    expect(report).toMatchObject({ users: 1, refreshed: 1, failed: 0 });
    expect(chCalls).toBeGreaterThan(before);
    expect(isDirty(USER.id)).toBe(false);

    const afterRefresh = chCalls;
    const builds = publicFingerprintBuilds();
    await publicFingerprint(USER, []);
    expect(chCalls).toBe(afterRefresh);
    expect(publicFingerprintBuilds()).toBe(builds);
  });

  it('waits for a burst to go quiet, but not for ever', async () => {
    const calls = counting();
    markDirty(USER.id, 'events_raw');
    await refreshCycle(quiet);
    expect(calls.users).toEqual([]);

    const now = Date.now();
    markDirty('github_busy', 'events_raw', now - MAX_DIRTY_MS - 1);
    markDirty('github_busy', 'events_raw', now);
    expect(dueUsers(now)).toEqual(['github_busy']);
  });
});

describe('an idle server', () => {
  it('asks ClickHouse nothing over many ticks, with the real steps', async () => {
    setRefreshSteps(null);
    for (let i = 0; i < 20; i++) {
      const report = await refreshCycle(quiet);
      expect(report).toMatchObject({ users: 0, refreshed: 0, boards: false });
    }
    expect(chCalls).toBe(0);
  });

  it('logs nothing for a cycle that did nothing, and one line for one that did', async () => {
    counting();
    const lines: string[] = [];
    await refreshCycle((line) => lines.push(line));
    expect(lines).toEqual([]);

    markDue(USER.id);
    await refreshCycle((line) => lines.push(line));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^\[refresh\] cycle: 1\/1 users refreshed, 0 failed, boards rebuilt, \d+ms$/);
  });
});

describe('a write during a rebuild', () => {
  it('keeps its mark, and the next cycle rebuilds again', async () => {
    let release!: () => void;
    const calls = counting({
      rebuildUser: async (userId) => {
        calls.users.push(userId);
        if (calls.users.length === 1) await new Promise<void>((r) => (release = r));
      },
    });
    markDue(USER.id);

    const cycle = refreshCycle(quiet);
    await new Promise((r) => setTimeout(r, 5));
    // The rebuild has read the rows; this write lands after it did.
    markDirty(USER.id, 'events_raw', Date.now() - QUIET_MS);
    release();
    await cycle;

    expect(isDirty(USER.id)).toBe(true);
    await refreshCycle(quiet);
    expect(calls.users).toEqual([USER.id, USER.id]);
    expect(isDirty(USER.id)).toBe(false);
  });

  it('keeps the mark of a user whose rebuild failed, and backs off', async () => {
    const calls = counting({
      rebuildUser: async (userId) => {
        calls.users.push(userId);
        throw new Error('clickhouse is having a day');
      },
    });
    const errors = console.error;
    console.error = () => {};
    try {
      markDue(USER.id);
      expect(await refreshCycle(quiet)).toMatchObject({ refreshed: 0, failed: 1 });
      expect(isDirty(USER.id)).toBe(true);
      // Not again on the next tick: the back-off is a minute.
      await refreshCycle(quiet);
      expect(calls.users).toEqual([USER.id]);
    } finally {
      console.error = errors;
    }
  });
});

describe('a visibility toggle beats a refresh in flight', () => {
  it('leaves a hard miss behind, not the payload the refresh was building', async () => {
    counting();
    await publicFingerprint(USER, []);
    markDue(USER.id);

    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const cycle = refreshCycle(quiet);
    await new Promise((r) => setTimeout(r, 5));

    // PUT /api/me/profile-settings, while the rebuild is waiting on ClickHouse.
    evictPublicFingerprint(USER.id);
    gate = null;
    release();
    await cycle;

    const builds = publicFingerprintBuilds();
    await publicFingerprint(USER, []);
    expect(publicFingerprintBuilds()).toBe(builds + 1);
  });
});

describe('the board figures', () => {
  it('are rebuilt once however many users changed, then not again within the minute', async () => {
    const calls = counting();
    for (const id of ['github_a', 'github_b', 'github_c']) markDue(id);
    await refreshCycle(quiet);
    expect(calls.boards).toBe(1);

    markDue('github_d');
    await refreshCycle(quiet);
    expect(calls.users).toEqual(['github_a', 'github_b', 'github_c', 'github_d']);
    expect(calls.boards).toBe(1);
  });

  it('are not touched by a visibility change on its own', async () => {
    const calls = counting();
    markDue(USER.id, 'visibility');
    await refreshCycle(quiet);
    expect(calls.users).toEqual([USER.id]);
    expect(calls.boards).toBe(0);
  });
});

describe("the owner's own page", () => {
  it('is rebuilt on the spot when they are dirty, without waiting to be due', async () => {
    const calls = counting();
    startRefreshJob();
    markDirty(USER.id, 'events_raw');

    await refreshNow(USER.id);
    expect(calls.users).toEqual([USER.id]);
    expect(isDirty(USER.id)).toBe(false);

    // Clean: nothing to do.
    await refreshNow(USER.id);
    expect(calls.users).toEqual([USER.id]);
  });

  it('joins the rebuild the job already has in flight', async () => {
    let release!: () => void;
    const calls = counting({
      rebuildUser: async (userId) => {
        calls.users.push(userId);
        await new Promise<void>((r) => (release = r));
      },
    });
    startRefreshJob();
    markDue(USER.id);

    const cycle = refreshCycle(quiet);
    await new Promise((r) => setTimeout(r, 5));
    const owner = refreshNow(USER.id);
    release();
    await Promise.all([cycle, owner]);

    expect(calls.users).toEqual([USER.id]);
    expect(isDirty(USER.id)).toBe(false);
  });

  it('does nothing when no job is running', async () => {
    const calls = counting();
    markDirty(USER.id, 'events_raw');
    await refreshNow(USER.id);
    expect(calls.users).toEqual([]);
  });
});

describe('insert() marks the users it wrote', () => {
  it('marks every distinct user in a batch that landed', async () => {
    await insert('events_raw', [
      { user_id: 'github_one', row_id: 'r1' },
      { user_id: 'github_two', row_id: 'r2' },
      { user_id: 'github_one', row_id: 'r3' },
    ]);
    expect(isDirty('github_one')).toBe(true);
    expect(isDirty('github_two')).toBe(true);
  });

  it('marks nothing when the insert failed', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const errors = console.error;
    console.error = () => {};
    try {
      await expect(insert('events_raw', [{ user_id: 'github_one', row_id: 'r1' }])).rejects.toThrow();
    } finally {
      console.error = errors;
    }
    expect(isDirty('github_one')).toBe(false);
  });
});

describe('pageMarkReason — what the sync job marks', () => {
  const key = (watermark: string, today = '2026-10-20', timezone = 'Europe/Paris') =>
    syncKey(watermark, timezone, today, 7);
  const w1 = 'e=10:2026-10-20 09:00:00.000|m=20:2026-10-20 09:00:00.000';
  const w2 = 'e=11:2026-10-20 09:05:00.000|m=20:2026-10-20 09:00:00.000';

  it('marks nothing on a first pass, or for a key that did not move', () => {
    expect(pageMarkReason(undefined, key(w1), undefined, 1_000)).toBeNull();
    expect(pageMarkReason(key(w1), key(w1), undefined, 1_000)).toBeNull();
  });

  it('marks a new local day, and a new zone', () => {
    expect(pageMarkReason(key(w1), key(w1, '2026-10-21'), undefined, 1_000)).toBe('clock');
    expect(pageMarkReason(key(w1), key(w1, '2026-10-20', 'Asia/Tokyo'), undefined, 1_000)).toBe('clock');
  });

  it('marks rows another process wrote, and not rows this one already marked', () => {
    expect(pageMarkReason(key(w1), key(w2), undefined, 1_000)).toBe('rows');
    expect(pageMarkReason(key(w1), key(w2), 500, 1_000)).toBe('rows');
    expect(pageMarkReason(key(w1), key(w2), 1_500, 1_000)).toBeNull();
  });
});
