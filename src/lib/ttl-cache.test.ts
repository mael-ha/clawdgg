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

  it('evicts the least recently used once over budget', async () => {
    const cache = new TtlCache<number>(1000, 3);
    for (const key of ['a', 'b', 'c', 'd']) cache.set(key, 1);

    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe(1);
  });

  it('keeps a replaced value in its place: reading it is what moves it', () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 1);
    cache.set('a', 2);
    cache.set('c', 1);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(1);
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

describe('LRU', () => {
  it('evicts the least recently READ entry, not the oldest inserted', () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now the most recent
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('does not count a refresh as a use', async () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('b')).toBe(2);
    // A rebuild of `a` replaces its value, and `a` is still the one nobody read.
    await cache.refresh('a', async () => 10);
    cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBe(2);
  });

  it('holds at most its budget however many keys pass through it', async () => {
    const cache = new TtlCache<number>(60_000, 500);
    for (let i = 0; i < 2_000; i++) await cache.remember(`user-${i}`, async () => i);
    expect(cache.size).toBe(500);
    expect(cache.get('user-1999')).toBe(1999);
    expect(cache.get('user-0')).toBeUndefined();
  });
});

describe('readWithin and ageMs', () => {
  it('says whether a key was read lately, and a refresh is not a read', async () => {
    const cache = new TtlCache<number>(60_000);
    await cache.refresh('k', async () => 1);
    expect(cache.readWithin('k', 1_000)).toBe(false);

    expect(await cache.remember('k', async () => 2)).toBe(1);
    expect(cache.readWithin('k', 1_000)).toBe(true);
    await tick(20);
    expect(cache.readWithin('k', 10)).toBe(false);

    // The value is replaced; the record of who read it is not.
    await cache.refresh('k', async () => 3);
    expect(cache.readWithin('k', 1_000)).toBe(true);
    expect(cache.readWithin('missing', 1_000)).toBe(false);
  });

  it('counts the first build as a read by the caller who asked for it', async () => {
    const cache = new TtlCache<number>(60_000);
    await cache.remember('k', async () => 1);
    expect(cache.readWithin('k', 1_000)).toBe(true);
  });

  it('reports the age of the value being served, reset by a rebuild', async () => {
    const cache = new TtlCache<number>(60_000);
    expect(cache.ageMs('k')).toBeUndefined();
    cache.set('k', 1);
    await tick(25);
    expect(cache.ageMs('k')!).toBeGreaterThanOrEqual(20);
    await cache.refresh('k', async () => 2);
    expect(cache.ageMs('k')!).toBeLessThan(20);
  });
});

describe('refresh', () => {
  it('rebuilds a cached entry and waits for it', async () => {
    const cache = new TtlCache<number>(10_000);
    let builds = 0;
    const build = async () => {
      builds++;
      await tick(15);
      return builds;
    };

    await cache.remember('k', build);
    expect(await cache.refresh('k', build)).toBe(2);
    expect(cache.get('k')).toBe(2);
  });

  it('keeps serving the previous value while the rebuild runs', async () => {
    const cache = new TtlCache<number>(10_000);
    let release: ((value: number) => void) | undefined;
    cache.set('k', 1);

    const rebuilding = cache.refresh('k', () => new Promise<number>((r) => (release = r)));
    expect(await cache.remember('k', async () => 99)).toBe(1);
    release!(2);
    expect(await rebuilding).toBe(2);
    expect(cache.get('k')).toBe(2);
  });

  it('leaves the previous value when the rebuild throws', async () => {
    const cache = new TtlCache<string>(10_000);
    cache.set('k', 'good');
    expect(cache.refresh('k', async () => { throw new Error('down'); })).rejects.toThrow('down');
    await tick(5);
    expect(cache.get('k')).toBe('good');
  });

  it('leaves the previous value when the rebuild comes back degraded', async () => {
    const cache = new TtlCache<{ ok: boolean }>(10_000);
    const good = { ok: true };
    cache.set('k', good);
    await cache.refresh('k', async () => ({ ok: false }), (v) => v.ok);
    expect(cache.get('k')).toBe(good);
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
    const cache = new TtlCache<string>(10_000);
    let release: ((value: string) => void) | undefined;
    const slowBuild = () => new Promise<string>((resolve) => (release = resolve));

    cache.set('mael|public|', 'shows 💎 value');
    // The refresh job starts a rebuild; the old value keeps serving meanwhile.
    const rebuilding = cache.refresh('mael|public|', slowBuild);
    expect(await cache.remember('mael|public|', slowBuild)).toBe('shows 💎 value');

    // The owner hides 💎 while that rebuild is in the air.
    cache.deletePrefix('mael|');
    expect(cache.get('mael|public|')).toBeUndefined();

    // The pre-eviction build lands.
    release!('shows 💎 value');
    await rebuilding;

    // It is gone: the next read is a hard miss and builds afresh.
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
