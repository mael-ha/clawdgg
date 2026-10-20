/**
 * Background Sync Job: ClickHouse → SQLite
 *
 * This is the critical bridge between OTel data ingestion and user-facing features.
 * Without this, data flows INTO ClickHouse but never OUT to where users see it.
 *
 * Data flow:
 *   Claude Code → OTel → ClickHouse → [THIS JOB] → SQLite → Leaderboard/Profile
 *
 * ClickHouse IS THE SOURCE. `users.total_*` is a cache of it and nothing else.
 * This job used to ADD the frozen `users.legacy_total_*` snapshot on top of
 * the ClickHouse figures, because the pre-OTEL history lived only in SQLite.
 * That history is now imported into ClickHouse itself
 * (docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts), so adding
 * the snapshot would count it twice. Every `legacy_*` column and every
 * `daily_stats` read is gone from here; do not reintroduce one.
 *
 * Runs every 5 minutes for every user, not just OTel-enabled ones: a user who
 * never enabled OTEL still has imported history in ClickHouse, and without a
 * sync their totals would read 0 on the leaderboard.
 */

import { db } from '../db';
import { users } from '../db/schema';
import { clickhouse, query, LOCAL_TS_SQL, NO_LEGACY_SQL, PROMPT_EVENT_SQL } from '../db/clickhouse';
import { localDate, normalizeTimezone } from '../lib/timezone';
import { pruneRankSnapshots, snapshotRanks } from '../lib/rank-snapshots';
import { snapshotBoardRanks } from '../lib/boards';
import { computeBadges } from '../lib/badges';
import { eq } from 'drizzle-orm';

// ═══════════════════════════════════════════════════════════════════════════
// Sync Guard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Guard to prevent concurrent sync runs
 * If a sync takes longer than 5 minutes, skip the next scheduled run
 */
let isSyncing = false;

// ═══════════════════════════════════════════════════════════════════════════
// Change Watermarks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHY A WATERMARK. Recomputing every user's totals every five minutes re-read
 * each whole history (1.2–1.9M rows for the heaviest) whether or not anything
 * had arrived — with nobody visiting, this job and the profile warmer were
 * ~600 s of ClickHouse time an hour, and visitors queued behind them. Most
 * users send nothing in most five-minute windows, so most of that work
 * recomputed the number already stored.
 *
 * So each pass first asks ClickHouse, in two cheap GROUP BY user_id scans,
 * what each user's rows look like right now, and skips a user whose answer
 * matches the one their last successful sync saw.
 *
 * `count()` AND `max(timestamp)`, not the latest timestamp alone: an import
 * lands history with OLD timestamps, which moves the count but not the max, and
 * a reset deletes rows, which can move either. The scan reads those two
 * columns and nothing else — tens of MB for the whole table. No FINAL — a
 * background merge collapsing a duplicate moves the count too, which costs one
 * extra recompute and is never wrong in the other direction.
 *
 * The rest of the key is what the stored figures depend on that ClickHouse
 * does not: the user's zone and today's date in it (the streak decays at their
 * midnight with no new row), and their OG rank (the badges read it).
 *
 * In memory, deliberately: after a restart the first pass recomputes everyone,
 * once, which is exactly what this job always did.
 */
const lastSyncedKey = new Map<string, string>();

/** Per-user `count:max(timestamp)` over both raw tables. */
export async function fetchSyncWatermarks(): Promise<Map<string, string>> {
  const watermarkSql = (table: string) => `
    SELECT user_id, toString(count()) AS n, toString(max(timestamp)) AS ts
    FROM ${table}
    GROUP BY user_id
  `;
  const [events, metrics] = await Promise.all([
    query<{ user_id: string; n: string; ts: string }>(watermarkSql('events_raw')),
    query<{ user_id: string; n: string; ts: string }>(watermarkSql('metrics_raw')),
  ]);

  const eventMarks = new Map(events.map((row) => [row.user_id, `${row.n}:${row.ts}`]));
  const metricMarks = new Map(metrics.map((row) => [row.user_id, `${row.n}:${row.ts}`]));
  const marks = new Map<string, string>();
  for (const userId of new Set([...eventMarks.keys(), ...metricMarks.keys()])) {
    marks.set(userId, `e=${eventMarks.get(userId) ?? '-'}|m=${metricMarks.get(userId) ?? '-'}`);
  }
  return marks;
}

/** Everything a user's stored figures depend on. Exported for the test. */
export function syncKey(watermark: string, timezone: string, today: string, rank: number): string {
  return `${watermark}|tz=${timezone}|today=${today}|rank=${rank}`;
}

/** Exported for the tests, which run passes back to back. */
export function resetSyncWatermarks(): void {
  lastSyncedKey.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// Streak Calculation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Current and longest streaks over a set of ACTIVE LOCAL DAYS.
 *
 * `dates` are 'YYYY-MM-DD' calendar days in the user's own zone — what
 * clickhouse.getUserActiveLocalDays returns — so every comparison here happens
 * in calendar-day space, not in instants. `today` has to be in that same space
 * or the last comparison is between two different clocks.
 *
 * THAT WAS THE BUG. `today` was `Date.now() / 86_400_000`, the UTC day number,
 * against local calendar days: for a user in Tokyo, 09:00 on the 19th local is
 * the 19th in their active-day set and still the 18th in UTC, so their run read
 * as "active yesterday" — it survived, one day short, and broke outright the
 * moment they missed a day. For Los Angeles the error has the opposite sign and
 * is worse: 18:00 on the 18th local is the 19th in UTC, so a user who prompted
 * today and yesterday had a last active day of today - 2 and NO current streak
 * at all. Half the world's 🔥 was wrong by one day in one direction or the
 * other, every evening and every morning.
 */
export function calculateStreaks(
  dates: string[],
  today: string
): { currentStreak: number; longestStreak: number } {
  if (dates.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  // Sort dates chronologically
  const sorted = [...new Set(dates)].sort();

  // Parse dates to day numbers (days since epoch)
  const dayNumbers = sorted.map(dayNumber);

  // Calculate longest streak
  let longestStreak = 1;
  let currentRun = 1;

  for (let i = 1; i < dayNumbers.length; i++) {
    const current = dayNumbers[i]!;
    const previous = dayNumbers[i - 1]!;
    if (current === previous + 1) {
      // Consecutive day
      currentRun++;
      longestStreak = Math.max(longestStreak, currentRun);
    } else {
      // Gap in days
      currentRun = 1;
    }
  }

  // Calculate current streak (must include today or yesterday). Yesterday
  // counts because a day is not over until it is over: somebody who last
  // prompted at 23:00 is on a streak at 08:00 the next morning.
  const todayNumber = dayNumber(today);
  const lastActiveDay = dayNumbers[dayNumbers.length - 1]!;

  let currentStreak = 0;
  if (lastActiveDay === todayNumber || lastActiveDay === todayNumber - 1) {
    // Start from the last day and count backwards
    currentStreak = 1;
    for (let i = dayNumbers.length - 2; i >= 0; i--) {
      const current = dayNumbers[i]!;
      const next = dayNumbers[i + 1]!;
      if (current === next - 1) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  return { currentStreak, longestStreak };
}

/**
 * A 'YYYY-MM-DD' CALENDAR day as its index since the epoch.
 *
 * Read as UTC midnight deliberately: the input is already a local calendar
 * date, so this is a numbering of calendar days and not a conversion of
 * instants. Both sides of every comparison above go through it.
 */
function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// Hourly Counts for Badges
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get hourly activity counts for badge calculation
 * Returns { "0": count, "1": count, ..., "23": count }
 *
 * In the USER'S timezone, because this is what decides the night-owl badge and
 * the archetype. Read in UTC, a Berlin user who stops at 23:00 looks like they
 * stop at 21:00, and one in Los Angeles looks nocturnal all day.
 *
 * Exported for src/db/clickhouse-reads.test.ts: the catch below turns a broken
 * query into an empty answer, so the only way to see this SQL fail is to run it.
 */
export async function getUserHourlyCounts(
  userId: string,
  tz: string
): Promise<Record<string, number>> {
  try {
    const result = await query<{ hour: number; count: number }>(
      `
      SELECT
        toHour(${LOCAL_TS_SQL}) as hour,
        COUNT(*) as count
      FROM events_raw FINAL
      WHERE user_id = {userId:String}
        AND ${PROMPT_EVENT_SQL}
        AND ${NO_LEGACY_SQL}
      GROUP BY hour
      `,
      { userId, tz: normalizeTimezone(tz) }
    );

    const counts: Record<string, number> = {};
    for (const row of result) {
      counts[String(row.hour)] = Number(row.count);
    }
    return counts;
  } catch (error) {
    console.error(`[sync] Error getting hourly counts for ${userId}:`, error);
    return {};
  }
}

/**
 * Get longest session message count for a user
 * OTel tracks this via session metrics
 *
 * Exported for the same reason as getUserHourlyCounts above.
 */
export async function getLongestSessionMessages(userId: string): Promise<number> {
  try {
    // Count prompts per session and get the max
    const result = await query<{ max_prompts: number }>(
      `
      SELECT MAX(prompt_count) as max_prompts
      FROM (
        SELECT session_id, COUNT(*) as prompt_count
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND ${PROMPT_EVENT_SQL}
          AND session_id != ''
        GROUP BY session_id
      )
      `,
      { userId }
    );

    return result[0]?.max_prompts || 0;
  } catch (error) {
    console.error(`[sync] Error getting longest session for ${userId}:`, error);
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Sync Function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sync all OTel-enabled users from ClickHouse to SQLite
 * This populates the users.total_* columns that the leaderboard queries
 */
export interface SyncResult {
  synced: number;
  errors: number;
  /** Users whose rows had not changed since their last successful sync. */
  unchanged: number;
}

export async function syncClickHouseToSqlite(
  options: { force?: boolean } = {}
): Promise<SyncResult> {
  // Check if a sync is already running
  if (isSyncing) {
    console.log('[sync] Previous sync still running, skipping this run');
    return { synced: 0, errors: 0, unchanged: 0 };
  }

  isSyncing = true;
  const startTime = Date.now();

  try {
    console.log('[sync] Starting ClickHouse → SQLite sync...');

    let synced = 0;
    let errors = 0;
    let unchanged = 0;

    // A failed watermark read is not a reason to skip the pass: without one,
    // every user is recomputed, which is what this job did before it had any.
    let watermarks: Map<string, string> | null = null;
    if (!options.force) {
      try {
        watermarks = await fetchSyncWatermarks();
      } catch (error) {
        console.error('[sync] Watermark read failed; syncing every user:', error);
      }
    }

    // Every user, not only the OTel-enabled ones: imported pre-OTEL history
    // lives in ClickHouse now, and a user who never ran `clawdgg setup` would
    // otherwise never have their totals filled in.
    const syncTargets = await db
      .select({
        id: users.id,
        createdAt: users.createdAt,
        currentLongestStreak: users.longestStreak,
        currentFirstSessionDate: users.firstSessionDate,
        timezone: users.timezone,
      })
      .from(users);

    console.log(`[sync] Syncing ${syncTargets.length} users from ClickHouse`);

    // Pre-calculate user ranks once (for OG badge)
    const allUsers = await db
      .select({ id: users.id })
      .from(users)
      .orderBy(users.createdAt);
    const rankLookup = new Map(allUsers.map((u, idx) => [u.id, idx + 1]));

    // Process users in batches to avoid overwhelming ClickHouse
    for (const user of syncTargets) {
      const {
        id: userId,
        currentLongestStreak: existingLongestStreak = 0,
        currentFirstSessionDate,
        timezone,
      } = user;

      // Get user rank from pre-calculated lookup
      const userRank = rankLookup.get(userId) ?? allUsers.length;

      let key: string | null = null;
      if (watermarks) {
        const watermark = watermarks.get(userId);
        // No row in either table: getUserTotals would answer nothing and the
        // loop below would `continue` — the same outcome, without the read.
        if (watermark === undefined) continue;
        key = syncKey(watermark, timezone, localDate(new Date(), timezone), userRank);
        if (lastSyncedKey.get(userId) === key) {
          unchanged++;
          continue;
        }
      }

      try {
        // Get totals from ClickHouse — the only source there is.
        const totals = await clickhouse.getUserTotals(userId);
        const chTotals = totals[0];
        const userTotals = chTotals || {
          total_prompts: 0,
          total_tokens: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cache_read_tokens: 0,
          total_cache_write_tokens: 0,
          total_cost_usd: 0,
          total_lines_added: 0,
          total_commits: 0,
          total_prs: 0,
          total_active_seconds: 0,
          avg_prompt_length: 0,
        };

        if (!chTotals) {
          console.log(`[sync] No data yet for user ${userId}`);
          continue;
        }

        // Active days come from ClickHouse alone — the imported pre-OTEL days
        // are in there, so a streak that spans the OTEL transition is just a
        // streak now, with no two sources to reconcile.
        //
        // getUserActiveLocalDays, not every date getUserDailyMetrics returns:
        // that set included days with no prompt at all (a background retry, a
        // subagent finishing) and days whose only row was an ultrathink flag,
        // and it was in UTC, so a 23:00 prompt in Paris landed on the previous
        // day and broke the streak of anyone who works late. One definition,
        // shared with the profile's streak milestones — see the helper.
        const activeDates = await clickhouse.getUserActiveLocalDays(userId, timezone, 365);
        // Today in the USER's zone, because the days above are in it too.
        const streaks = calculateStreaks(activeDates, localDate(new Date(), timezone));

        const hourCounts = await getUserHourlyCounts(userId, timezone);
        const longestSession = await getLongestSessionMessages(userId);
        const toolCalls = await clickhouse.getUserTotalToolCalls(userId);

        // longestStreak keeps a max with the stored value: a user may have
        // history older than the 365-day window this query reads.
        const finalLongestStreak = Math.max(streaks.longestStreak, existingLongestStreak ?? 0);

        // First session date: prefer the stored one (it can predate the
        // 365-day window), else the earliest day ClickHouse knows about.
        const finalFirstSessionDate =
          currentFirstSessionDate || (activeDates.length > 0 ? [...activeDates].sort()[0] : undefined);

      // Totals are ClickHouse's answer, rounded. Nothing is added on top.
      const totalPrompts = Math.round(userTotals.total_prompts);
      const totalTokens = Math.round(userTotals.total_tokens);
      const totalCostCents = Math.round(userTotals.total_cost_usd * 100);
      const totalLines = Math.round(userTotals.total_lines_added);
      const totalCommits = Math.round(userTotals.total_commits);

      const badges = computeBadges({
        totalMessages: totalPrompts,
        totalToolCalls: toolCalls,
        currentStreak: streaks.currentStreak,
        longestStreak: finalLongestStreak,
        longestSessionMessages: longestSession,
        hourCounts,
        userRank: userRank > 0 ? userRank : undefined,
      });

      // users.total_* is a cache of the ClickHouse figures above, nothing more.
      await db
        .update(users)
        .set({
          totalPrompts,
          totalTokens,
          totalCostCents,
          totalLinesAdded: totalLines,
          totalCommits,
          totalPrs: Math.round(userTotals.total_prs),
          totalActiveSeconds: Math.round(userTotals.total_active_seconds),
          avgPromptLength: Math.round(userTotals.avg_prompt_length),

          totalInputTokens: Math.round(userTotals.total_input_tokens || 0),
          totalOutputTokens: Math.round(userTotals.total_output_tokens || 0),
          totalCacheReadTokens: Math.round(userTotals.total_cache_read_tokens || 0),
          totalCacheCreationTokens: Math.round(userTotals.total_cache_write_tokens || 0),

          currentStreak: streaks.currentStreak,
          longestStreak: finalLongestStreak,

          longestSessionMessages: longestSession,
          hourCounts: JSON.stringify(hourCounts),
          badges: JSON.stringify(badges),

          firstSessionDate: finalFirstSessionDate,

          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

        if (key) lastSyncedKey.set(userId, key);
        synced++;
        console.log(
          `[sync] Updated user ${userId}: ${totalPrompts} prompts, $${(totalCostCents / 100).toFixed(2)}`
        );
      } catch (error) {
        errors++;
        console.error(`[sync] Error syncing user ${userId}:`, error);
      }
    }

    // Where everyone stands today, recorded once per UTC day. It runs AFTER
    // the loop above, so the snapshot is of the same totals the leaderboard is
    // about to show rather than of the ones it had five minutes ago. A failure
    // here costs the board its arrows, not its numbers, so it is caught.
    try {
      const written = await snapshotRanks();
      if (written > 0) {
        console.log(`[sync] Rank snapshot written: ${written} rows`);
        await pruneRankSnapshots();
      }
    } catch (error) {
      console.error('[sync] Rank snapshot failed:', error);
    }

    // The same thing for the boards, which rank on their own derived figures
    // (leverage, value per prompt, …) rather than on users.total_*, so their
    // positions cannot be read off the snapshot above. Once-per-UTC-day guarded
    // by its own sentinel row and caught separately: without it the ▲▼ never
    // appears, which is worth a log line and not a failed sync.
    try {
      const written = await snapshotBoardRanks();
      if (written > 0) console.log(`[sync] Board rank snapshot written: ${written} rows`);
    } catch (error) {
      console.error('[sync] Board rank snapshot failed:', error);
    }

    const duration = Date.now() - startTime;
    console.log(
      `[sync] Sync complete: ${synced} users synced, ${unchanged} unchanged, ${errors} errors, ${duration}ms`
    );

    return { synced, errors, unchanged };
  } finally {
    isSyncing = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler
// ═══════════════════════════════════════════════════════════════════════════

let syncInterval: Timer | null = null;

/**
 * Start the background sync job
 * Runs immediately, then every 5 minutes
 */
export function startSyncJob(): void {
  console.log('[sync] Starting background sync job (every 5 minutes)');

  // Run immediately on startup
  syncClickHouseToSqlite().catch((error) => {
    console.error('[sync] Initial sync failed:', error);
  });

  // Then run every 5 minutes
  syncInterval = setInterval(
    () => {
      syncClickHouseToSqlite().catch((error) => {
        console.error('[sync] Scheduled sync failed:', error);
      });
    },
    5 * 60 * 1000 // 5 minutes
  );
}

/**
 * Stop the background sync job
 */
export function stopSyncJob(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log('[sync] Background sync job stopped');
  }
}

/**
 * Manual trigger for sync (useful for API endpoint). Recomputes every user:
 * someone asking by hand wants the figures rebuilt, not a watermark compared.
 */
export async function triggerSync(): Promise<SyncResult> {
  return syncClickHouseToSqlite({ force: true });
}
