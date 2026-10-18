#!/usr/bin/env bun
/**
 * One-off migration: pre-OTEL SQLite `daily_stats` -> ClickHouse.
 *
 * WHY
 * Two stores answer "what did this user do before OTEL?": SQLite `daily_stats`
 * (one row per user per day, written by the old CLI) and the `users.legacy_*`
 * snapshot columns derived from it. Both are read alongside ClickHouse and
 * stitched together at display time, which is where the boundary bug lives:
 * getLegacyChartData selects `date <= otelSetupDate` while the ClickHouse side
 * starts AT otelSetupDate, so the setup day is counted twice. Moving the
 * history into ClickHouse ends the stitching.
 *
 * Imported days are strictly BEFORE the user's otel_setup_date. Strict `<` is
 * the fix: the setup day belongs to OTEL, which has real per-event data for it.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DO NOT --apply BEFORE RETIRING THE LEGACY READ PATHS.                   │
 * │                                                                         │
 * │ src/routes/api.ts adds users.legacy_total_* to the ClickHouse totals    │
 * │ for all-time views, and getLegacyChartData reads daily_stats directly.  │
 * │ With this import applied AND those paths still live, every all-time     │
 * │ total doubles. The runbook (README-2026-10.md) lists the exact call     │
 * │ sites to remove first. This script prints the same warning and will not │
 * │ check it for you.                                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * WHAT IS AND IS NOT RECONSTRUCTIBLE
 * daily_stats holds daily totals, not events, so the import synthesizes the
 * minimum that makes the ClickHouse aggregates come out right:
 *   - one `claude_code.user_prompt` event per prompt (prompts are COUNTED, so a
 *     single row per day would read as one prompt)
 *   - one `claude_code.tool_result` event per tool call, same reason
 *   - one metric row per day per measure (tokens by type, cost, lines added,
 *     commits, sessions), since those are SUMMED
 * Everything daily_stats never recorded stays absent rather than invented:
 *   - prompt_length is 0. Legacy days do not contribute to prompt-length stats
 *     (getUserPromptLengthStats already filters prompt_length > 0) and they
 *     pull the leaderboard's avg_prompt_length down — accept it or exclude
 *     provenance='legacy' there.
 *   - model is '', so legacy days do not appear in the model mix. Correct: the
 *     old CLI did not record which model was used.
 *   - session_id is '', so legacy days are excluded from per-session analytics
 *     rather than given a fabricated session structure. The real daily session
 *     count rides in the `claude_code.session.count` metric; note that
 *     getUserDailyMetrics derives `sessions` from uniqExact(session_id) and so
 *     reads 1 for a legacy day. Switching it to sum the session.count metric is
 *     a separate call — see the runbook.
 *   - hours of day are unknown. Every row lands at 12:00 UTC, so the activity
 *     heatmap shows legacy days as a noon spike.
 *
 * Cost comes straight from cost_usd_cents, i.e. whatever the old CLI computed.
 * pricing_source is left '' because the match quality behind it was never
 * recorded; provenance='legacy' is what makes those rows traceable.
 *
 * IDEMPOTENT: a (user, day) that already has provenance='legacy' rows is
 * skipped, and row_id makes a re-insert collapse under FINAL even if it is not.
 *
 * Usage:
 *   bun docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts            # dry run
 *   bun docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts --apply
 *   bun docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts --user github_1
 */

import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { db } from '../../../src/db';
import { dailyStats, users } from '../../../src/db/schema';
import {
  insertEvents,
  insertMetrics,
  query,
  type EventRow,
  type MetricRow,
} from '../../../src/db/clickhouse';

// ═══════════════════════════════════════════════════════════════════════════
// Row construction (pure — unit-tested)
// ═══════════════════════════════════════════════════════════════════════════

export interface LegacyDay {
  date: string; // YYYY-MM-DD
  promptCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdCents: number;
  linesWritten: number;
  commitCount: number;
  sessionCount: number;
}

const NOON_MS = 12 * 60 * 60 * 1000;
// Offsets run forward from noon, so this is where a day's rows would spill into
// the next day — and a legacy row landing on the wrong date would double-count
// against a day OTEL already owns.
const MAX_OFFSET_MS = 12 * 60 * 60 * 1000;

/** ClickHouse DateTime64(3) literal: "YYYY-MM-DD HH:MM:SS.sss", UTC, no suffix. */
export function legacyTimestamp(date: string, offsetMs = 0): string {
  if (offsetMs >= MAX_OFFSET_MS) {
    throw new Error(
      `${date}: ${offsetMs}ms of rows would spill past midnight into the next day`
    );
  }
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`Unparseable daily_stats date: "${date}"`);
  const d = new Date(ms + NOON_MS + offsetMs);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

export function legacyRowsForDay(
  userId: string,
  day: LegacyDay
): { metrics: MetricRow[]; events: EventRow[] } {
  const at = legacyTimestamp(day.date);
  const base = {
    timestamp: at,
    user_id: userId,
    session_id: '',
    provenance: 'legacy' as const,
  };

  const metrics: MetricRow[] = [];
  const measure = (metric_name: string, value: number, extra: Partial<MetricRow> = {}) => {
    // A zero is not a measurement, it is the absence of one. Skipping keeps the
    // table small and keeps `countIf`-style probes honest.
    if (value > 0) metrics.push({ ...base, metric_name, value, ...extra });
  };

  measure('claude_code.token.usage', day.inputTokens, { token_type: 'input' });
  measure('claude_code.token.usage', day.outputTokens, { token_type: 'output' });
  measure('claude_code.token.usage', day.cacheReadTokens, { token_type: 'cacheRead' });
  measure('claude_code.token.usage', day.cacheCreationTokens, { token_type: 'cacheCreation' });
  measure('claude_code.cost.usage', day.costUsdCents / 100);
  measure('claude_code.lines_of_code.count', day.linesWritten, { line_type: 'added' });
  measure('claude_code.commit.count', day.commitCount);
  measure('claude_code.session.count', day.sessionCount);

  const events: EventRow[] = [];
  // One row per prompt / per tool call: both are counted, not summed. Each gets
  // its own millisecond because the identity hash includes the timestamp —
  // identical rows at the same instant are one row by definition.
  for (let i = 0; i < day.promptCount; i++) {
    events.push({
      ...base,
      timestamp: legacyTimestamp(day.date, i),
      event_name: 'claude_code.user_prompt',
      prompt_length: 0, // daily_stats never recorded it
    });
  }
  for (let i = 0; i < day.toolCallCount; i++) {
    events.push({
      ...base,
      timestamp: legacyTimestamp(day.date, i),
      event_name: 'claude_code.tool_result',
      tool_success: 1, // daily_stats counted calls, not outcomes
    });
  }

  return { metrics, events };
}

// ═══════════════════════════════════════════════════════════════════════════
// Migration
// ═══════════════════════════════════════════════════════════════════════════

const WARNING = [
  '',
  '╔═══════════════════════════════════════════════════════════════════════════╗',
  '║  THE LEGACY READ PATHS MUST BE RETIRED BEFORE THIS IMPORT IS LIVE.        ║',
  '║                                                                           ║',
  '║  Still reading the same history today:                                    ║',
  '║    - src/routes/api.ts  adds users.legacy_total_* to ClickHouse totals    ║',
  '║    - clickhouse.getLegacyChartData reads SQLite daily_stats directly       ║',
  '║                                                                           ║',
  '║  With both live AND this import applied, every all-time total DOUBLES.    ║',
  '║  See docker/clickhouse/migrations/README-2026-10.md.                      ║',
  '╚═══════════════════════════════════════════════════════════════════════════╝',
  '',
].join('\n');

/** (user, day) pairs that already carry provenance='legacy' rows. */
async function alreadyImported(): Promise<Set<string>> {
  const rows = await query<{ user_id: string; date: string }>(`
    SELECT user_id, toString(toDate(timestamp)) AS date
    FROM (
      SELECT user_id, timestamp FROM metrics_raw WHERE provenance = 'legacy'
      UNION ALL
      SELECT user_id, timestamp FROM events_raw WHERE provenance = 'legacy'
    )
    GROUP BY user_id, date
  `);
  return new Set(rows.map(r => `${r.user_id}\u001f${r.date}`));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const userFilter = args[args.indexOf('--user') + 1];
  const onlyUser = args.includes('--user') ? userFilter : undefined;

  if (args.includes('--help')) {
    console.log('Usage: bun <this file> [--apply] [--user <id>]');
    return;
  }

  console.log('='.repeat(76));
  console.log(`daily_stats -> ClickHouse  (${apply ? 'APPLY' : 'DRY RUN'})`);
  console.log('='.repeat(76));

  const candidates = await db
    .select({
      id: users.id,
      username: users.githubUsername,
      otelSetupDate: users.otelSetupDate,
    })
    .from(users)
    .where(
      onlyUser
        ? and(isNotNull(users.otelSetupDate), eq(users.id, onlyUser))
        : isNotNull(users.otelSetupDate)
    );

  if (candidates.length === 0) {
    console.log('\nNo users with an otel_setup_date — nothing to import.');
    console.log('(A user who never enabled OTEL has no boundary, so no legacy cutoff.)');
    return;
  }

  const imported = await alreadyImported();

  let grandMetrics = 0;
  let grandEvents = 0;
  let grandDays = 0;
  let grandSkipped = 0;

  for (const user of candidates) {
    const cutoff = user.otelSetupDate!;
    // Strict `<`: the setup day belongs to OTEL. getLegacyChartData's `<=` is
    // the boundary double-count this migration exists to end.
    const days = await db
      .select({
        date: dailyStats.date,
        promptCount: dailyStats.promptCount,
        toolCallCount: dailyStats.toolCallCount,
        inputTokens: dailyStats.inputTokens,
        outputTokens: dailyStats.outputTokens,
        cacheReadTokens: dailyStats.cacheReadTokens,
        cacheCreationTokens: dailyStats.cacheCreationTokens,
        costUsdCents: dailyStats.costUsdCents,
        linesWritten: dailyStats.linesWritten,
        commitCount: dailyStats.commitCount,
        sessionCount: dailyStats.sessionCount,
      })
      .from(dailyStats)
      .where(and(eq(dailyStats.userId, user.id), lt(dailyStats.date, cutoff)))
      .orderBy(asc(dailyStats.date));

    const metrics: MetricRow[] = [];
    const events: EventRow[] = [];
    let prompts = 0;
    let toolCalls = 0;
    let tokens = 0;
    let costCents = 0;
    let skipped = 0;
    const dates: string[] = [];

    for (const day of days) {
      if (imported.has(`${user.id}\u001f${day.date}`)) {
        skipped++;
        continue;
      }
      const rows = legacyRowsForDay(user.id, day);
      metrics.push(...rows.metrics);
      events.push(...rows.events);
      prompts += day.promptCount;
      toolCalls += day.toolCallCount;
      tokens +=
        day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheCreationTokens;
      costCents += day.costUsdCents;
      dates.push(day.date);
    }

    const range = dates.length > 0 ? `${dates[0]} .. ${dates[dates.length - 1]}` : '—';
    console.log(`\n${user.username ?? user.id}  (${user.id})`);
    console.log(`  otel_setup_date  ${cutoff}  (importing days strictly before it)`);
    console.log(`  days             ${dates.length} new, ${skipped} already imported`);
    console.log(`  range            ${range}`);
    console.log(`  prompts          ${prompts.toLocaleString()}`);
    console.log(`  tool calls       ${toolCalls.toLocaleString()}`);
    console.log(`  tokens           ${tokens.toLocaleString()}`);
    console.log(`  cost             $${(costCents / 100).toFixed(2)}`);
    console.log(`  rows to write    ${metrics.length} metric, ${events.length} event`);

    grandDays += dates.length;
    grandSkipped += skipped;
    grandMetrics += metrics.length;
    grandEvents += events.length;

    if (!apply || metrics.length + events.length === 0) continue;

    // Chunked so a large user does not build one enormous request body.
    const CHUNK = 5000;
    for (let i = 0; i < metrics.length; i += CHUNK) {
      await insertMetrics(metrics.slice(i, i + CHUNK));
    }
    for (let i = 0; i < events.length; i += CHUNK) {
      await insertEvents(events.slice(i, i + CHUNK));
    }
    console.log(`  WROTE            ${metrics.length + events.length} rows`);
  }

  console.log('\n' + '-'.repeat(76));
  console.log(
    `TOTAL  ${grandDays} new days (${grandSkipped} skipped), ` +
    `${grandMetrics} metric rows, ${grandEvents} event rows`
  );
  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
  }
  console.log(WARNING);
}

// Guard so the test file can import the pure helpers without running anything.
if (import.meta.main) {
  await main();
}
