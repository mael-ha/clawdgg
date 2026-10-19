import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getFingerprint } from './fingerprint';
import {
  evictPublicFingerprint,
  publicFingerprint,
  publicFingerprintBuilds,
  refreshPublicFingerprint,
  resetPublicFingerprintCache,
} from './public-fingerprint';

/**
 * The claim under test is a COST claim: the profile page, the share card and
 * /api/u/:username/fingerprint are three readers of one payload, and together
 * they cost one ClickHouse fan-out rather than three.
 *
 * So the fan-out is counted, not described. `fetch` is stubbed and every SQL
 * body it is handed is recorded — the same technique as
 * src/lib/profile-data.test.ts, and for the same reason: `mock.module` would
 * swap the module out for every other suite in this process.
 *
 * The suite calibrates its own baseline rather than hardcoding 13. The
 * fingerprint's query count is not this file's business and the peer/active
 * caches inside src/lib/fingerprint.ts are process-wide, so "one fan-out" is
 * measured here and the comparisons are made against it.
 */

const USER = { id: 'github_warm', githubUsername: 'warm', timezone: 'Europe/Paris' };

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const realFetch = globalThis.fetch;

/** Every SQL body the reads send, answered with an empty result set. */
async function capture(run: () => Promise<unknown>): Promise<string[]> {
  const sqls: string[] = [];
  globalThis.fetch = ((_input: any, init: any) => {
    sqls.push(String(init?.body ?? ''));
    return Promise.resolve(new Response('', { status: 200 }));
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return sqls;
}

/** One uncached public build, which is the unit every count below is in. */
async function oneFanOut(): Promise<number> {
  resetPublicFingerprintCache();
  const sqls = await capture(() => publicFingerprint(USER, []));
  resetPublicFingerprintCache();
  return sqls.length;
}

beforeEach(() => {
  resetPublicFingerprintCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPublicFingerprintCache();
});

describe('one public fingerprint for all three surfaces', () => {
  it('costs one fan-out where three separate builds cost three', async () => {
    // Warm the process-wide peer/active-user caches in fingerprint.ts first, so
    // neither measurement below is the one that pays for them.
    await capture(() => publicFingerprint(USER, []));
    const unit = await oneFanOut();
    expect(unit).toBeGreaterThan(5);

    // BEFORE: the page, the API and the card each called getFingerprint.
    const separate = await capture(() =>
      Promise.all([
        getFingerprint(USER.id, {
          username: USER.githubUsername,
          timezone: USER.timezone,
          isOwner: false,
          hidden: [],
        }),
        getFingerprint(USER.id, {
          username: USER.githubUsername,
          timezone: USER.timezone,
          isOwner: false,
          hidden: [],
        }),
        getFingerprint(USER.id, {
          username: USER.githubUsername,
          timezone: USER.timezone,
          isOwner: false,
          hidden: [],
        }),
      ])
    );
    expect(separate.length).toBe(unit * 3);

    // AFTER: all three go through the shared cache. Single-flight per key, so
    // the first to ask builds it and the other two wait on that build.
    resetPublicFingerprintCache();
    const shared = await capture(() =>
      Promise.all([
        publicFingerprint(USER, []),
        publicFingerprint(USER, []),
        publicFingerprint(USER, []),
      ])
    );
    expect(shared.length).toBe(unit);
  });

  it('builds once per user per cycle, counted', async () => {
    await capture(() => publicFingerprint(USER, []));
    resetPublicFingerprintCache();

    const before = publicFingerprintBuilds();
    await capture(() =>
      Promise.all([
        publicFingerprint(USER, []),
        publicFingerprint(USER, []),
        publicFingerprint(USER, []),
      ])
    );
    expect(publicFingerprintBuilds() - before).toBe(1);

    // And the warmer's refresh plus the two surfaces that read it afterwards:
    // one more build in total, not three.
    const warmed = publicFingerprintBuilds();
    await capture(async () => {
      await refreshPublicFingerprint(USER, []);
      await publicFingerprint(USER, []);
      await publicFingerprint(USER, []);
    });
    expect(publicFingerprintBuilds() - warmed).toBe(1);
  });

  it('keys by the hidden list, so two filtered payloads are two entries', async () => {
    await capture(() => publicFingerprint(USER, []));
    const before = publicFingerprintBuilds();

    await capture(async () => {
      await publicFingerprint(USER, ['value']);
      await publicFingerprint(USER, ['value']);
      await publicFingerprint(USER, ['value', 'anatomy']);
    });

    // Two lists, two builds — a payload filtered by one list must never be
    // served under another.
    expect(publicFingerprintBuilds() - before).toBe(2);
  });
});

describe('a toggle evicts the shared entry', () => {
  /**
   * THE PRIVACY RULE, now with one entry behind all three surfaces: if the
   * eviction missed, the page, the card AND the API would every one of them go
   * on showing the section the owner just took down.
   */
  it('makes the next read of every surface a rebuild', async () => {
    await capture(() => publicFingerprint(USER, []));
    const cached = publicFingerprintBuilds();

    // Cached: no build, whoever asks.
    await capture(async () => {
      await publicFingerprint(USER, []);
      await publicFingerprint(USER, []);
    });
    expect(publicFingerprintBuilds()).toBe(cached);

    evictPublicFingerprint(USER.id);

    // The page's read rebuilds; the card's and the API's then share that one.
    await capture(async () => {
      await publicFingerprint(USER, []);
      await publicFingerprint(USER, []);
      await publicFingerprint(USER, []);
    });
    expect(publicFingerprintBuilds() - cached).toBe(1);
  });

  it('beats a build that was already in flight when the toggle was saved', async () => {
    // Every query parked, nothing answered: the build is unambiguously in the
    // air. They are parked rather than slow because the reads go through a
    // process-wide 4-permit limiter, so a query left hanging holds a permit —
    // all of them get answered below before this test lets go.
    const parked: ((response: Response) => void)[] = [];
    globalThis.fetch = ((_input: any, _init: any) =>
      new Promise<Response>((resolve) => {
        parked.push(resolve);
      })) as typeof fetch;

    const inFlight = publicFingerprint(USER, []).catch(() => 'threw');
    await tick(20);
    expect(parked.length).toBeGreaterThan(0);

    // The owner hides a section while that build is still running.
    evictPublicFingerprint(USER.id);

    // Now let it finish, however it likes. Drained on a timer because the
    // limiter releases the next four queries only as these settle.
    const drain = setInterval(() => {
      while (parked.length) parked.shift()!(new Response('', { status: 200 }));
    }, 1);
    await inFlight;
    clearInterval(drain);

    globalThis.fetch = realFetch;

    // It did not re-insert itself: the next read is a hard miss and builds.
    const before = publicFingerprintBuilds();
    await capture(() => publicFingerprint(USER, []));
    expect(publicFingerprintBuilds() - before).toBe(1);
  });

  it('evicts one user without touching another', async () => {
    const other = { id: 'github_other', githubUsername: 'other', timezone: 'UTC' };

    await capture(async () => {
      await publicFingerprint(USER, []);
      await publicFingerprint(other, []);
    });

    evictPublicFingerprint(USER.id);

    const before = publicFingerprintBuilds();
    await capture(async () => {
      await publicFingerprint(other, []);
    });
    expect(publicFingerprintBuilds()).toBe(before);
  });
});

describe('the owner view is not in here', () => {
  /**
   * Structural, not a key convention: there is no owner flag to pass. The two
   * things that make a payload public are hardcoded in the module, so no
   * caller — present or future — can put an owner's payload where the card and
   * the API read from. Asserted on the source, because the claim is about what
   * the code CANNOT be made to do, which no call can demonstrate.
   */
  /**
   * The owner-only field, checked on the value and not just on the source:
   * FingerprintData.timezone is where somebody LIVES and a visitor is never
   * told it. If an owner payload ever reached this cache, this is the field
   * that would leak out of the card and the API with it.
   */
  it('serves a payload with the owner-only zone name absent', async () => {
    let data: Awaited<ReturnType<typeof publicFingerprint>> | undefined;
    await capture(async () => {
      data = await publicFingerprint(USER, ['value']);
    });

    expect(data).toBeDefined();
    expect(data!.timezone).toBeUndefined();
    // And it reports the gap rather than a wrong number.
    expect(data!.hidden).toContain('value');
    expect(data!.sections).not.toContain('value');
  });

  it('never asks getFingerprint for an owner payload', async () => {
    const source = await Bun.file(
      new URL('./public-fingerprint.ts', import.meta.url).pathname
    ).text();

    expect(source).toContain('isOwner: false');
    expect(source).not.toMatch(/isOwner:\s*true/);
    expect(source).not.toMatch(/isOwner,/);
  });

  it('is what the page, the card and the API all read', async () => {
    const dir = new URL('../routes/', import.meta.url).pathname;
    for (const file of ['profile.tsx', 'og.ts', 'api.ts']) {
      const source = await Bun.file(`${dir}${file}`).text();
      expect(source).toContain('public-fingerprint');
      expect(source).toMatch(/publicFingerprint\(/);
    }
  });

  it('leaves the only public getFingerprint call in this module', async () => {
    const dir = new URL('../routes/', import.meta.url).pathname;
    for (const file of ['profile.tsx', 'og.ts', 'api.ts']) {
      const source = await Bun.file(`${dir}${file}`).text();
      // The routes may still build the OWNER's payload directly. A public one
      // there would be a second fan-out and a second cache.
      expect(source).not.toMatch(/isOwner:\s*false/);
    }
  });
});
