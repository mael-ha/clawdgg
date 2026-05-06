/**
 * Backfill Script: Populate legacy totals for users who already enabled OTEL
 *
 * This is a one-time migration script to fix data for users who enabled OTEL
 * before we added the legacy snapshot feature.
 *
 * What it does:
 * 1. Finds all OTEL-enabled users with legacyTotalPrompts = 0
 * 2. Calculates their historical totals from dailyStats
 * 3. Updates the legacy_total_* columns
 *
 * Run with: bun src/scripts/backfill-legacy-totals.ts
 */

import { db } from '../db';
import { users, dailyStats } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';

async function backfillLegacyTotals() {
  console.log('='.repeat(60));
  console.log('Backfill Legacy Totals for OTEL Users');
  console.log('='.repeat(60));

  // Find OTEL users who need backfill (legacy prompts = 0 but have dailyStats)
  const otelUsers = await db
    .select({
      id: users.id,
      username: users.githubUsername,
      otelSetupAt: users.otelSetupAt,
      legacyPrompts: users.legacyTotalPrompts,
    })
    .from(users)
    .where(eq(users.otelEnabled, true));

  console.log(`Found ${otelUsers.length} OTEL-enabled users`);

  for (const user of otelUsers) {
    // Get daily stats count to check if they have historical data
    const statsCount = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(dailyStats)
      .where(eq(dailyStats.userId, user.id));

    const hasStats = (statsCount[0]?.count ?? 0) > 0;
    const needsBackfill = user.legacyPrompts === 0 || user.legacyPrompts === null;

    if (!hasStats) {
      console.log(`[${user.username}] No dailyStats found - skipping`);
      continue;
    }

    if (!needsBackfill) {
      console.log(`[${user.username}] Already has legacy data (${user.legacyPrompts} prompts) - skipping`);
      continue;
    }

    // Calculate legacy totals from dailyStats
    const legacyTotals = await db
      .select({
        prompts: sql<number>`COALESCE(SUM(${dailyStats.promptCount}), 0)`,
        tokens: sql<number>`COALESCE(SUM(${dailyStats.tokenCount}), 0)`,
        inputTokens: sql<number>`COALESCE(SUM(${dailyStats.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${dailyStats.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`COALESCE(SUM(${dailyStats.cacheReadTokens}), 0)`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${dailyStats.cacheCreationTokens}), 0)`,
        costUsdCents: sql<number>`COALESCE(SUM(${dailyStats.costUsdCents}), 0)`,
        linesAdded: sql<number>`COALESCE(SUM(${dailyStats.linesWritten}), 0)`,
        commits: sql<number>`COALESCE(SUM(${dailyStats.commitCount}), 0)`,
        toolCalls: sql<number>`COALESCE(SUM(${dailyStats.toolCallCount}), 0)`,
      })
      .from(dailyStats)
      .where(eq(dailyStats.userId, user.id));

    const legacy = legacyTotals[0];
    if (!legacy) {
      console.log(`[${user.username}] No legacy data computed - skipping`);
      continue;
    }

    console.log(`[${user.username}] Backfilling legacy data:`);
    console.log(`  - Prompts: ${legacy.prompts}`);
    console.log(`  - Tokens: ${legacy.tokens}`);
    console.log(`  - Cost: $${(legacy.costUsdCents / 100).toFixed(2)}`);
    console.log(`  - Lines: ${legacy.linesAdded}`);
    console.log(`  - Commits: ${legacy.commits}`);
    console.log(`  - Tool Calls: ${legacy.toolCalls}`);

    // Update user with legacy totals
    await db
      .update(users)
      .set({
        legacyTotalPrompts: legacy.prompts,
        legacyTotalTokens: legacy.tokens,
        legacyTotalInputTokens: legacy.inputTokens,
        legacyTotalOutputTokens: legacy.outputTokens,
        legacyTotalCacheReadTokens: legacy.cacheReadTokens,
        legacyTotalCacheCreationTokens: legacy.cacheCreationTokens,
        legacyTotalCostUsdCents: legacy.costUsdCents,
        legacyTotalLinesAdded: legacy.linesAdded,
        legacyTotalCommits: legacy.commits,
        legacyTotalToolCalls: legacy.toolCalls,
        // Also set otelSetupDate if not set
        otelSetupDate: user.otelSetupAt
          ? new Date(user.otelSetupAt).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0],
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    console.log(`  -> Updated!`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Backfill complete!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Trigger a sync to update totals: POST /api/admin/sync');
  console.log('2. Check your profile to verify data looks correct');
  console.log('='.repeat(60));
}

// Run the backfill
backfillLegacyTotals()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });
