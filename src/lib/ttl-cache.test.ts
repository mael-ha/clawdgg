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
