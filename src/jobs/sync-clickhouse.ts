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
import { users, dailyStats } from '../db/schema';
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
        toHour(timestamp) as hour,
        COUNT(*) as count
      FROM events_raw FINAL
      WHERE user_id = {userId:String}
        AND event_name = 'claude_code.user_prompt'
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
        FROM events_raw FINAL
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

    // Get all OTel-enabled users WITH their legacy totals AND current CLI-synced values
    const otelUsers = await db
      .select({
        id: users.id,
        createdAt: users.createdAt,
        // Legacy snapshot (frozen at OTEL enable time)
        legacyPrompts: users.legacyTotalPrompts,
        legacyTokens: users.legacyTotalTokens,
        legacyCostCents: users.legacyTotalCostUsdCents,
        legacyLines: users.legacyTotalLinesAdded,
        legacyCommits: users.legacyTotalCommits,
        legacyToolCalls: users.legacyTotalToolCalls,
        // Legacy token breakdown (for TokenOrbit visualization)
        legacyInputTokens: users.legacyTotalInputTokens,
        legacyOutputTokens: users.legacyTotalOutputTokens,
        legacyCacheReadTokens: users.legacyTotalCacheReadTokens,
        legacyCacheCreationTokens: users.legacyTotalCacheCreationTokens,
        // Legacy hourCounts (frozen at OTEL enable time)
        legacyHourCounts: users.legacyHourCounts,
        // Current values (may have been set by CLI sync - preserve if OTEL has no data)
        currentHourCounts: users.hourCounts,
        currentLongestSession: users.longestSessionMessages,
        currentStreak: users.currentStreak,
        currentLongestStreak: users.longestStreak,
        currentFirstSessionDate: users.firstSessionDate,
      })
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
    for (const user of otelUsers) {
      const {
        id: userId,
        legacyPrompts = 0,
        legacyTokens = 0,
        legacyCostCents = 0,
        legacyLines = 0,
        legacyCommits = 0,
        legacyToolCalls = 0,
        // Legacy token breakdown
        legacyInputTokens = 0,
        legacyOutputTokens = 0,
        legacyCacheReadTokens = 0,
        legacyCacheCreationTokens = 0,
        // Legacy hourCounts (frozen at OTEL enable time)
        legacyHourCounts,
        // Current values from CLI sync (preserve if OTEL has no data)
        currentHourCounts,
        currentLongestSession = 0,
        currentStreak: existingCurrentStreak = 0,
        currentLongestStreak: existingLongestStreak = 0,
        currentFirstSessionDate,
      } = user;

      try {
        // Get totals from ClickHouse (OTEL data only)
        const totals = await clickhouse.getUserTotals(userId);
        const otelTotals = totals[0];

        // Even if no OTEL data yet, we still have legacy data to show
        const hasOtelData = !!otelTotals;
        const userTotals = otelTotals || {
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

        if (!hasOtelData && legacyPrompts === 0) {
          console.log(`[sync] No data yet for user ${userId}`);
          continue;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // BULLETPROOF STREAK CALCULATION
        // Merge dates from BOTH sources to get accurate streaks across transition
        // ═══════════════════════════════════════════════════════════════════════

        // Get dates from ClickHouse (OTEL data, post-enable)
        const otelDailyData = await clickhouse.getUserDailyMetrics(userId, 365);
        const otelDates = otelDailyData.map((d) => d.date);

        // Get dates from SQLite dailyStats (legacy data, pre-enable)
        const legacyDailyActivity = await db
          .select({ date: dailyStats.date })
          .from(dailyStats)
          .where(eq(dailyStats.userId, userId));
        const legacyDates = legacyDailyActivity.map((d) => d.date);

        // Merge all dates (deduplicated) for accurate streak calculation
        const allDates = [...new Set([...legacyDates, ...otelDates])];
        const mergedStreaks = calculateStreaks(allDates);

        // Get hourly counts from OTEL
        const otelHourCounts = await getUserHourlyCounts(userId);
        const hasOtelHourCounts = Object.keys(otelHourCounts).length > 0;

        // Get longest session messages from OTEL
        const otelLongestSession = await getLongestSessionMessages(userId);

        // Get total tool calls from OTEL
        const otelToolCalls = await clickhouse.getUserTotalToolCalls(userId);

        // ═══════════════════════════════════════════════════════════════════════
        // CRITICAL: Use legacyHourCounts (frozen at OTEL enable) + fresh OTEL data
        // DO NOT use currentHourCounts - it gets corrupted by repeated additions
        // ═══════════════════════════════════════════════════════════════════════

        // Parse legacy hourCounts (frozen at OTEL enable time)
        let parsedLegacyHourCounts: Record<string, number> = {};
        try {
          parsedLegacyHourCounts = legacyHourCounts ? JSON.parse(legacyHourCounts) : {};
        } catch {
          parsedLegacyHourCounts = {};
        }

        // Merge hourCounts: legacy (frozen) + OTEL (fresh from ClickHouse)
        // This correctly combines pre-OTEL CLI data with post-OTEL data
        const finalHourCounts: Record<string, number> = { ...parsedLegacyHourCounts };
        for (const [hour, count] of Object.entries(otelHourCounts)) {
          finalHourCounts[hour] = (finalHourCounts[hour] || 0) + count;
        }

        // Streaks: Use merged calculation (combines legacy + OTEL dates)
        // currentStreak: Use merged value directly (it's authoritative)
        // longestStreak: Use max with existing (in case user has >365 day history we can't see)
        const finalCurrentStreak = mergedStreaks.currentStreak;
        const finalLongestStreak = Math.max(mergedStreaks.longestStreak, existingLongestStreak ?? 0);

        // Longest session: Use max of OTEL vs existing
        const finalLongestSession = Math.max(otelLongestSession, currentLongestSession ?? 0);

        // First session date: Prefer existing, fall back to earliest from merged dates
        const finalFirstSessionDate = currentFirstSessionDate || (allDates.length > 0 ? [...allDates].sort()[0] : undefined);

        // Get user rank from pre-calculated lookup
        const userRank = rankLookup.get(userId) ?? allUsers.length;

      // ═══════════════════════════════════════════════════════════════════════
      // CRITICAL: Combine OTEL totals with legacy snapshot
      // This preserves complete user history across the transition
      // ═══════════════════════════════════════════════════════════════════════
      const combinedPrompts = Math.round(userTotals.total_prompts) + (legacyPrompts ?? 0);
      const combinedTokens = Math.round(userTotals.total_tokens) + (legacyTokens ?? 0);
      const combinedCostCents = Math.round(userTotals.total_cost_usd * 100) + (legacyCostCents ?? 0);
      const combinedLines = Math.round(userTotals.total_lines_added) + (legacyLines ?? 0);
      const combinedCommits = Math.round(userTotals.total_commits) + (legacyCommits ?? 0);

      // Token breakdown: OTEL + legacy (for TokenOrbit visualization)
      const combinedInputTokens = Math.round(userTotals.total_input_tokens || 0) + (legacyInputTokens ?? 0);
      const combinedOutputTokens = Math.round(userTotals.total_output_tokens || 0) + (legacyOutputTokens ?? 0);
      const combinedCacheReadTokens = Math.round(userTotals.total_cache_read_tokens || 0) + (legacyCacheReadTokens ?? 0);
      const combinedCacheCreationTokens = Math.round(userTotals.total_cache_write_tokens || 0) + (legacyCacheCreationTokens ?? 0);

      // Combined tool calls: OTEL + legacy
      const combinedToolCalls = otelToolCalls + (legacyToolCalls ?? 0);

      // Compute badges with COMBINED totals and PRESERVED metadata
      const badges = computeBadges({
        totalMessages: combinedPrompts,
        totalToolCalls: combinedToolCalls,
        currentStreak: finalCurrentStreak,
        longestStreak: finalLongestStreak,
        longestSessionMessages: finalLongestSession,
        hourCounts: finalHourCounts,
        userRank: userRank > 0 ? userRank : undefined,
      });

      // Update SQLite with COMBINED totals and PRESERVED metadata
      await db
        .update(users)
        .set({
          // COMBINED totals (OTEL from ClickHouse + legacy snapshot)
          totalPrompts: combinedPrompts,
          totalTokens: combinedTokens,
          totalCostCents: combinedCostCents,
          totalLinesAdded: combinedLines,
          totalCommits: combinedCommits,
          totalPrs: Math.round(userTotals.total_prs), // No legacy PRs tracked
          totalActiveSeconds: Math.round(userTotals.total_active_seconds), // OTEL only
          avgPromptLength: Math.round(userTotals.avg_prompt_length), // OTEL only

          // Token breakdown (for TokenOrbit visualization)
          totalInputTokens: combinedInputTokens,
          totalOutputTokens: combinedOutputTokens,
          totalCacheReadTokens: combinedCacheReadTokens,
          totalCacheCreationTokens: combinedCacheCreationTokens,

          // Streak data (max of OTEL vs CLI-synced)
          currentStreak: finalCurrentStreak,
          longestStreak: finalLongestStreak,

          // Badge-related (preserve CLI-synced if OTEL has no data)
          longestSessionMessages: finalLongestSession,
          hourCounts: JSON.stringify(finalHourCounts),
          badges: JSON.stringify(badges),

          // First session date (prefer CLI-synced)
          firstSessionDate: finalFirstSessionDate,

          // Update timestamp
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

        synced++;
        const otelPrompts = Math.round(userTotals.total_prompts);
        const otelCost = userTotals.total_cost_usd;
        console.log(
          `[sync] Updated user ${userId}: ${combinedPrompts} prompts (${otelPrompts} OTEL + ${legacyPrompts} legacy), $${(combinedCostCents / 100).toFixed(2)} total`
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
