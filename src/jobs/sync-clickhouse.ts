/**
 * Background Sync Job: ClickHouse → SQLite
 *
 * This is the critical bridge between OTel data ingestion and user-facing features.
 * Without this, data flows INTO ClickHouse but never OUT to where users see it.
 *
 * Data flow:
 *   Claude Code → OTel → ClickHouse → [THIS JOB] → SQLite → Leaderboard/Profile
 *
 * Runs every 5 minutes for all OTel-enabled users.
 */

import { db } from '../db';
import { users } from '../db/schema';
import { clickhouse, query } from '../db/clickhouse';
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
 */
async function getUserHourlyCounts(userId: string): Promise<Record<string, number>> {
  try {
    const result = await query<{ hour: number; count: number }>(
      `
      SELECT
        toHour(hour) as hour,
        SUM(data_points) as count
      FROM metrics_hourly
      WHERE user_id = {userId:String}
      GROUP BY hour
      `,
      { userId }
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
        FROM events_raw
        WHERE user_id = {userId:String}
          AND event_name = 'claude_code.user_prompt'
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

    // Get all OTel-enabled users
    const otelUsers = await db
      .select({ id: users.id, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.otelEnabled, true));

    console.log(`[sync] Found ${otelUsers.length} OTel-enabled users`);

    // Pre-calculate user ranks once (for OG badge)
    const allUsers = await db
      .select({ id: users.id })
      .from(users)
      .orderBy(users.createdAt);
    const rankLookup = new Map(allUsers.map((u, idx) => [u.id, idx + 1]));

    // Process users in batches to avoid overwhelming ClickHouse
    for (const { id: userId, createdAt } of otelUsers) {
      try {
        // Get totals from ClickHouse
        const totals = await clickhouse.getUserTotals(userId);
        const userTotals = totals[0];
        if (!userTotals) {
          console.log(`[sync] No data yet for user ${userId}`);
          continue;
        }

        // Get daily metrics for streak calculation
        const dailyData = await clickhouse.getUserDailyMetrics(userId, 365);
        const dates = dailyData.map((d) => d.date);
        const { currentStreak, longestStreak } = calculateStreaks(dates);

        // Get hourly counts for badges
        const hourCounts = await getUserHourlyCounts(userId);

        // Get longest session messages
        const longestSessionMessages = await getLongestSessionMessages(userId);

        // Get user rank from pre-calculated lookup
        const userRank = rankLookup.get(userId) ?? allUsers.length;

      // Compute badges
      const badges = computeBadges({
        totalMessages: Math.round(userTotals.total_prompts),
        totalToolCalls: 0, // Not tracked in OTel v2 (tool_result events exist but not aggregated)
        currentStreak,
        longestStreak,
        longestSessionMessages,
        hourCounts,
        userRank: userRank > 0 ? userRank : undefined,
      });

      // Update SQLite with all the data
      await db
        .update(users)
        .set({
          // Core totals from ClickHouse
          totalPrompts: Math.round(userTotals.total_prompts),
          totalTokens: Math.round(userTotals.total_tokens),
          totalCostUsd: Math.round(userTotals.total_cost_usd * 100), // Convert to cents!
          totalLinesAdded: Math.round(userTotals.total_lines_added),
          totalCommits: Math.round(userTotals.total_commits),
          totalPrs: Math.round(userTotals.total_prs),
          totalActiveSeconds: Math.round(userTotals.total_active_seconds),
          avgPromptLength: Math.round(userTotals.avg_prompt_length),

          // Streak data
          currentStreak,
          longestStreak,

          // Badge-related
          longestSessionMessages,
          hourCounts: JSON.stringify(hourCounts),
          badges: JSON.stringify(badges),

          // Set first session date if not set
          firstSessionDate:
            dates.length > 0 ? dates.sort()[0] : undefined,

          // Update timestamp
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

        synced++;
        console.log(
          `[sync] Updated user ${userId}: ${userTotals.total_prompts} prompts, ${userTotals.total_tokens} tokens, $${(userTotals.total_cost_usd).toFixed(2)}`
        );
      } catch (error) {
        errors++;
        console.error(`[sync] Error syncing user ${userId}:`, error);
      }
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
