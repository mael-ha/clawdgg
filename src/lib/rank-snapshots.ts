/**
 * Which way someone is moving on the leaderboard.
 *
 * A rank is a position in a field, so it cannot be recomputed from any current
 * total — yesterday's field is gone unless it was written down. The sync job
 * writes one row per user per metric per UTC day (src/db/schema.ts
 * rank_snapshots) and the board compares today's position with the last one on
 * record.
 *
 * ONE ORDERING, EVERYWHERE. The displayed rank is "position in the ORDER BY",
 * so the snapshot has to use the identical ordering or the arrow reports a move
 * that never happened. In particular the order needs a TIEBREAKER: two users on
 * the same total are in an arbitrary order without one, and SQLite is free to
 * return them differently between two runs — which would show both of them a
 * phantom ±1 every single day. `userId` ascending is that tiebreaker, applied
 * here and in both leaderboard queries.
 */

import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db';
import { rankSnapshots, users } from '../db/schema';

// Same injection idiom as src/lib/session.ts: a trailing database argument, so
// the tests run against a temp SQLite file and never data/clawd.db.
type AppDb = typeof db;

/**
 * The metrics the board can be sorted by, and the synced column each ranks on.
 *
 * All-time only. A period board ranks on a different question (this week's
 * prompts, not all of them), so comparing today's week-rank with yesterday's
 * would be a number about two different fields — see rankChangesFor.
 */
export const RANK_METRICS = {
  prompts: users.totalPrompts,
  tokens: users.totalTokens,
  lines: users.totalLinesAdded,
  commits: users.totalCommits,
  cost: users.totalCostCents,
} as const;

export type RankMetric = keyof typeof RANK_METRICS;

export const RANK_METRIC_NAMES = Object.keys(RANK_METRICS) as RankMetric[];

export interface RankedUser {
  userId: string;
  value: number;
}

export interface AssignedRank extends RankedUser {
  rank: number;
}

/**
 * Positions 1..n, highest value first, ties broken by user id.
 *
 * Deliberately NOT competition ranking (where equal values share a rank): the
 * leaderboard displays `offset + index + 1`, and a rank stored under a
 * different rule would disagree with the number next to the user's name. Same
 * metric, same number, everywhere.
 */
export function assignRanks(rows: RankedUser[]): AssignedRank[] {
  return [...rows]
    .sort((a, b) => b.value - a.value || a.userId.localeCompare(b.userId))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * Movement, positive when the user went UP (1 is the top, so a smaller rank is
 * better). Undefined when there is nothing to compare against — a user who was
 * not in the previous snapshot has not moved, they have arrived, and an arrow
 * claiming otherwise would be invented.
 */
export function rankChange(previousRank: number | undefined, currentRank: number): number | undefined {
  if (previousRank === undefined) return undefined;
  return previousRank - currentRank;
}

/** 'YYYY-MM-DD' in UTC. The snapshot day, deliberately not the user's day. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Write today's ranks, for every metric, unless today is already on record.
 *
 * Called by the sync job AFTER it has refreshed users.total_*, so the snapshot
 * is of the same figures the board is about to show.
 *
 * "At most once per UTC day" is enforced TWICE, and deliberately so. The early
 * return makes the 287 other runs of the day free. The table's unique index is
 * what makes the rule true — the job runs every five minutes, so a check on its
 * own is a race, and the guarantee belongs where it cannot be skipped.
 *
 * Returns the number of rows written: 0 on every run but the first of the day.
 */
export async function snapshotRanks(
  now: Date = new Date(),
  database: AppDb = db
): Promise<number> {
  const day = utcDay(now);

  const existing = await database
    .select({ userId: rankSnapshots.userId })
    .from(rankSnapshots)
    .where(eq(rankSnapshots.day, day))
    .limit(1)
    .get();
  if (existing) return 0;

  const rows = await database
    .select({
      userId: users.id,
      prompts: users.totalPrompts,
      tokens: users.totalTokens,
      lines: users.totalLinesAdded,
      commits: users.totalCommits,
      cost: users.totalCostCents,
    })
    .from(users);

  const values: { userId: string; day: string; metric: string; rank: number; value: number }[] = [];
  for (const metric of RANK_METRIC_NAMES) {
    const ranked = assignRanks(
      rows.map((row) => ({ userId: row.userId, value: Number(row[metric]) || 0 }))
    );
    for (const entry of ranked) {
      values.push({ userId: entry.userId, day, metric, rank: entry.rank, value: entry.value });
    }
  }

  if (values.length === 0) return 0;

  // Chunked to keep the bound-parameter count sane as the user base grows.
  // onConflictDoNothing covers the race the early return above cannot: two
  // processes reaching this line in the same second write the same rows, and
  // the second one is a no-op instead of a crash.
  for (let i = 0; i < values.length; i += 500) {
    await database.insert(rankSnapshots).values(values.slice(i, i + 500)).onConflictDoNothing();
  }
  return values.length;
}

/**
 * The most recent snapshot day strictly before `day`, for one metric.
 *
 * "The previous snapshot" and not "yesterday": a server that was down for a day
 * leaves a gap, and comparing against a day that was never written would hide
 * every arrow until the gap aged out.
 */
async function previousSnapshotDay(
  metric: RankMetric,
  day: string,
  database: AppDb
): Promise<string | null> {
  const row = await database
    .select({ day: rankSnapshots.day })
    .from(rankSnapshots)
    .where(and(eq(rankSnapshots.metric, metric), lt(rankSnapshots.day, day)))
    .orderBy(desc(rankSnapshots.day))
    .limit(1)
    .get();
  return row?.day ?? null;
}

/**
 * Movement per user for one metric, keyed by user id.
 *
 * ONLY for the all-time board. A period board is a different field, so its rows
 * get no arrow rather than one computed from an unrelated ranking — a wrong
 * arrow is worse than no arrow, because there is no way for a reader to tell.
 */
export async function rankChangesFor(
  metric: RankMetric,
  userIds: string[],
  currentRanks: Map<string, number>,
  now: Date = new Date(),
  database: AppDb = db
): Promise<Map<string, number>> {
  const changes = new Map<string, number>();
  if (userIds.length === 0) return changes;

  const previousDay = await previousSnapshotDay(metric, utcDay(now), database);
  if (!previousDay) return changes;

  const previous = await database
    .select({ userId: rankSnapshots.userId, rank: rankSnapshots.rank })
    .from(rankSnapshots)
    .where(
      and(
        eq(rankSnapshots.metric, metric),
        eq(rankSnapshots.day, previousDay),
        inArray(rankSnapshots.userId, userIds)
      )
    );

  for (const row of previous) {
    const current = currentRanks.get(row.userId);
    if (current === undefined) continue;
    const change = rankChange(row.rank, current);
    if (change !== undefined && change !== 0) changes.set(row.userId, change);
  }

  return changes;
}

/** Drop snapshots older than `days`, so the table does not grow forever. */
export async function pruneRankSnapshots(
  days = 400,
  now: Date = new Date(),
  database: AppDb = db
): Promise<void> {
  const cutoff = utcDay(new Date(now.getTime() - days * 86_400_000));
  await database.delete(rankSnapshots).where(lt(rankSnapshots.day, cutoff));
}

/**
 * The ordering every leaderboard query must use.
 *
 * The tiebreaker is the point — see the note at the top of this file. Exported
 * so the two leaderboard queries cannot drift from the snapshot's ordering.
 */
export function rankOrdering(column: (typeof RANK_METRICS)[RankMetric]) {
  return [desc(column), asc(users.id)] as const;
}
