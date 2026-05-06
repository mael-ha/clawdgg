/**
 * Reset User Data Script
 *
 * Resets a user's data to test the full OTEL flow from scratch:
 * 1. Clears all dailyStats
 * 2. Resets all totals to 0
 * 3. Disables OTEL
 * 4. Clears legacy snapshot
 *
 * After running this:
 * 1. Run `clawdgg sync` to re-import historical data
 * 2. Run `clawdgg setup` to enable OTEL (will snapshot the data)
 * 3. Use Claude Code - OTEL data will flow
 * 4. Verify combined totals on profile
 *
 * Run with: bun src/scripts/reset-user-data.ts <github_username>
 */

import { db } from '../db';
import { users, dailyStats } from '../db/schema';
import { eq } from 'drizzle-orm';

async function resetUserData(username: string) {
  console.log('='.repeat(60));
  console.log(`Resetting data for user: ${username}`);
  console.log('='.repeat(60));

  // Find the user
  const user = await db
    .select()
    .from(users)
    .where(eq(users.githubUsername, username))
    .get();

  if (!user) {
    console.error(`User not found: ${username}`);
    process.exit(1);
  }

  console.log(`Found user: ${user.id} (${user.githubUsername})`);
  console.log('');

  // Show current state
  console.log('Current state:');
  console.log(`  - OTEL enabled: ${user.otelEnabled}`);
  console.log(`  - Total prompts: ${user.totalPrompts}`);
  console.log(`  - Legacy prompts: ${user.legacyTotalPrompts}`);
  console.log('');

  // Count daily stats
  const statsCount = await db
    .select({ id: dailyStats.id })
    .from(dailyStats)
    .where(eq(dailyStats.userId, user.id));

  console.log(`Daily stats entries: ${statsCount.length}`);

  // Confirm reset
  console.log('');
  console.log('This will:');
  console.log('  1. DELETE all daily_stats entries');
  console.log('  2. Reset all total_* columns to 0');
  console.log('  3. Disable OTEL');
  console.log('  4. Clear legacy snapshot columns');
  console.log('');

  // Delete daily stats
  const deleted = await db
    .delete(dailyStats)
    .where(eq(dailyStats.userId, user.id));

  console.log(`Deleted ${statsCount.length} daily_stats entries`);

  // Reset user totals
  await db
    .update(users)
    .set({
      // Disable OTEL
      otelEnabled: false,
      otelSetupAt: null,
      otelSetupDate: null,

      // Reset OTEL totals
      totalPrompts: 0,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostCents: 0,
      totalLinesAdded: 0,
      totalCommits: 0,
      totalPrs: 0,
      totalActiveSeconds: 0,
      avgPromptLength: 0,

      // Clear legacy snapshot
      legacyTotalPrompts: 0,
      legacyTotalTokens: 0,
      legacyTotalInputTokens: 0,
      legacyTotalOutputTokens: 0,
      legacyTotalCacheReadTokens: 0,
      legacyTotalCacheCreationTokens: 0,
      legacyTotalCostUsdCents: 0,
      legacyTotalLinesAdded: 0,
      legacyTotalCommits: 0,
      legacyTotalToolCalls: 0,

      // Reset streaks and badges
      currentStreak: 0,
      longestStreak: 0,
      badges: null,
      hourCounts: null,

      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  console.log('Reset all user totals to 0');

  console.log('');
  console.log('='.repeat(60));
  console.log('Reset complete!');
  console.log('');
  console.log('Next steps to test the flow:');
  console.log('');
  console.log('1. Run `clawdgg sync` to import your historical JSONL data');
  console.log('   → This populates daily_stats');
  console.log('   → You should see your stats on the leaderboard');
  console.log('');
  console.log('2. Run `clawdgg setup` to enable OTEL');
  console.log('   → This snapshots daily_stats into legacy_total_*');
  console.log('   → Configures OTEL streaming');
  console.log('');
  console.log('3. Use Claude Code (make some prompts)');
  console.log('   → OTEL data flows to ClickHouse');
  console.log('   → Sync job adds OTEL + legacy totals');
  console.log('');
  console.log('4. Check your profile - should show COMBINED totals');
  console.log('='.repeat(60));
}

// Get username from args
const username = process.argv[2];
if (!username) {
  console.error('Usage: bun src/scripts/reset-user-data.ts <github_username>');
  process.exit(1);
}

resetUserData(username)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Reset failed:', error);
    process.exit(1);
  });
