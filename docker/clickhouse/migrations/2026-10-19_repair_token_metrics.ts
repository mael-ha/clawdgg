#!/usr/bin/env bun
/**
 * One-off repair: rebuild live token and cost metrics from api_request events.
 *
 * THE LOSS
 * metrics_raw's old sorting key was
 *   (user_id, metric_name, token_type, line_type, timestamp)
 * and Claude Code exports metrics PERIODICALLY: every datapoint in one export
 * interval carries the same timestamp and differs only by attributes the key
 * did not contain — model, query_source, speed. So an export covering ten
 * requests collapsed to ONE row per token type, and nine tenths of the
 * measurement was discarded on merge. Measured on prod on 2026-10-18, over the
 * last 30 days of provenance='live' rows:
 *
 *   sum(value) of claude_code.token.usage   (metrics_raw)   9,446,112,211
 *   sum(input+output+cacheRead+cacheWrite)  (api_request)  25,259,653,024
 *
 * 63% of the tokens were gone. Row counts tell the same story from the other
 * side: 1,477,211 events against 564,972 metrics, where one api_request should
 * produce one event and four or five metric datapoints.
 *
 * WHY EVENTS SURVIVED
 * events_raw's old key ended in `timestamp` too, but a log record carries the
 * instant it happened rather than the instant it was exported, so two
 * api_requests collide only when they share a MILLISECOND. That still happens
 * — parallel subagents, and `session_id` is empty on every live row, so it
 * cannot separate them either — so the restored figure is a FLOOR, not a
 * recovered truth. Say so wherever it is published. The runbook has a query
 * that bounds the residual.
 *
 * WHY THIS AND NOT A QUERY CHANGE
 * The alternative is reading tokens and cost from events everywhere instead.
 * It was rejected: the pre-OTEL `legacy` rows have metric rows and NO
 * api_request events (daily_stats recorded daily totals, not requests), so
 * every token/cost query would become a union of two sources with a provenance
 * split — exactly the stitching src/db/no-legacy-reads.test.ts exists to keep
 * out. Repairing the data instead leaves metrics_raw as the one source and
 * needs no change to a single read path.
 *
 * WHEN TO RUN IT
 * AFTER the exchange in step 4 of README-2026-10.md, never before. The old key
 * is what collapses these rows, so rows inserted into the old table would be
 * collapsed again on merge — the repair only sticks once `row_id` is part of
 * the sorting key.
 *
 * IDEMPOTENCY
 * The derived rows' identity is a hash of the request's own timestamp, model,
 * session and provenance (metricRowId), so a second run produces byte-identical
 * row_ids that collapse under FINAL instead of doubling. The DELETE targets
 * `provenance = 'live'` rows only, so it finds nothing on a second run.
 *
 * ORDER OF OPERATIONS, and why it is the risky way round
 * DELETE first, then INSERT. If the script dies between them the tokens are
 * briefly MISSING, which is visible and fixed by re-running. The other order
 * would leave them DOUBLED, which is silent. That is the same choice the
 * daily_stats import makes, for the same reason.
 *
 * Usage (locally):
 *   bun docker/clickhouse/migrations/2026-10-19_repair_token_metrics.ts            # dry run
 *   bun docker/clickhouse/migrations/2026-10-19_repair_token_metrics.ts --apply
 *
 * On the server, docker/ is not in the image (.dockerignore), so mount it:
 *   COMPOSE=/opt/clawdgg/docker-compose.staging.yml
 *   ssh clawdgg "cd /opt/clawdgg && docker compose -f $COMPOSE run --rm \
 *     -v ./docker:/app/docker \
 *     app bun docker/clickhouse/migrations/2026-10-19_repair_token_metrics.ts"
 *
 * Env: CLICKHOUSE_URL / CLICKHOUSE_DATABASE, as the app uses them.
 */

import { METRIC_IDENTITY_COLUMNS, identitySqlExpr, query } from '../../../src/db/clickhouse';

// ═══════════════════════════════════════════════════════════════════════════
// The SQL (exported, so the tests can run it against a real clickhouse-local)
// ═══════════════════════════════════════════════════════════════════════════

/** What the repaired rows are tagged with, so every figure stays traceable. */
export const REPAIR_PROVENANCE = 'repair';

/**
 * The OTEL-measured rows, before and after the repair.
 *
 * Both provenances together, because the repair MOVES rows from one to the
 * other: reading 'live' alone would show the total collapsing to zero the
 * moment the repair succeeds.
 */
export const MEASURED_PROVENANCE_SQL = `provenance IN ('live', '${REPAIR_PROVENANCE}')`;

/** The events a token/cost datapoint can be rebuilt from. */
export const REPAIRABLE_EVENTS_SQL = `
  provenance = 'live'
  AND event_name = 'claude_code.api_request'
  AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0
       OR cache_write_tokens > 0 OR cost_usd > 0)`;

/**
 * The live token/cost rows the repair supersedes.
 *
 * Scoped to (user, day) pairs that HAVE api_request events, which is the whole
 * safety property of this step: a day with metrics and no events — a user who
 * exported metrics but not logs, or a window before the app read api_request
 * attributes — keeps its original rows instead of losing them to a repair that
 * has nothing to offer in their place.
 */
export const SUPERSEDED_METRICS_SQL = `
  provenance = 'live'
  AND metric_name IN ('claude_code.token.usage', 'claude_code.cost.usage')
  AND (user_id, toDate(timestamp)) IN (
    SELECT user_id, toDate(timestamp)
    FROM events_raw
    WHERE ${REPAIRABLE_EVENTS_SQL}
  )`;

/**
 * One metric row per token type per request, plus one cost row.
 *
 * Per REQUEST, not per day or per hour: the event carries the instant it
 * happened, so nothing has to be synthesized. That also restores the model on
 * every row, which is what the model mix and the cache-savings estimate read,
 * and it is why this is more faithful than the rows it replaces rather than
 * merely larger.
 *
 * `cost_usd` is Claude Code's OWN figure for the request, so the cost rows are
 * a measurement and not a re-pricing — pricing_source stays empty to say so.
 *
 * Attribution that the old app never captured (query_source, speed) comes
 * through as empty, which is honest: the share-of-subagent-value figures count
 * only rows where query_source is set, so these are correctly left out of them
 * rather than silently counted as main-thread.
 */
export const DERIVE_INSERT_SQL = `
INSERT INTO metrics_raw (
  timestamp, user_id, session_id, metric_name, value,
  model, token_type, line_type, time_type,
  tool, decision, language, source,
  query_source, speed, effort, agent_name, skill_name, plugin_name,
  marketplace_name, mcp_server_name, mcp_tool_name, start_type,
  terminal_type, app_version, account_uuid, organization_id,
  provenance, pricing_source, row_id
)
SELECT
  timestamp, user_id, session_id, metric_name, value,
  model, token_type, line_type, time_type,
  tool, decision, language, source,
  query_source, speed, effort, agent_name, skill_name, plugin_name,
  marketplace_name, mcp_server_name, mcp_tool_name, start_type,
  terminal_type, app_version, account_uuid, organization_id,
  provenance, pricing_source,
  ${identitySqlExpr(METRIC_IDENTITY_COLUMNS)} AS row_id
FROM (
  SELECT
    timestamp,
    user_id,
    session_id,
    part.1 AS metric_name,
    part.2 AS value,
    part.3 AS token_type,
    model,
    '' AS line_type,
    '' AS time_type,
    '' AS tool,
    '' AS decision,
    '' AS language,
    '' AS source,
    query_source,
    speed,
    effort,
    agent_name,
    skill_name,
    '' AS plugin_name,
    marketplace_name,
    '' AS mcp_server_name,
    '' AS mcp_tool_name,
    '' AS start_type,
    terminal_type,
    app_version,
    account_uuid,
    organization_id,
    '${REPAIR_PROVENANCE}' AS provenance,
    '' AS pricing_source
  FROM (
    -- THE FILTER LIVES IN ITS OWN SUBQUERY, AND MUST STAY THERE.
    -- A ClickHouse SELECT alias SHADOWS the table column of the same name, so
    -- with \`'repair' AS provenance\` in the same SELECT as
    -- \`WHERE provenance = 'live'\`, the predicate reads the alias, matches
    -- nothing, and the whole repair silently inserts ZERO rows — no error, no
    -- warning. Measured, not guessed: that was this statement's first draft.
    SELECT
      timestamp, user_id, session_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
      query_source, speed, effort, agent_name, skill_name, marketplace_name,
      terminal_type, app_version, account_uuid, organization_id
    FROM events_raw
    WHERE ${REPAIRABLE_EVENTS_SQL}
  )
  ARRAY JOIN arrayFilter(
    x -> x.2 > 0,
    [
      ('claude_code.token.usage', toFloat64(input_tokens), 'input'),
      ('claude_code.token.usage', toFloat64(output_tokens), 'output'),
      ('claude_code.token.usage', toFloat64(cache_read_tokens), 'cacheRead'),
      ('claude_code.token.usage', toFloat64(cache_write_tokens), 'cacheCreation'),
      ('claude_code.cost.usage', toFloat64(cost_usd), '')
    ]
  ) AS part
)`;

/**
 * `mutations_sync = 2` is part of the statement, not a caller's choice.
 *
 * ALTER ... DELETE is a MUTATION: ClickHouse accepts it and applies it in the
 * background, so without this the next statement — the insert — can run against
 * rows that are still there, and the totals land wherever the race lands. The
 * first version of the test for this was green only by timing.
 */
export const DELETE_SUPERSEDED_SQL = `
ALTER TABLE metrics_raw
DELETE WHERE ${SUPERSEDED_METRICS_SQL}
SETTINGS mutations_sync = 2`;

// ═══════════════════════════════════════════════════════════════════════════
// Reconciliation — what the operator reads before and after
// ═══════════════════════════════════════════════════════════════════════════

export interface Reconciliation {
  scope: string;
  metric_tokens: number;
  event_tokens: number;
  metric_cost: number;
  event_cost: number;
  rows_superseded: number;
  rows_to_write: number;
}

/**
 * The before/after figures, overall and per user.
 *
 * `event_*` is what the repair will make the totals say; `metric_*` is what
 * they say now. Both sides are read with FINAL, because the collapsed state is
 * exactly what FINAL produces and an un-FINAL read would flatter the current
 * numbers with rows that are about to be merged away.
 */
export async function reconcile(): Promise<Reconciliation[]> {
  const rows = await query<Reconciliation>(`
    WITH
      metric_side AS (
        SELECT
          user_id,
          sumIf(value, metric_name = 'claude_code.token.usage') AS metric_tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') AS metric_cost
        FROM metrics_raw FINAL
        WHERE ${MEASURED_PROVENANCE_SQL}
          AND metric_name IN ('claude_code.token.usage', 'claude_code.cost.usage')
        GROUP BY user_id
      ),
      event_side AS (
        SELECT
          user_id,
          sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS event_tokens,
          sum(cost_usd) AS event_cost,
          sum(
            (input_tokens > 0) + (output_tokens > 0) + (cache_read_tokens > 0)
            + (cache_write_tokens > 0) + (cost_usd > 0)
          ) AS rows_to_write
        FROM events_raw FINAL
        WHERE ${REPAIRABLE_EVENTS_SQL}
        GROUP BY user_id
      )
    SELECT
      COALESCE(m.user_id, e.user_id) AS scope,
      toFloat64(COALESCE(m.metric_tokens, 0)) AS metric_tokens,
      toFloat64(COALESCE(e.event_tokens, 0)) AS event_tokens,
      toFloat64(COALESCE(m.metric_cost, 0)) AS metric_cost,
      toFloat64(COALESCE(e.event_cost, 0)) AS event_cost,
      toUInt64(0) AS rows_superseded,
      toUInt64(COALESCE(e.rows_to_write, 0)) AS rows_to_write
    FROM metric_side m
    FULL OUTER JOIN event_side e ON m.user_id = e.user_id
    ORDER BY event_tokens DESC
  `);
  return rows;
}

/** Exactly how many rows the DELETE will remove. Its own query, to stay legible. */
export async function supersededCount(): Promise<number> {
  const rows = await query<{ n: number }>(`
    SELECT toUInt64(count()) AS n
    FROM metrics_raw FINAL
    WHERE ${SUPERSEDED_METRICS_SQL}
  `);
  return Number(rows[0]?.n) || 0;
}

/**
 * How much of the loss is NOT recoverable, bounded from below.
 *
 * Two api_requests in the same millisecond with the same empty session_id
 * collapsed in events_raw too, and a collapsed row leaves no trace of what it
 * absorbed — so the true number is unknowable after the fact. What IS knowable
 * is how many events_raw rows are still waiting to be merged away: the gap
 * between a raw count and a FINAL count. That is a floor on the events lost,
 * and it is the honest thing to publish beside the repaired totals.
 */
export async function residualBound(): Promise<{
  raw: number;
  deduped: number;
  pending_collapse: number;
  distinct_instants: number;
}> {
  const rows = await query<{
    raw: number;
    deduped: number;
    pending_collapse: number;
    distinct_instants: number;
  }>(`
    SELECT
      toUInt64((SELECT count() FROM events_raw WHERE ${REPAIRABLE_EVENTS_SQL})) AS raw,
      toUInt64((SELECT count() FROM events_raw FINAL WHERE ${REPAIRABLE_EVENTS_SQL})) AS deduped,
      toUInt64(
        (SELECT count() FROM events_raw WHERE ${REPAIRABLE_EVENTS_SQL})
        - (SELECT count() FROM events_raw FINAL WHERE ${REPAIRABLE_EVENTS_SQL})
      ) AS pending_collapse,
      toUInt64((SELECT uniqExact(timestamp) FROM events_raw FINAL WHERE ${REPAIRABLE_EVENTS_SQL})) AS distinct_instants
  `);
  return rows[0]!;
}

/**
 * Evidence for the diagnosis, before anything is changed.
 *
 * If the export-interval theory is right, live metric rows share far fewer
 * distinct timestamps than there are requests. If `instants` is close to
 * `requests`, the theory is WRONG and this repair should not be run — stop and
 * work out what actually happened instead.
 */
export async function diagnose(): Promise<{
  metric_rows: number;
  metric_instants: number;
  request_rows: number;
  request_instants: number;
}> {
  const rows = await query<{
    metric_rows: number;
    metric_instants: number;
    request_rows: number;
    request_instants: number;
  }>(`
    SELECT
      toUInt64((SELECT count() FROM metrics_raw FINAL
                WHERE provenance = 'live' AND metric_name = 'claude_code.token.usage')) AS metric_rows,
      toUInt64((SELECT uniqExact(timestamp) FROM metrics_raw FINAL
                WHERE provenance = 'live' AND metric_name = 'claude_code.token.usage')) AS metric_instants,
      toUInt64((SELECT count() FROM events_raw FINAL WHERE ${REPAIRABLE_EVENTS_SQL})) AS request_rows,
      toUInt64((SELECT uniqExact(timestamp) FROM events_raw FINAL WHERE ${REPAIRABLE_EVENTS_SQL})) AS request_instants
  `);
  return rows[0]!;
}

// ═══════════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════════

const WARNING = [
  '',
  '╔═══════════════════════════════════════════════════════════════════════════╗',
  '║  RUN THIS ONLY AFTER THE STEP-4 EXCHANGE.                                 ║',
  '║                                                                           ║',
  "║  The old sorting key is what collapsed these rows in the first place, so  ║",
  '║  rows inserted before the exchange are collapsed again on the next merge  ║',
  '║  and the repair silently achieves nothing. Confirm both sorting keys end  ║',
  '║  in `row_id` first — step 4 of README-2026-10.md says how.                ║',
  '║                                                                           ║',
  '║  It DELETES the superseded live token/cost rows before inserting. Take    ║',
  '║  the step-0a backup first.                                                ║',
  '╚═══════════════════════════════════════════════════════════════════════════╝',
  '',
].join('\n');

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function big(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Refuse to run against a table that still has the old key. */
async function sortingKeyIsV2(): Promise<boolean> {
  const rows = await query<{ sorting_key: string }>(`
    SELECT sorting_key FROM system.tables
    WHERE database = currentDatabase() AND name = 'metrics_raw'
  `);
  return (rows[0]?.sorting_key ?? '').includes('row_id');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  if (args.includes('--help')) {
    console.log('Usage: bun <this file> [--apply]');
    return;
  }

  console.log(WARNING);

  const keyOk = await sortingKeyIsV2();
  console.log(`metrics_raw sorting key includes row_id: ${keyOk}`);
  if (!keyOk) {
    console.error(
      'REFUSING: metrics_raw still has the old sorting key. Do step 4 first, ' +
        'or this repair is collapsed away by the next merge.'
    );
    process.exit(1);
  }

  const evidence = await diagnose();
  console.log('\n── Is the diagnosis right? ───────────────────────────────────');
  console.log(`live token metric rows        : ${big(evidence.metric_rows)}`);
  console.log(`…over distinct timestamps     : ${big(evidence.metric_instants)}`);
  console.log(`api_request rows              : ${big(evidence.request_rows)}`);
  console.log(`…over distinct timestamps     : ${big(evidence.request_instants)}`);
  const perInstant = evidence.metric_instants > 0
    ? evidence.request_rows / evidence.metric_instants
    : 0;
  console.log(`requests per metric timestamp : ${perInstant.toFixed(1)}`);
  if (perInstant < 1.5) {
    console.log(
      '\n  ⚠ Close to 1:1. The export-interval explanation does NOT hold here —\n' +
        '    stop and find the real cause before changing any data.'
    );
  }

  const residual = await residualBound();
  console.log('\n── What cannot be recovered ──────────────────────────────────');
  console.log(`api_request rows, raw         : ${big(residual.raw)}`);
  console.log(`…after FINAL                  : ${big(residual.deduped)}`);
  console.log(`pending collapse (a FLOOR on  : ${big(residual.pending_collapse)}`);
  console.log(` the events already lost)      `);

  const rows = await reconcile();
  const superseded = await supersededCount();
  const totals = rows.reduce(
    (acc, row) => ({
      metric_tokens: acc.metric_tokens + Number(row.metric_tokens),
      event_tokens: acc.event_tokens + Number(row.event_tokens),
      metric_cost: acc.metric_cost + Number(row.metric_cost),
      event_cost: acc.event_cost + Number(row.event_cost),
      rows_to_write: acc.rows_to_write + Number(row.rows_to_write),
    }),
    { metric_tokens: 0, event_tokens: 0, metric_cost: 0, event_cost: 0, rows_to_write: 0 }
  );

  console.log('\n── Before and after ──────────────────────────────────────────');
  for (const row of rows) {
    console.log(
      `  ${row.scope}: tokens ${big(Number(row.metric_tokens))} → ${big(Number(row.event_tokens))}` +
        `, cost ${money(Number(row.metric_cost))} → ${money(Number(row.event_cost))}`
    );
  }
  console.log(
    `\n  ALL: tokens ${big(totals.metric_tokens)} → ${big(totals.event_tokens)}` +
      ` (${totals.metric_tokens > 0 ? `${(totals.event_tokens / totals.metric_tokens).toFixed(2)}x` : 'n/a'})`
  );
  console.log(`  ALL: cost ${money(totals.metric_cost)} → ${money(totals.event_cost)}`);
  console.log(`  rows to delete: ${big(superseded)}`);
  console.log(`  rows to write : ${big(totals.rows_to_write)}`);

  if (totals.event_tokens < totals.metric_tokens) {
    console.log(
      '\n  ⚠ The events hold FEWER tokens than the metrics. This repair would ' +
        'LOSE data.\n    Do not apply it; work out why first.'
    );
    if (apply) process.exit(1);
  }

  if (!apply) {
    console.log('\nDry run. Nothing was changed. Re-run with --apply.');
    return;
  }

  console.log('\nDeleting the superseded live rows…');
  // The statement waits for its own mutation — see DELETE_SUPERSEDED_SQL. The
  // delete and the insert are not atomic together, so the order matters: this
  // way a crash between them leaves the tokens briefly MISSING, which is
  // visible and fixed by re-running, rather than DOUBLED, which is silent.
  await query(DELETE_SUPERSEDED_SQL);
  console.log('Inserting the derived rows…');
  await query(DERIVE_INSERT_SQL);

  const after = await reconcile();
  const afterTokens = after.reduce((sum, row) => sum + Number(row.metric_tokens), 0);
  console.log(`\nDone. Live token total now reads: ${big(afterTokens)}`);
  console.log('Expected it to match the `event_tokens` column above.');
}

if (import.meta.main) {
  await main();
}
