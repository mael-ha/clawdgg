/**
 * Which users' pages are out of date — the input to src/jobs/refresh-pages.ts.
 *
 * The profile surfaces no longer expire on a timer (src/lib/ttl-cache.ts):
 * they are rebuilt when what they are built from changes, and this is where a
 * change is written down. `markDirty` is called by every in-process write that
 * moves a figure a page shows:
 *
 *   insert() in src/db/clickhouse.ts  every raw row — OTLP ingestion, the CLI
 *                                     import and the hook all go through it
 *   PUT /api/me/timezone              every local day and hour moves with it
 *   PUT /api/me/profile-settings      what a visitor may see
 *   the sync job                      a local day ending, and rows written by
 *                                     another process (a script, a migration)
 *
 * A mark is two timestamps, first and last, so the job can wait for a burst of
 * writes to go quiet (an OTLP export is several requests a few seconds apart)
 * without letting a user who never stops writing go stale for ever.
 *
 * In memory and per process, like the caches it invalidates: after a restart
 * the caches are empty, so there is nothing for a lost mark to have kept
 * fresh. It imports nothing, so the insert path can call it without pulling
 * the routes in.
 */

export interface DirtyMark {
  /** When the oldest change not yet rebuilt arrived. */
  first: number;
  /** When the newest one did. A rebuild clears the mark only if this has not moved. */
  last: number;
  reasons: Set<string>;
  /** Set after a failed rebuild: not due again before this. */
  retryAt?: number;
}

/** How long a user's writes must have been quiet before their pages are rebuilt. */
export const QUIET_MS = 10_000;
/** How long a user who keeps writing can go without a rebuild. */
export const MAX_DIRTY_MS = 60_000;

const marks = new Map<string, DirtyMark>();
/** The last mark per user, kept after the mark is cleared. */
const lastMarked = new Map<string, number>();

export function markDirty(userId: string, reason: string, now: number = Date.now()): void {
  if (!userId) return;
  lastMarked.set(userId, now);
  const mark = marks.get(userId);
  if (mark) {
    mark.last = now;
    mark.reasons.add(reason);
    return;
  }
  marks.set(userId, { first: now, last: now, reasons: new Set([reason]) });
}

export function isDirty(userId: string): boolean {
  return marks.has(userId);
}

export function dirtyMark(userId: string): DirtyMark | undefined {
  return marks.get(userId);
}

/** When this user was last marked, cleared or not. For the sync job. */
export function lastMarkedAt(userId: string): number | undefined {
  return lastMarked.get(userId);
}

/**
 * Users whose rebuild is due: quiet for QUIET_MS, or dirty for MAX_DIRTY_MS,
 * oldest mark first.
 */
export function dueUsers(now: number = Date.now()): string[] {
  const due: [string, number][] = [];
  for (const [userId, mark] of marks) {
    if (mark.retryAt !== undefined && mark.retryAt > now) continue;
    if (now - mark.last >= QUIET_MS || now - mark.first >= MAX_DIRTY_MS) due.push([userId, mark.first]);
  }
  return due.sort((a, b) => a[1] - b[1]).map(([userId]) => userId);
}

/**
 * Clear a mark after a rebuild that started when it read `last`.
 *
 * A write that arrived DURING the rebuild moved `last`, and the rebuild may
 * have read the rows before it landed — so that mark stays, and the next
 * cycle rebuilds again. Returns whether the mark was cleared.
 */
export function clearDirty(userId: string, seenLast: number): boolean {
  const mark = marks.get(userId);
  if (!mark) return true;
  if (mark.last !== seenLast) {
    // The rebuild worked; only the newer write is left to do, and it is due
    // on the usual terms rather than after a failure's back-off.
    delete mark.retryAt;
    return false;
  }
  marks.delete(userId);
  return true;
}

/** A rebuild failed: keep the mark, and do not try again before `at`. */
export function deferDirty(userId: string, at: number): void {
  const mark = marks.get(userId);
  if (mark) mark.retryAt = at;
}

/**
 * Rebuild one user's pages now, joined with the refresh job if it is already
 * on them — for an owner opening their own page, who must not see their own
 * numbers lag (src/routes/profile.tsx). Registered by the job when it starts,
 * so this module never imports it; without a job, nothing is rebuilt here and
 * the route serves what it has.
 */
let refresher: ((userId: string) => Promise<void>) | null = null;

export function setRefresher(fn: ((userId: string) => Promise<void>) | null): void {
  refresher = fn;
}

export async function refreshNow(userId: string): Promise<void> {
  if (refresher && marks.has(userId)) await refresher(userId);
}

/** For tests. */
export function resetDirty(): void {
  marks.clear();
  lastMarked.clear();
}
