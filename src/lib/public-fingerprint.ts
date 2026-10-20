/**
 * ONE public fingerprint per user, shared by every surface that shows one.
 *
 * Three places asked ClickHouse the same thirteen questions about the same
 * person: src/routes/profile.tsx's page payload, src/routes/api.ts's
 * `/api/u/:username/fingerprint`, and src/routes/og.ts's share card. Each had
 * its own cache, each cache was keyed differently, and each therefore built
 * its own copy — so a cold profile cost 39 reads through a 4-permit limiter
 * rather than 13.
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
 * Kept until replaced, for up to a day, for up to 500 payloads.
 *
 * Replaced by src/jobs/refresh-pages.ts when the user's rows change (see
 * src/lib/dirty.ts), so it never expires on a timer: an unchanged profile is
 * served from here however long ago it was built, and a changed one is rebuilt
 * behind the reader rather than in front of them. The day is a safety net for
 * a change that was never marked, and the LRU bound is what keeps memory
 * bounded as the user count grows.
 */
export const PUBLIC_FINGERPRINT_MAX_AGE_MS = 24 * 60 * 60_000;

const cache = new TtlCache<FingerprintData>(PUBLIC_FINGERPRINT_MAX_AGE_MS, 500);

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
 * The public fingerprint: cached, single-flighted.
 *
 * What all three surfaces call. A throw is never cached, so a ClickHouse
 * outage is retried by the next caller rather than pinned.
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
 * The refresh job's entry point (src/jobs/refresh-pages.ts), and the reason a
 * refresh costs ONE fan-out per user: it rebuilds this first, and the page
 * payload and the card it rebuilds next both find it current.
 */
export function refreshPublicFingerprint(
  user: PublicFingerprintUser,
  hidden: readonly FingerprintSection[]
): Promise<FingerprintData> {
  return cache.refresh(key(user.id, hidden), () => build(user, hidden));
}

/** How old the cached payload is, for the Server-Timing header. */
export function publicFingerprintAge(
  userId: string,
  hidden: readonly FingerprintSection[]
): number | undefined {
  return cache.ageMs(key(userId, hidden));
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
