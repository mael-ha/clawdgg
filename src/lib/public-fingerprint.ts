/**
 * ONE public fingerprint per user, shared by every surface that shows one.
 *
 * Three places asked ClickHouse the same thirteen questions about the same
 * person: src/routes/profile.tsx's page payload, src/routes/api.ts's
 * `/api/u/:username/fingerprint`, and src/routes/og.ts's share card. Each had
 * its own cache, each cache was keyed differently, and each therefore built
 * its own copy — so a cold profile cost 39 `... FINAL` reads through a
 * 4-permit limiter rather than 13, and the warmer paid that three times per
 * user per cycle.
 *
 * They are the SAME payload. All three call getFingerprint with
 * `isOwner: false` and the owner's hidden list; none of them can tell its copy
 * from another's. So there is one cache, here, and the three surfaces read it.
 * A cold profile, its card and its API response now share one fan-out — the
 * first of the three to ask builds it and the other two wait on that build
 * (TtlCache single-flights per key), rather than three builds racing each
 * other for the same four permits.
 *
 * THE OWNER'S VIEW IS NOT IN HERE AND CANNOT BE. An owner's payload contains
 * the sections they have taken down, plus their timezone; serving it to a
 * visitor is the one failure this whole surface is built to prevent. The guard
 * is structural rather than a key convention: this module hardcodes
 * `isOwner: false` and takes no flag, so there is no argument any caller can
 * pass to get an owner payload into it. The owner's own payload is cached
 * where it is built — the page's `own` payload in profile.tsx, the API's in
 * api.ts — and those caches are never read for anybody else.
 *
 * THE HIDDEN LIST IS IN THE KEY. Not as a cache-busting trick: it is what the
 * payload was FILTERED BY, and a payload built under one list must never be
 * served under another. Eviction alone loses a race it cannot see — a build
 * that started before the toggle finishes after the delete — which is why
 * `evictPublicFingerprint` exists as well AND why TtlCache invalidates a build
 * in flight whose key is evicted. Three guards, because the thing they are
 * guarding is a figure somebody asked us to stop showing.
 */

import { getFingerprint, type FingerprintData, type FingerprintSection } from './fingerprint';
import { TtlCache } from './ttl-cache';

/** What building a public fingerprint needs: who, and in which clock. */
export interface PublicFingerprintUser {
  id: string;
  githubUsername: string;
  timezone: string;
}

/**
 * A minute fresh, thirty more of stale window.
 *
 * The minute is the figure's own staleness budget and is what the three caches
 * this replaces already used. The window behind it is the other question — how
 * long it is better to answer with a slightly old payload than to make a
 * reader, or X's crawler, wait out the fan-out. See src/lib/ttl-cache.ts.
 */
const TTL_MS = 60_000;
const STALE_MS = 30 * 60_000;

const cache = new TtlCache<FingerprintData>(TTL_MS, 500, {
  staleMs: STALE_MS,
  name: 'public-fingerprint',
});

/** User, then the list the payload was filtered by. Nothing else. */
function key(userId: string, hidden: readonly FingerprintSection[]): string {
  return `${userId}|${hidden.join(',')}`;
}

/**
 * How many public fan-outs this process has actually run.
 *
 * The number this module exists to hold down — three per cold profile before,
 * one now — so it is asserted rather than described. See the test.
 */
let builds = 0;

export function publicFingerprintBuilds(): number {
  return builds;
}

function build(
  user: PublicFingerprintUser,
  hidden: readonly FingerprintSection[]
): Promise<FingerprintData> {
  builds++;
  return getFingerprint(user.id, {
    username: user.githubUsername,
    timezone: user.timezone,
    // The two things that make this payload public, and the reason no caller
    // gets a say in either.
    isOwner: false,
    hidden: [...hidden],
  });
}

/**
 * The public fingerprint: cached, stale-while-revalidating, single-flighted.
 *
 * What all three surfaces call. A throw is never cached, so a ClickHouse
 * outage is retried by the next caller rather than pinned — and inside the
 * stale window it does not even reach the caller.
 */
export function publicFingerprint(
  user: PublicFingerprintUser,
  hidden: readonly FingerprintSection[]
): Promise<FingerprintData> {
  return cache.remember(key(user.id, hidden), () => build(user, hidden));
}

/**
 * Rebuild now and wait for it, joining a build already in flight.
 *
 * The warmer's entry point (src/lib/warm.ts), and the reason its cycle costs
 * ONE fan-out per user: it refreshes this first, and the page payload and the
 * card it warms next both find it fresh.
 */
export function refreshPublicFingerprint(
  user: PublicFingerprintUser,
  hidden: readonly FingerprintSection[]
): Promise<FingerprintData> {
  return cache.refresh(key(user.id, hidden), () => build(user, hidden));
}

/**
 * Forget every public payload for one user, under any hidden list.
 *
 * Called wherever a figure in it can have changed — the visibility toggle and
 * the timezone change in src/routes/api.ts. A prefix and not a `clear()`,
 * because one person's toggle is not a reason to drop everybody's.
 */
export function evictPublicFingerprint(userId: string): void {
  cache.deletePrefix(`${userId}|`);
}

/** For tests that need a cold cache. Not used by the app. */
export function resetPublicFingerprintCache(): void {
  cache.clear();
}
