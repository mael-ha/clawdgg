/**
 * The refresh job — rebuild a user's pages when their data changes, and only
 * then.
 *
 * The profile surfaces are cached until replaced (src/lib/ttl-cache.ts), and
 * this is what replaces them. Every write that moves a figure marks its user
 * dirty (src/lib/dirty.ts); every few seconds this takes the users whose marks
 * are due — quiet for 10 s, or dirty for 60 s — and rebuilds what a visitor,
 * the owner and a crawler would read, through the same builds and the same
 * keys the routes use:
 *
 *   1. the streaks, recomputed from the days and written to users.* — the
 *      board and the page both read them from there
 *   2. the shared public fingerprint (src/lib/public-fingerprint.ts) — the one
 *      ClickHouse fan-out, which everything below is built from
 *   3. the public page payload, and the owner's if they looked in the last day
 *   4. the share card, if it was asked for in the last day (the PNG only if the
 *      PNG was)
 *   5. the owner's fingerprint API payload, if they asked for it in the last day
 *
 * Then the board figures are due, and they are rebuilt at most once a minute
 * however many users changed: two scans over everyone's rows, not two per user.
 *
 * WHAT THE OLD WARMER GOT WRONG. It rebuilt the top hundred profiles every five
 * minutes whether or not anything had changed, and that background flood was
 * the slowness: visitors queued behind recomputes of numbers already on
 * screen. This does no ClickHouse work at all on an idle server — no marks, no
 * reads — and for a changed user it does the work their next visitor would
 * otherwise have waited for.
 *
 * ONE USER AT A TIME, and a cycle never overlaps itself: ClickHouse reads go
 * through a 4-permit limiter (src/db/clickhouse.ts) that readers also need, and
 * a background job must never be more than one fan-out deep in it. A user
 * whose rebuild throws keeps their mark and is retried a minute later; the
 * previous payloads go on serving meanwhile.
 *
 * A MARK THAT ARRIVES DURING A REBUILD SURVIVES IT. The rebuild may have read
 * the rows before that write landed, so the mark is cleared only if it has not
 * moved since the rebuild began, and the next cycle goes again.
 *
 * An owner opening their own page does not wait for any of this: the route
 * calls refreshNow (src/lib/dirty.ts), which joins a rebuild of that user
 * already in flight here or runs one, so they never see their own numbers lag.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import {
  clearDirty,
  deferDirty,
  dirtyMark,
  dueUsers,
  isDirty,
  setRefresher,
} from '../lib/dirty';
import { fetchProfileUserById } from '../lib/profile-data';
import { hiddenFor } from '../lib/profile-settings';
import { refreshPublicFingerprint } from '../lib/public-fingerprint';
import { refreshBoardFigures } from '../lib/boards';
import { refreshProfilePages } from '../routes/profile';
import { refreshCard } from '../routes/og';
import { refreshOwnerFingerprint } from '../routes/api';
import { userStreaks } from './sync-clickhouse';

const INTERVAL_MS = 5_000;
/** The board figures are rebuilt at most this often. */
const BOARD_INTERVAL_MS = 60_000;
/** How long a user whose rebuild failed waits before the next attempt. */
const RETRY_MS = 60_000;

/** What rebuilding one user means. Swapped out by the tests. */
export interface RefreshSteps {
  rebuildUser(userId: string): Promise<void>;
  rebuildBoards(): Promise<void>;
}

async function rebuildUser(userId: string): Promise<void> {
  let user = await fetchProfileUserById(userId);
  if (!user) return;

  const { currentStreak, longestStreak } = await userStreaks(user.id, user.timezone);
  if (currentStreak !== user.currentStreak || longestStreak !== user.longestStreak) {
    await db.update(users).set({ currentStreak, longestStreak }).where(eq(users.id, user.id));
    user = { ...user, currentStreak, longestStreak };
  }

  // The fingerprint FIRST: the page payload and the card are built from it,
  // so each of them finds it current and costs only what is its own.
  await refreshPublicFingerprint(user, await hiddenFor(user.id));
  await refreshProfilePages(user);
  await refreshCard(user);
  await refreshOwnerFingerprint(user);
}

const defaultSteps: RefreshSteps = {
  rebuildUser,
  rebuildBoards: () => refreshBoardFigures(),
};

let steps: RefreshSteps = defaultSteps;
const inFlight = new Map<string, Promise<void>>();
let boardsDirty = false;
let lastBoardRebuild = 0;
let cycling = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** For tests: swap the steps, and put the job's own state back. */
export function setRefreshSteps(next: RefreshSteps | null): void {
  steps = next ?? defaultSteps;
  inFlight.clear();
  boardsDirty = false;
  lastBoardRebuild = 0;
  cycling = false;
}

/**
 * Rebuild one user now, joining a rebuild of them already in flight.
 *
 * The mark is read BEFORE the rebuild starts and cleared after only if no
 * newer write moved it in between. A visibility toggle on its own does not
 * dirty the board: visibility is read fresh for every ranking.
 */
export function refreshUser(userId: string): Promise<void> {
  const pending = inFlight.get(userId);
  if (pending) return pending;

  const mark = dirtyMark(userId);
  const seenLast = mark?.last;
  const movesBoards = !mark || [...mark.reasons].some((reason) => reason !== 'visibility');

  const run = (async () => {
    try {
      await steps.rebuildUser(userId);
      if (seenLast !== undefined) clearDirty(userId, seenLast);
      if (movesBoards) boardsDirty = true;
    } catch (error) {
      deferDirty(userId, Date.now() + RETRY_MS);
      throw error;
    } finally {
      inFlight.delete(userId);
    }
  })();

  inFlight.set(userId, run);
  return run;
}

/**
 * For the owner's own page: join whatever is in flight, and if a write landed
 * after it began, run once more. Twice at most, so an owner whose Claude Code
 * is exporting while they look still gets an answer.
 */
async function refreshForOwner(userId: string): Promise<void> {
  await refreshUser(userId);
  if (isDirty(userId)) await refreshUser(userId);
}

export interface RefreshReport {
  users: number;
  refreshed: number;
  failed: number;
  boards: boolean;
  ms: number;
}

/**
 * One cycle. Returns null if the previous one is still running.
 *
 * Logs one line when it did something, and nothing when it did not — which on
 * an idle server is every cycle, twelve a minute.
 */
export async function refreshCycle(
  log: (line: string) => void = (line) => console.log(line),
  now: number = Date.now()
): Promise<RefreshReport | null> {
  if (cycling) return null;
  cycling = true;

  const started = Date.now();
  const due = dueUsers(now);
  let refreshed = 0;
  let failed = 0;
  let boards = false;

  try {
    for (const userId of due) {
      try {
        await refreshUser(userId);
        refreshed++;
      } catch (error) {
        failed++;
        console.error(`[refresh] ${userId}:`, error);
      }
    }

    if (boardsDirty && Date.now() - lastBoardRebuild >= BOARD_INTERVAL_MS) {
      boardsDirty = false;
      lastBoardRebuild = Date.now();
      try {
        await steps.rebuildBoards();
        boards = true;
      } catch (error) {
        // Still dirty: the next due cycle, a minute on, tries again.
        boardsDirty = true;
        console.error('[refresh] board figures:', error);
      }
    }
  } finally {
    cycling = false;
  }

  const report: RefreshReport = { users: due.length, refreshed, failed, boards, ms: Date.now() - started };
  if (due.length > 0 || boards) {
    log(
      `[refresh] cycle: ${refreshed}/${due.length} users refreshed, ${failed} failed, ` +
        `boards ${boards ? 'rebuilt' : 'unchanged'}, ${report.ms}ms`
    );
  }
  return report;
}

export function startRefreshJob(): void {
  if (timer) return;
  setRefresher(refreshForOwner);
  timer = setInterval(() => {
    void refreshCycle();
  }, INTERVAL_MS);
  console.log(`[refresh] rebuilding changed pages every ${INTERVAL_MS / 1000}s`);
}

export function stopRefreshJob(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  setRefresher(null);
  console.log('[refresh] stopped');
}
