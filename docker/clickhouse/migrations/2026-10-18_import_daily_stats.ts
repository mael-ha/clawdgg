#!/usr/bin/env bun
/**
 * One-off migration: pre-OTEL SQLite `daily_stats` -> ClickHouse.
 *
 * WHY
 * Two stores used to answer "what did this user do before OTEL?": SQLite
 * `daily_stats` (one row per user per day, written by the old CLI) and the
 * `users.legacy_*` snapshot derived from it. Both were read alongside
 * ClickHouse and stitched together at display time, which is where the
 * boundary bugs lived. Moving the history into ClickHouse ends the stitching:
 * after this import, ClickHouse is the single source for every number the site
 * shows.
 *
 * WHICH DAYS
 * Every user, not only the ones who enabled OTEL — a user who never ran
 * `clawdgg setup` has nothing BUT this history, and leaving them out would
 * show them a zeroed profile. For a user with an `otel_setup_date`, days
 * strictly BEFORE it are imported; the setup day itself belongs to OTEL, which
 * has real per-event data for it. For a user without one there is no boundary,
 * so every day is imported.
 *
 * IDEMPOTENCY — read this before changing the skip logic
 * Identity is deterministic: every row's `row_id` is a hash of its identifying
 * fields (src/db/clickhouse.ts), so re-inserting a row collapses under FINAL
 * instead of doubling. That is what makes a partially failed run repairable by
 * simply running it again, and it is why this script does NOT skip a day just
 * because provenance='legacy' rows already exist for it. An earlier version
 * did, which meant a run that died halfway left days that looked done and days
 * that looked pending, and no way to tell which were complete.
 *
 * What it DOES skip: a (user, day) that already has ClickHouse rows of some
 * OTHER provenance — live, backfill, backfill-history or import. Those days
 * are already represented by real per-event data, and adding a daily rollup on
 * top would count the same work twice. The dry run lists them per user.
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
 *   - prompt_length is 0, and the read paths average only over prompts that
 *     have a length, so legacy days do not drag the average down.
 *   - model is '', so legacy days do not appear in the model mix and are
 *     excluded from the cache-savings estimate. Correct: the old CLI did not
 *     record which model was used.
 *   - session_id is '', so legacy days are excluded from per-session analytics
 *     rather than given a fabricated session structure. The real daily session
 *     count rides in the `claude_code.session.count` metric, which is what
 *     getUserDailyMetrics now sums.
 *   - tool_success is 1 because daily_stats counted calls and not outcomes, so
 *     legacy rows are excluded from success-rate queries (NO_LEGACY_SQL).
 *   - hours of day are unknown. Every row lands at 12:00 UTC, so legacy rows
 *     are excluded from hour-of-day and heatmap queries.
 *
 * Cost comes straight from cost_usd_cents, i.e. whatever the old CLI computed.
 * pricing_source is left '' because the match quality behind it was never
 * recorded; provenance='legacy' is what makes those rows traceable.
 *
 * bun:sqlite with raw SQL, deliberately: the app image is slim and this script
 * has to run inside it without dragging in drizzle or better-sqlite3, and
 * reading the old columns by name keeps it independent of schema.ts.
 *
 * Usage (locally):
 *   bun docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts            # dry run
 *   bun docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts --apply
 *   bun docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts --user github_1
 *
 * On the server the app image does NOT contain docker/ (.dockerignore), so
 * mount it in. The compose file, service name and DB path all live on the
 * server, so they are parameters, not constants — `docker compose config
 * --services` lists the real service names:
 *
 *   COMPOSE=/opt/clawdgg/docker-compose.staging.yml
 *   ssh clawdgg "cd /opt/clawdgg && docker compose -f $COMPOSE run --rm \
 *     -v ./docker:/app/docker -e DATABASE_PATH=/data/clawd.db \
 *     app bun docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts"
 *
 * Env:
 *   DATABASE_PATH   SQLite file to read (default ./data/clawd.db)
 *   CLICKHOUSE_URL / CLICKHOUSE_DATABASE  as the app uses them
 */

import { Database } from 'bun:sqlite';
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
  '║  DEPLOY THE CODE THAT DROPPED THE LEGACY READ PATHS BEFORE --apply.       ║',
  '║                                                                           ║',
  '║  If any surface still adds users.legacy_total_* to the ClickHouse totals  ║',
  '║  or reads daily_stats for display, this import makes every all-time       ║',
  '║  number DOUBLE. Deploy first, confirm the site loads, then import — in    ║',
  "║  that order the history is briefly absent, which is visible, instead of   ║",
  '║  doubled, which is not.                                                   ║',
  '║                                                                           ║',
  '║  See docker/clickhouse/migrations/README-2026-10.md, step 5.              ║',
  '╚═══════════════════════════════════════════════════════════════════════════╝',
  '',
].join('\n');

const SEP = '\u001f';

interface Candidate {
  id: string;
  username: string | null;
  otelSetupDate: string | null;
}

/**
 * (user, day) pairs ClickHouse already covers with NON-legacy rows.
 *
 * Deliberately not `provenance = 'legacy'`: see the IDEMPOTENCY note at the top
 * of this file. Re-importing a legacy day is a no-op by construction; importing
 * on top of a day that live OTEL, a JSONL backfill or `clawdgg import` already
 * covers is a double count.
 */
async function daysCoveredByOtherSources(): Promise<Map<string, Set<string>>> {
  const rows = await query<{ user_id: string; date: string; provenances: string[] }>(`
    SELECT user_id, toString(toDate(timestamp)) AS date, groupUniqArray(provenance) AS provenances
    FROM (
      SELECT user_id, timestamp, provenance FROM metrics_raw WHERE provenance != 'legacy'
      UNION ALL
      SELECT user_id, timestamp, provenance FROM events_raw WHERE provenance != 'legacy'
    )
    GROUP BY user_id, date
  `);

  const covered = new Map<string, Set<string>>();
  for (const row of rows) {
    const byUser = covered.get(row.user_id) ?? new Set<string>();
    byUser.add(`${row.date}${SEP}${[...row.provenances].sort().join(',')}`);
    covered.set(row.user_id, byUser);
  }
  return covered;
}

/** The day part of a `date\u001fprovenances` key. */
function keyDate(key: string): string {
  return key.slice(0, key.indexOf(SEP));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const onlyUser = args.includes('--user') ? args[args.indexOf('--user') + 1] : undefined;

  if (args.includes('--help')) {
    console.log('Usage: bun <this file> [--apply] [--user <id>]');
    return;
  }

  const dbPath = process.env.DATABASE_PATH || './data/clawd.db';
  console.log('='.repeat(76));
  console.log(`daily_stats -> ClickHouse  (${apply ? 'APPLY' : 'DRY RUN'})`);
  console.log(`sqlite: ${dbPath}`);
  console.log('='.repeat(76));

  const sqlite = new Database(dbPath, { readonly: true });

  // EVERY user with daily_stats rows, whether or not they ever enabled OTEL.
  // A user with no otel_setup_date has no cutoff, so all of their days import.
  const candidates = sqlite
    .query<Candidate, any[]>(
      `SELECT u.id AS id, u.github_username AS username, u.otel_setup_date AS otelSetupDate
       FROM users u
       WHERE EXISTS (SELECT 1 FROM daily_stats d WHERE d.user_id = u.id)
         ${onlyUser ? 'AND u.id = ?' : ''}
       ORDER BY u.id`
    )
    .all(...(onlyUser ? [onlyUser] : []));

  if (candidates.length === 0) {
    console.log('\nNo users with daily_stats rows — nothing to import.');
    return;
  }

  const covered = await daysCoveredByOtherSources();

  let grandMetrics = 0;
  let grandEvents = 0;
  let grandDays = 0;
  let grandSkipped = 0;

  for (const user of candidates) {
    const cutoff = user.otelSetupDate;
    // Strict `<`: the setup day belongs to OTEL, which has per-event data for
    // it. No cutoff at all means every day is pre-OTEL for this user.
    const days = sqlite
      .query<LegacyDay, any[]>(
        `SELECT date,
                prompt_count AS promptCount,
                tool_call_count AS toolCallCount,
                input_tokens AS inputTokens,
                output_tokens AS outputTokens,
                cache_read_tokens AS cacheReadTokens,
                cache_creation_tokens AS cacheCreationTokens,
                cost_usd_cents AS costUsdCents,
                lines_written AS linesWritten,
                commit_count AS commitCount,
                session_count AS sessionCount
         FROM daily_stats
         WHERE user_id = ?${cutoff ? ' AND date < ?' : ''}
         ORDER BY date`
      )
      .all(...(cutoff ? [user.id, cutoff] : [user.id]));

    const coveredKeys = covered.get(user.id) ?? new Set<string>();
    const coveredDays = new Map<string, string>();
    for (const key of coveredKeys) {
      coveredDays.set(keyDate(key), key.slice(keyDate(key).length + SEP.length));
    }

    const metrics: MetricRow[] = [];
    const events: EventRow[] = [];
    let prompts = 0;
    let toolCalls = 0;
    let tokens = 0;
    let costCents = 0;
    const dates: string[] = [];
    const skipped: string[] = [];

    for (const day of days) {
      const by = coveredDays.get(day.date);
      if (by) {
        skipped.push(`${day.date} (${by})`);
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
    console.log(
      `  cutoff           ${cutoff ?? 'none — every day is pre-OTEL for this user'}`
    );
    console.log(`  days             ${dates.length} to import, ${skipped.length} skipped`);
    console.log(`  range            ${range}`);
    console.log(`  prompts          ${prompts.toLocaleString()}`);
    console.log(`  tool calls       ${toolCalls.toLocaleString()}`);
    console.log(`  tokens           ${tokens.toLocaleString()}`);
    console.log(`  cost             $${(costCents / 100).toFixed(2)}`);
    console.log(`  rows to write    ${metrics.length} metric, ${events.length} event`);
    if (skipped.length > 0) {
      // Named, not just counted: a skipped day is a day whose history comes
      // from somewhere better, and the operator has to be able to check that.
      console.log(`  SKIPPED (ClickHouse already has these days from another source):`);
      for (const line of skipped) console.log(`    ${line}`);
    }

    grandDays += dates.length;
    grandSkipped += skipped.length;
    grandMetrics += metrics.length;
    grandEvents += events.length;

    if (!apply || metrics.length + events.length === 0) continue;

    // Chunked so a large user does not build one enormous request body. A
    // chunk that fails can be re-run: row_id makes the re-insert a no-op.
    const CHUNK = 5000;
    for (let i = 0; i < metrics.length; i += CHUNK) {
      await insertMetrics(metrics.slice(i, i + CHUNK));
    }
    for (let i = 0; i < events.length; i += CHUNK) {
      await insertEvents(events.slice(i, i + CHUNK));
    }
    console.log(`  WROTE            ${metrics.length + events.length} rows`);
  }

  sqlite.close();

  console.log('\n' + '-'.repeat(76));
  console.log(
    `TOTAL  ${grandDays} days to import (${grandSkipped} skipped), ` +
    `${grandMetrics} metric rows, ${grandEvents} event rows`
  );
  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    console.log('Re-running --apply is safe: identity is deterministic, so a');
    console.log('repeated row collapses instead of doubling.');
  }
  console.log(WARNING);
}

// Guard so the test file can import the pure helpers without running anything.
if (import.meta.main) {
  await main();
}
