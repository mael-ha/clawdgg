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
import { normalizeTimezone } from '../lib/timezone';
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
// Streak Calculation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate current and longest streaks from a list of dates
 * A streak is consecutive days with activity
 */
function calculateStreaks(dates: string[]): { currentStreak: number; longestStreak: number } {
  if (dates.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  // Sort dates chronologically
  const sorted = [...new Set(dates)].sort();

  // Parse dates to day numbers (days since epoch)
  const dayNumbers = sorted.map((dateStr) => {
    const d = new Date(dateStr);
    return Math.floor(d.getTime() / (24 * 60 * 60 * 1000));
  });

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

  // Calculate current streak (must include today or yesterday)
  const today = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const lastActiveDay = dayNumbers[dayNumbers.length - 1]!;

  let currentStreak = 0;
  if (lastActiveDay === today || lastActiveDay === today - 1) {
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
 */
async function getUserHourlyCounts(
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
 */
async function getLongestSessionMessages(userId: string): Promise<number> {
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
export async function syncClickHouseToSqlite(): Promise<{ synced: number; errors: number }> {
  // Check if a sync is already running
  if (isSyncing) {
    console.log('[sync] Previous sync still running, skipping this run');
    return { synced: 0, errors: 0 };
  }

  isSyncing = true;
  const startTime = Date.now();

  try {
    console.log('[sync] Starting ClickHouse → SQLite sync...');

    let synced = 0;
    let errors = 0;

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
        const streaks = calculateStreaks(activeDates);

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

        // Get user rank from pre-calculated lookup
        const userRank = rankLookup.get(userId) ?? allUsers.length;

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
      `[sync] Sync complete: ${synced} users synced, ${errors} errors, ${duration}ms`
    );

    return { synced, errors };
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
 * Manual trigger for sync (useful for API endpoint)
 */
export async function triggerSync(): Promise<{ synced: number; errors: number }> {
  return syncClickHouseToSqlite();
}
