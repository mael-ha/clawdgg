import { afterEach, describe, expect, it } from 'bun:test';
import { startWarmJob, stopWarmJob, warmCycle, warmingEnabled } from './warm';

/**
 * The cycle is driven directly with injected deps — no timers, no ClickHouse.
 * What is worth holding here is not "does it call the three warmers", it is the
 * three properties that decide whether this job can hurt the site: it holds one
 * user's fan-out at a time, it does not abort on a bad user, and it cannot run
 * twice at once.
 */

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A warmUser that records how many were in flight at once. */
function tracker(delayMs = 0) {
  const seen: string[] = [];
  let inFlight = 0;
  let peak = 0;

  return {
    seen,
    get peak() {
      return peak;
    },
    async warm(username: string) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      seen.push(username);
      if (delayMs > 0) await tick(delayMs);
      inFlight--;
    },
  };
}

const quiet = () => {};

describe('warmCycle', () => {
  it('warms every user, one at a time', async () => {
    const t = tracker(5);
    const report = await warmCycle({
      listUsers: async () => ['a', 'b', 'c'],
      warmUser: t.warm,
      log: quiet,
    });

    expect(report).not.toBeNull();
    expect(report!.users).toBe(3);
    expect(report!.warmed).toBe(3);
    expect(report!.failed).toBe(0);
    expect(t.seen).toEqual(['a', 'b', 'c']);
    // The whole point of the sequential walk: never more than one user's
    // ClickHouse fan-out in the 4-permit limiter at a time.
    expect(t.peak).toBe(1);
  });

  it('counts a failing user and carries on with the rest', async () => {
    const seen: string[] = [];
    const report = await warmCycle({
      listUsers: async () => ['a', 'boom', 'c'],
      warmUser: async (username) => {
        seen.push(username);
        if (username === 'boom') throw new Error('clickhouse said no');
      },
      log: quiet,
    });

    expect(seen).toEqual(['a', 'boom', 'c']);
    expect(report!.warmed).toBe(2);
    expect(report!.failed).toBe(1);
  });

  it('skips a cycle while the previous one is still running', async () => {
    const first = tracker(40);
    const second = tracker();

    const running = warmCycle({
      listUsers: async () => ['a', 'b'],
      warmUser: first.warm,
      log: quiet,
    });
    // Let the first cycle get past its own list read and into the walk.
    await tick(10);

    const overlapping = await warmCycle({
      listUsers: async () => ['a', 'b'],
      warmUser: second.warm,
      log: quiet,
    });

    expect(overlapping).toBeNull();
    expect(second.seen).toEqual([]);

    const report = await running;
    expect(report!.warmed).toBe(2);

    // And the guard is released, so the next cycle runs.
    const next = await warmCycle({
      listUsers: async () => ['a'],
      warmUser: second.warm,
      log: quiet,
    });
    expect(next!.warmed).toBe(1);
  });

  it('survives a user list that throws, and warms nothing', async () => {
    const report = await warmCycle({
      listUsers: async () => {
        throw new Error('sqlite is locked');
      },
      warmUser: async () => expect.unreachable('nothing to warm'),
      log: quiet,
    });

    expect(report).toEqual({ users: 0, warmed: 0, failed: 0, ms: report!.ms });
  });

  it('logs one line per cycle, with timings', async () => {
    const lines: string[] = [];
    await warmCycle({
      listUsers: async () => ['a', 'b'],
      warmUser: async () => {},
      log: (line) => lines.push(line),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2/2 warmed');
    expect(lines[0]).toContain('0 failed');
    expect(lines[0]).toMatch(/\d+ms/);
  });
});

describe('WARM_PROFILES', () => {
  const before = process.env.WARM_PROFILES;

  afterEach(() => {
    stopWarmJob();
    if (before === undefined) delete process.env.WARM_PROFILES;
    else process.env.WARM_PROFILES = before;
  });

  it('is on by default', () => {
    delete process.env.WARM_PROFILES;
    expect(warmingEnabled()).toBe(true);
    expect(startWarmJob()).toBe(true);
  });

  it('schedules nothing when set to 0', () => {
    process.env.WARM_PROFILES = '0';
    expect(warmingEnabled()).toBe(false);
    expect(startWarmJob()).toBe(false);
  });

  it('is only disabled by exactly 0 — anything else is on', () => {
    process.env.WARM_PROFILES = '1';
    expect(warmingEnabled()).toBe(true);
    process.env.WARM_PROFILES = 'true';
    expect(warmingEnabled()).toBe(true);
  });
});
