import { describe, expect, it } from 'bun:test';
import { TtlCache } from './ttl-cache';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TtlCache', () => {
  it('returns a stored value until it expires', async () => {
    const cache = new TtlCache<string>(30);
    cache.set('a', 'first');
    expect(cache.get('a')).toBe('first');
    await tick(45);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('builds once per key, then serves the cached value', async () => {
    const cache = new TtlCache<number>(1000);
    let builds = 0;
    const build = async () => ++builds;

    expect(await cache.remember('k', build)).toBe(1);
    expect(await cache.remember('k', build)).toBe(1);
    expect(builds).toBe(1);
  });

  it('collapses concurrent builds of the same key', async () => {
    const cache = new TtlCache<number>(1000);
    let builds = 0;
    const build = async () => {
      builds++;
      await tick(20);
      return builds;
    };

    const results = await Promise.all([
      cache.remember('hot', build),
      cache.remember('hot', build),
      cache.remember('hot', build),
    ]);

    expect(builds).toBe(1);
    expect(results).toEqual([1, 1, 1]);
  });

  it('does not cache a failed build, and lets the next caller retry', async () => {
    const cache = new TtlCache<string>(1000);
    let attempts = 0;
    const build = async () => {
      attempts++;
      if (attempts === 1) throw new Error('clickhouse is having a day');
      return 'recovered';
    };

    expect(cache.remember('k', build)).rejects.toThrow('clickhouse is having a day');
    await tick(5);
    expect(await cache.remember('k', build)).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('evicts oldest-first once over budget', async () => {
    const cache = new TtlCache<number>(1000, 3);
    for (const key of ['a', 'b', 'c', 'd']) cache.set(key, 1);

    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe(1);
  });

  it('counts a re-set key as freshly inserted', () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 1);
    cache.set('a', 2);
    cache.set('c', 1);

    expect(cache.get('a')).toBe(2);
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('remember(shouldCache)', () => {
  it('serves a rejected value without remembering it', async () => {
    const cache = new TtlCache<{ ok: boolean; n: number }>(60_000);
    let builds = 0;
    const build = async () => ({ ok: false, n: ++builds });
    const keep = (v: { ok: boolean }) => v.ok;

    expect(await cache.remember('k', build, keep)).toEqual({ ok: false, n: 1 });
    expect(cache.get('k')).toBeUndefined();
    // Next request retries rather than serving the degraded value for a minute.
    expect(await cache.remember('k', build, keep)).toEqual({ ok: false, n: 2 });
    expect(builds).toBe(2);
  });

  it('remembers an accepted value as usual', async () => {
    const cache = new TtlCache<{ ok: boolean; n: number }>(60_000);
    let builds = 0;
    const build = async () => ({ ok: true, n: ++builds });
    const keep = (v: { ok: boolean }) => v.ok;

    expect(await cache.remember('k', build, keep)).toEqual({ ok: true, n: 1 });
    expect(await cache.remember('k', build, keep)).toEqual({ ok: true, n: 1 });
    expect(builds).toBe(1);
  });

  it('still single-flights a value it will not cache', async () => {
    const cache = new TtlCache<{ ok: boolean }>(60_000);
    let builds = 0;
    const build = async () => {
      builds++;
      await Promise.resolve();
      return { ok: false };
    };
    const [a, b] = await Promise.all([
      cache.remember('k', build, v => v.ok),
      cache.remember('k', build, v => v.ok),
    ]);
    expect(a).toBe(b);
    expect(builds).toBe(1);
  });
});

describe('stale-while-revalidate', () => {
  it('serves a fresh entry without rebuilding', async () => {
    const cache = new TtlCache<number>(1000, 500, { staleMs: 1000 });
    let builds = 0;
    const build = async () => ++builds;

    expect(await cache.remember('k', build)).toBe(1);
    expect(await cache.remember('k', build)).toBe(1);
    expect(builds).toBe(1);
  });

  it('serves a stale entry at once and rebuilds it exactly once behind it', async () => {
    const cache = new TtlCache<number>(20, 500, { staleMs: 10_000 });
    let builds = 0;
    const build = async () => {
      builds++;
      await tick(30);
      return builds;
    };

    expect(await cache.remember('k', build)).toBe(1);
    await tick(30);

    // Five callers inside the stale window: all get build 1 immediately, and
    // between them they trigger ONE rebuild, not five.
    const served = await Promise.all([
      cache.remember('k', build),
      cache.remember('k', build),
      cache.remember('k', build),
      cache.remember('k', build),
      cache.remember('k', build),
    ]);
    expect(served).toEqual([1, 1, 1, 1, 1]);
    expect(builds).toBe(2);

    await tick(40);
    expect(cache.get('k')).toBe(2);
    expect(builds).toBe(2);
  });

  it('collapses ten cold callers past the stale window into one build', async () => {
    const cache = new TtlCache<number>(10, 500, { staleMs: 10 });
    let builds = 0;
    const build = async () => {
      builds++;
      await tick(25);
      return builds;
    };

    expect(await cache.remember('k', build)).toBe(1);
    await tick(35); // past ttl AND past the stale window

    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.remember('k', build))
    );
    expect(results).toEqual(Array.from({ length: 10 }, () => 2));
    expect(builds).toBe(2);
  });

  it('keeps serving the stale value when the background rebuild throws', async () => {
    const cache = new TtlCache<string>(20, 500, { staleMs: 10_000 });
    let builds = 0;
    const build = async () => {
      builds++;
      if (builds > 1) throw new Error('clickhouse is having a day');
      return 'good';
    };

    expect(await cache.remember('k', build)).toBe('good');
    await tick(30);

    // The failure is logged, never cached, and never reaches this caller.
    expect(await cache.remember('k', build)).toBe('good');
    await tick(10);
    expect(builds).toBe(2);
    expect(await cache.remember('k', build)).toBe('good');
  });

  it('keeps serving the stale value when the rebuild comes back degraded', async () => {
    const cache = new TtlCache<{ ok: boolean; n: number }>(20, 500, { staleMs: 10_000 });
    let builds = 0;
    const build = async () => ({ ok: builds++ === 0, n: builds });
    const keep = (v: { ok: boolean }) => v.ok;

    expect(await cache.remember('k', build, keep)).toEqual({ ok: true, n: 1 });
    await tick(30);

    expect(await cache.remember('k', build, keep)).toEqual({ ok: true, n: 1 });
    await tick(10);
    // The degraded build was not written over the last good one.
    expect(await cache.remember('k', build, keep)).toEqual({ ok: true, n: 1 });
  });

  it('throws past the stale window, with nothing left to serve', async () => {
    const cache = new TtlCache<string>(10, 500, { staleMs: 10 });
    let builds = 0;
    const build = async () => {
      if (builds++ > 0) throw new Error('down');
      return 'good';
    };

    expect(await cache.remember('k', build)).toBe('good');
    await tick(35);
    expect(cache.remember('k', build)).rejects.toThrow('down');
  });

  it('is a plain ttl cache when no stale window is given', async () => {
    const cache = new TtlCache<number>(20);
    let builds = 0;
    const build = async () => ++builds;

    expect(await cache.remember('k', build)).toBe(1);
    await tick(30);
    expect(await cache.remember('k', build)).toBe(2);
  });
});

describe('refresh', () => {
  // The warmer's entry point: it must WAIT for the rebuild, or walking users
  // one at a time would still put every user's fan-out in flight at once.
  it('rebuilds a stale entry and waits for it', async () => {
    const cache = new TtlCache<number>(20, 500, { staleMs: 10_000 });
    let builds = 0;
    const build = async () => {
      builds++;
      await tick(15);
      return builds;
    };

    await cache.remember('k', build);
    await tick(30);

    expect(await cache.refresh('k', build)).toBe(2);
    expect(cache.get('k')).toBe(2);
  });

  it('rebuilds a fresh entry too, rather than returning it', async () => {
    const cache = new TtlCache<number>(10_000, 500, { staleMs: 10_000 });
    let builds = 0;
    const build = async () => ++builds;

    await cache.remember('k', build);
    expect(await cache.refresh('k', build)).toBe(2);
  });

  it('joins a build already in flight instead of starting a second', async () => {
    const cache = new TtlCache<number>(10_000);
    let builds = 0;
    const build = async () => {
      builds++;
      await tick(20);
      return builds;
    };

    const [a, b] = await Promise.all([cache.remember('k', build), cache.refresh('k', build)]);
    expect(a).toBe(b);
    expect(builds).toBe(1);
  });
});

describe('eviction vs a build already in flight', () => {
  /**
   * THE PRIVACY RULE. An owner hides a section; the route evicts the keys for
   * that user. A rebuild that started BEFORE the toggle was saved is still in
   * flight and would otherwise land after the delete and re-insert the
   * pre-toggle payload — serving the figure they just took down for the rest
   * of the window, after the UI said it was saved.
   */
  it('does not let a rebuild that started before the eviction re-insert its value', async () => {
    const cache = new TtlCache<string>(20, 500, { staleMs: 10_000 });
    let release: ((value: string) => void) | undefined;
    const slowBuild = () => new Promise<string>((resolve) => (release = resolve));

    cache.set('mael|public|', 'shows 💎 value');
    await tick(30); // now stale: the next read serves it and rebuilds behind it

    expect(await cache.remember('mael|public|', slowBuild)).toBe('shows 💎 value');
    expect(release).toBeDefined();

    // The owner hides 💎 while that rebuild is in the air.
    cache.deletePrefix('mael|');
    expect(cache.get('mael|public|')).toBeUndefined();

    // The pre-eviction build lands.
    release!('shows 💎 value');
    await tick(10);

    // It is gone, not stale: the next read is a hard miss and builds afresh.
    expect(cache.get('mael|public|')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(await cache.remember('mael|public|', async () => 'no 💎')).toBe('no 💎');
  });

  it('invalidates a single evicted key and leaves another in-flight build alone', async () => {
    const cache = new TtlCache<string>(10_000);
    let releaseA: ((value: string) => void) | undefined;
    let releaseB: ((value: string) => void) | undefined;

    const a = cache.remember('a', () => new Promise<string>((r) => (releaseA = r)));
    const b = cache.remember('b', () => new Promise<string>((r) => (releaseB = r)));

    cache.delete('a');
    releaseA!('a-value');
    releaseB!('b-value');
    expect(await a).toBe('a-value');
    expect(await b).toBe('b-value');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('b-value');
  });

  it('invalidates every in-flight build on clear', async () => {
    const cache = new TtlCache<string>(10_000);
    let release: ((value: string) => void) | undefined;
    const pending = cache.remember('k', () => new Promise<string>((r) => (release = r)));

    cache.clear();
    release!('late');
    expect(await pending).toBe('late');
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('delete', () => {
  // A settings toggle evicts its own keys, so the change is visible at once
  // rather than after the TTL — a minute of staleness reads as "it didn't save".
  it('forgets one key and leaves the others', () => {
    const cache = new TtlCache<string>(60_000);
    cache.set('a', 'one');
    cache.set('b', 'two');

    cache.delete('a');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('two');
    expect(cache.size).toBe(1);
  });

  it('is a no-op for a key that is not there', () => {
    const cache = new TtlCache<string>(60_000);
    cache.set('a', 'one');
    cache.delete('nope');
    expect(cache.get('a')).toBe('one');
  });
});
