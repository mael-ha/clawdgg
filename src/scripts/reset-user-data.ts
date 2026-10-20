#!/usr/bin/env bun
/**
 * Put one user back to never-having-used-it, to test the flow from scratch.
 *
 *   bun src/scripts/reset-user-data.ts <github_username>          # dry run
 *   bun src/scripts/reset-user-data.ts <github_username> --apply
 *
 * WHAT IT USED TO DO, AND WHY THAT WAS WORSE THAN NOTHING. It deleted SQLite
 * `daily_stats`, zeroed the `legacy_total_*` snapshot columns, and printed
 * instructions ending in `clawdgg sync`. All three of those are gone:
 * daily_stats is read by nothing, the legacy snapshot was retired in favour of
 * asking ClickHouse per provenance, and there is no `sync` subcommand. So it
 * reported a successful reset while leaving every number the site shows exactly
 * where it was — the user's profile was unchanged, and the operator had been
 * told it was clean.
 *
 * The data lives in ClickHouse, so that is what this deletes. `users.total_*`
 * is a cache of those rows and is zeroed in the same pass; the next sync run
 * recomputes it from what is left, which is nothing.
 *
 * DESTRUCTIVE AND NOT REVERSIBLE. There is no undo for the raw rows: a user's
 * history is only in ClickHouse. Dry run by default for that reason.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { query } from '../db/clickhouse';

/** Mutations take as long as they take; the 10s read budget would abort one. */
const MUTATION_TIMEOUT_MS = 10 * 60 * 1000;

async function countRows(table: 'events_raw' | 'metrics_raw', userId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT toUInt64(count()) AS n FROM ${table} FINAL WHERE user_id = {userId:String}`,
    { userId }
  );
  return Number(rows[0]?.n) || 0;
}

async function resetUserData(username: string, apply: boolean): Promise<void> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.githubUsername, username))
    .get();

  if (!user) {
    console.error(`User not found: ${username}`);
    process.exit(1);
  }

  const [events, metrics] = await Promise.all([
    countRows('events_raw', user.id),
    countRows('metrics_raw', user.id),
  ]);

  console.log(`${user.githubUsername} (${user.id})`);
  console.log(`  OTEL enabled   : ${user.otelEnabled}`);
  console.log(`  cached prompts : ${user.totalPrompts}`);
  console.log(`  events_raw     : ${events.toLocaleString('en-US')} rows`);
  console.log(`  metrics_raw    : ${metrics.toLocaleString('en-US')} rows`);
  console.log('');
  console.log('This DELETES every one of those rows — every provenance, live');
  console.log('included — and zeroes the cached totals. There is no undo.');

  if (!apply) {
    console.log('\nDry run. Nothing was changed. Re-run with --apply.');
    return;
  }

  // mutations_sync = 2 inside the statement: an ALTER ... DELETE is applied in
  // the background otherwise, and the counts printed afterwards would be read
  // against rows that are still there.
  for (const table of ['events_raw', 'metrics_raw'] as const) {
    console.log(`Deleting from ${table}…`);
    await query(
      `ALTER TABLE ${table} DELETE WHERE user_id = {userId:String} SETTINGS mutations_sync = 2`,
      { userId: user.id },
      { timeoutMs: MUTATION_TIMEOUT_MS }
    );
    // A DELETE does not forget the insert deduplication log (see insert() in
    // src/db/clickhouse.ts): a re-import that posts the same batches would be
    // dropped as retries of the rows just deleted, and the "from scratch" test
    // would land nothing. Turning the window off and on again empties the log
    // — verified on 24.3 — at the cost of this table's retry protection, for
    // the length of two metadata statements.
    await query(`ALTER TABLE ${table} MODIFY SETTING non_replicated_deduplication_window = 0`);
    await query(`ALTER TABLE ${table} MODIFY SETTING non_replicated_deduplication_window = 10000`);
  }

  await db
    .update(users)
    .set({
      otelEnabled: false,
      otelSetupAt: null,
      otelSetupDate: null,
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
      currentStreak: 0,
      longestStreak: 0,
      firstSessionDate: null,
      badges: null,
      hourCounts: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  const [eventsLeft, metricsLeft] = await Promise.all([
    countRows('events_raw', user.id),
    countRows('metrics_raw', user.id),
  ]);
  console.log(`\nLeft behind: ${eventsLeft} events, ${metricsLeft} metrics (both must be 0).`);
  console.log('');
  console.log('To test the flow from here:');
  console.log('  1. `clawdgg setup`  — enables OTEL and records the cutoff');
  console.log('  2. use Claude Code  — rows arrive over OTLP as provenance=live');
  console.log('  3. `clawdgg import` — loads local history up to that cutoff');
  console.log('  4. the sync job (or POST /api/admin/sync) refreshes users.total_*');
}

const username = process.argv[2];
if (!username || username.startsWith('--')) {
  console.error('Usage: bun src/scripts/reset-user-data.ts <github_username> [--apply]');
  process.exit(1);
}

resetUserData(username, process.argv.includes('--apply'))
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Reset failed:', error);
    process.exit(1);
  });
