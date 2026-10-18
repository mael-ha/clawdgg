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
