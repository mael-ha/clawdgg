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
 * cannot separate them either. HOW MUCH it happened is NOT KNOWABLE: a
 * collapsed row leaves no trace of what it absorbed, and no query run after the
 * fact can count rows that no longer exist. So the repaired figure is "at
 * least", and nothing in this script claims to bound the gap — see
 * collisionEvidence(), which measures collisions that are still VISIBLE and is
 * labelled as exactly that.
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
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CUTOVER, AND WHY IT IS MANDATORY
 *
 * `--before <cutover>` is the step-4 EXCHANGE instant, recorded in the runbook
 * next to $WATERMARK. The script REFUSES to run without it, because every
 * safety property here depends on it:
 *
 *   - Rows at or after the cutover were written through the NEW sorting key.
 *     They are exact, they are not collapsed, and deriving them again from the
 *     events would DOUBLE them. They must never be deleted and never be
 *     rebuilt, so both the DELETE and the derive are bounded `timestamp <
 *     cutover`.
 *   - It is what makes a re-run safe in a way the row identity alone cannot:
 *     the live ingest never stops, so without a fixed upper bound a second run
 *     an hour later would sweep an hour of exact rows into the repair.
 *
 * Pass the SAME cutover on every run. A later one would supersede exact rows;
 * an earlier one leaves a band of collapsed rows unrepaired (harmless, visible,
 * and fixed by re-running with the right one).
 *
 * WHAT IS SUPERSEDED, AND WHAT IS NOT
 * The unit is a (user, UTC day) pair, and a pair is superseded only when the
 * events hold AT LEAST as many tokens AND at least as much cost as the live
 * metric rows do (both read with FINAL). A pair that fails that test keeps its
 * original rows and is printed as a loser: the repair must never take away a
 * measurement it cannot at least match.
 *
 * KNOWN BOUNDARY, stated plainly because it is not fixable from here. Metrics
 * lag their requests by up to one export interval, so a datapoint covering a
 * request at 23:59:50 can be stamped 00:00:05 the next day, and one covering a
 * request just before the cutover can be stamped just after it. Where the
 * neighbouring day or side of the cutover is NOT superseded, that lagged
 * datapoint survives while the request it describes is also rebuilt — a double
 * count bounded by one export interval of one user's traffic, at two edges:
 * the day after a user's last active day, and the cutover instant itself.
 * boundaryExposure() prints the size of the second one. Nothing prints the
 * first; it needs a day with requests followed by a day with none.
 *
 * IDEMPOTENCY
 * Each derived row's identity is hash(source event row_id, metric_name,
 * token_type) — NOT METRIC_IDENTITY_COLUMNS. That matters twice over: a second
 * run produces byte-identical row_ids that collapse under FINAL instead of
 * doubling, and two requests that shared an export interval (same timestamp,
 * same model, same empty session) keep DIFFERENT identities, because their
 * source events do. Hashing the attribute list instead would re-collapse the
 * repaired rows into exactly the one row per token type this whole step exists
 * to undo.
 *
 * ORDER OF OPERATIONS, and why it is the risky way round
 * Back up, DELETE, then INSERT. If the script dies between the last two the
 * tokens are briefly MISSING, which is visible and fixed by re-running. The
 * other order would leave them DOUBLED, which is silent. That is the same
 * choice the daily_stats import makes, for the same reason.
 *
 * ROLLBACK
 * Real, and local to this step. `--apply` first copies the exact rows the
 * DELETE will remove into `metrics_raw_pre_repair`, so the reversal is
 *
 *   ALTER TABLE metrics_raw DELETE WHERE provenance = 'repair' SETTINGS mutations_sync = 2;
 *   INSERT INTO metrics_raw SELECT * FROM metrics_raw_pre_repair FINAL;
 *
 * The step-0a backup is NOT a rollback for this step: restoring it would also
 * undo step 5's import and every live row written since.
 *
 * Usage (locally):
 *   bun docker/clickhouse/migrations/2026-10-19_repair_token_metrics.ts --before '2026-10-19 09:14:00'
 *   bun docker/clickhouse/migrations/2026-10-19_repair_token_metrics.ts --before '2026-10-19 09:14:00' --apply
 *
 * On the server, docker/ is not in the image (.dockerignore), so mount it:
 *   COMPOSE=/opt/clawdgg/docker-compose.staging.yml
 *   ssh clawdgg "cd /opt/clawdgg && docker compose -f $COMPOSE run --rm \
 *     -v ./docker:/app/docker \
 *     app bun docker/clickhouse/migrations/2026-10-19_repair_token_metrics.ts --before '…'"
 *
 * Env: CLICKHOUSE_URL / CLICKHOUSE_DATABASE, as the app uses them.
 */

import { identityHash, identitySqlExpr, query } from '../../../src/db/clickhouse';

// ═══════════════════════════════════════════════════════════════════════════
// The SQL (exported, so the tests can run it against a real clickhouse-local)
// ═══════════════════════════════════════════════════════════════════════════

/** What the repaired rows are tagged with, so every figure stays traceable. */
export const REPAIR_PROVENANCE = 'repair';

/** Where the superseded rows are parked so the step can be reversed. */
export const BACKUP_TABLE = 'metrics_raw_pre_repair';

export const TOKEN_METRIC = 'claude_code.token.usage';
export const COST_METRIC = 'claude_code.cost.usage';

/** The two metrics an api_request can rebuild, and nothing else. */
export const TOKEN_COST_METRICS_SQL =
  `metric_name IN ('${TOKEN_METRIC}', '${COST_METRIC}')`;

/**
 * The OTEL-measured rows, before and after the repair.
 *
 * Both provenances together, because the repair MOVES rows from one to the
 * other: reading 'live' alone would show the total collapsing to zero the
 * moment the repair succeeds.
 */
export const MEASURED_PROVENANCE_SQL = `provenance IN ('live', '${REPAIR_PROVENANCE}')`;

/**
 * Provenances whose token/cost rows describe the SAME history the events do.
 *
 * A (user, day) pair holding one of these AND live api_request events would be
 * counted twice by this repair: the import's reconstruction stays, and the
 * events are rebuilt on top of it. mixedProvenancePairs() finds them and the
 * script refuses them unless the operator passes --allow-mixed-days.
 */
export const RECONSTRUCTED_PROVENANCES = ['backfill', 'backfill-history', 'legacy', 'import'];

/**
 * A mandatory cutover, normalized to the literal ClickHouse parses.
 *
 * Validated to a fixed shape and nothing else, because it is interpolated into
 * every statement below: the caller is an operator on a shell, so there is no
 * query parameter to bind it to in an ALTER, and a value that cannot hold a
 * quote cannot end a string literal early.
 */
export function normalizeCutover(raw: string): string {
  const text = raw.trim().replace('T', ' ').replace(/Z$/, '');
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) {
    throw new Error(
      `--before must be 'YYYY-MM-DD HH:MM:SS[.mmm]' (UTC), got ${JSON.stringify(raw)}`
    );
  }
  const ms = (match[3] ?? '').padEnd(3, '0');
  const normalized = `${match[1]} ${match[2]}.${ms}`;
  const parsed = Date.parse(`${match[1]}T${match[2]}.${ms}Z`);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--before is not a real instant: ${JSON.stringify(raw)}`);
  }
  if (parsed < Date.parse('2025-02-01T00:00:00Z')) {
    throw new Error('--before predates Claude Code; it is the step-4 EXCHANGE instant');
  }
  if (parsed > Date.now() + 86_400_000) {
    throw new Error('--before is in the future; it is the step-4 EXCHANGE instant');
  }
  return normalized;
}

/** The cutover as the SQL comparison every statement here is bounded by. */
function beforeCutover(cutover: string): string {
  return `timestamp < toDateTime64('${cutover}', 3)`;
}

/** The events a token/cost datapoint can be rebuilt from, inside the window. */
export function repairableEventsSql(cutover: string): string {
  return `
  provenance = 'live'
  AND event_name = 'claude_code.api_request'
  AND ${beforeCutover(cutover)}
  AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0
       OR cache_write_tokens > 0 OR cost_usd > 0)`;
}

/** The live token/cost rows in the window, whatever day they fall on. */
export function liveMetricsSql(cutover: string): string {
  return `
  provenance = 'live'
  AND ${TOKEN_COST_METRICS_SQL}
  AND ${beforeCutover(cutover)}`;
}

/**
 * The (user, UTC day) pairs the repair is allowed to supersede.
 *
 * ONE definition, used by the DELETE, by the derive, and read back by the
 * runner so what it prints and what it changes cannot drift. Two conditions,
 * and both are load-bearing:
 *
 *   1. the pair HAS repairable events — a day with metrics and no events (a
 *      user who exported metrics but not logs) keeps its original rows, because
 *      the repair has nothing to offer in their place;
 *   2. the events hold at least as many tokens AND at least as much cost as the
 *      live metric rows on that pair do. A LEFT JOIN with 0 for the missing
 *      side, so a day whose metrics were lost ENTIRELY is still eligible — that
 *      is the pure-recovery case, and `>= 0` is true.
 *
 * The cost comparison carries a micro-dollar slack: both sides are Float64 sums
 * of the same per-request figures, so a pair that is genuinely equal can differ
 * in the last bits, and rejecting it over 1e-12 of a dollar would leave a day
 * collapsed for a rounding artefact.
 */
export function eligiblePairsSql(cutover: string): string {
  return `
  SELECT e.user_id AS user_id, e.day AS day
  FROM (
    SELECT
      user_id,
      toDate(timestamp) AS day,
      sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS event_tokens,
      sum(cost_usd) AS event_cost
    FROM events_raw FINAL
    WHERE ${repairableEventsSql(cutover)}
    GROUP BY user_id, day
  ) e
  LEFT JOIN (
    SELECT
      user_id,
      toDate(timestamp) AS day,
      sumIf(value, metric_name = '${TOKEN_METRIC}') AS metric_tokens,
      sumIf(value, metric_name = '${COST_METRIC}') AS metric_cost
    FROM metrics_raw FINAL
    WHERE ${liveMetricsSql(cutover)}
    GROUP BY user_id, day
  ) m ON e.user_id = m.user_id AND e.day = m.day
  WHERE e.event_tokens >= m.metric_tokens
    AND e.event_cost >= m.metric_cost - 0.000001`;
}

/** The scope shared by the DELETE, the backup copy and the derive. */
function eligibleScopeSql(cutover: string): string {
  return `(user_id, toDate(timestamp)) IN (${eligiblePairsSql(cutover)})`;
}

/**
 * The live token/cost rows the repair supersedes.
 *
 * Every clause matters: the provenance (nothing reconstructed is touched), the
 * metric names (lines of code and session counts collapsed too and have no
 * per-event twin — see the runbook's known limits), the cutover (post-exchange
 * rows are exact) and the eligible pair set.
 */
export function supersededMetricsSql(cutover: string): string {
  return `
  ${liveMetricsSql(cutover)}
  AND ${eligibleScopeSql(cutover)}`;
}

/** The columns the derive writes. Asserted against prod's own before any DELETE. */
export const DERIVE_COLUMNS = [
  'timestamp', 'user_id', 'session_id', 'metric_name', 'value',
  'model', 'token_type', 'line_type', 'time_type',
  'tool', 'decision', 'language', 'source',
  'query_source', 'speed', 'effort', 'agent_name', 'skill_name', 'plugin_name',
  'marketplace_name', 'mcp_server_name', 'mcp_tool_name', 'start_type',
  'terminal_type', 'app_version', 'account_uuid', 'organization_id',
  'provenance', 'pricing_source', 'row_id',
] as const;

/**
 * The identity of a repaired row, computed the same way on both sides.
 *
 * `src_row_id` is the api_request event's own row_id, which already separates
 * two requests that share a millisecond. Hanging the metric name and token type
 * off it gives every derived datapoint a distinct identity without inventing
 * one — and makes a re-run a no-op rather than a doubling.
 */
const REPAIRED_ROW_ID_PARTS = ['src_row_id', 'metric_name', 'token_type'] as const;

export function repairedMetricRowId(
  sourceEventRowId: string,
  metricName: string,
  tokenType: string
): string {
  return identityHash([sourceEventRowId, metricName, tokenType]);
}

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
 *
 * Bounded by the SAME pair set as the DELETE. That is not tidiness: deriving a
 * pair whose live rows were kept would add the events on top of them.
 */
export function deriveSelectSql(cutover: string): string {
  return `
SELECT
  timestamp, user_id, session_id, metric_name, value,
  model, token_type, line_type, time_type,
  tool, decision, language, source,
  query_source, speed, effort, agent_name, skill_name, plugin_name,
  marketplace_name, mcp_server_name, mcp_tool_name, start_type,
  terminal_type, app_version, account_uuid, organization_id,
  provenance, pricing_source,
  ${identitySqlExpr(REPAIRED_ROW_ID_PARTS)} AS row_id
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
    '' AS pricing_source,
    src_row_id
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
      terminal_type, app_version, account_uuid, organization_id,
      row_id AS src_row_id
    FROM events_raw FINAL
    WHERE ${repairableEventsSql(cutover)}
      AND ${eligibleScopeSql(cutover)}
  )
  ARRAY JOIN arrayFilter(
    x -> x.2 > 0,
    [
      ('${TOKEN_METRIC}', toFloat64(input_tokens), 'input'),
      ('${TOKEN_METRIC}', toFloat64(output_tokens), 'output'),
      ('${TOKEN_METRIC}', toFloat64(cache_read_tokens), 'cacheRead'),
      ('${TOKEN_METRIC}', toFloat64(cache_write_tokens), 'cacheCreation'),
      ('${COST_METRIC}', toFloat64(cost_usd), '')
    ]
  ) AS part
)`;
}

export function deriveInsertSql(cutover: string): string {
  return `INSERT INTO metrics_raw (\n  ${DERIVE_COLUMNS.join(', ')}\n)\n${deriveSelectSql(cutover)}`;
}

/**
 * `mutations_sync = 2` is part of the statement, not a caller's choice.
 *
 * ALTER ... DELETE is a MUTATION: ClickHouse accepts it and applies it in the
 * background, so without this the next statement — the insert — can run against
 * rows that are still there, and the totals land wherever the race lands. The
 * first version of the test for this was green only by timing.
 */
export function deleteSupersededSql(cutover: string): string {
  return `
ALTER TABLE metrics_raw
DELETE WHERE ${supersededMetricsSql(cutover)}
SETTINGS mutations_sync = 2`;
}

/**
 * The rollback store, created with metrics_raw's exact shape.
 *
 * `AS metrics_raw` and not a hand-written DDL: `INSERT ... SELECT *` is only
 * correct while the two column lists match in order as well as in name, and
 * this is the one form that cannot drift from prod's actual table.
 */
export const CREATE_BACKUP_SQL =
  `CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} AS metrics_raw`;

/** Exactly the rows the DELETE will remove, read with FINAL as it sees them. */
export function backupSupersededSql(cutover: string): string {
  return `
INSERT INTO ${BACKUP_TABLE}
SELECT * FROM metrics_raw FINAL
WHERE ${supersededMetricsSql(cutover)}`;
}

export const ROLLBACK_SQL = [
  `ALTER TABLE metrics_raw DELETE WHERE provenance = '${REPAIR_PROVENANCE}' SETTINGS mutations_sync = 2;`,
  `INSERT INTO metrics_raw SELECT * FROM ${BACKUP_TABLE} FINAL;`,
].join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// Reading the current state
// ═══════════════════════════════════════════════════════════════════════════

/** A statement that is supposed to take minutes, not the default 10 seconds. */
const MUTATION_TIMEOUT_MS = 30 * 60 * 1000;

export interface PairKey {
  user_id: string;
  day: string;
}

export interface EventDay extends PairKey {
  event_tokens: number;
  event_cost: number;
  rows_to_write: number;
}

export interface MetricDay extends PairKey {
  provenance: string;
  tokens: number;
  cost: number;
}

const pairKey = (pair: PairKey) => `${pair.user_id}\u001f${pair.day}`;

/** The pair set the statements will act on, read back from the same SQL. */
export async function eligiblePairs(cutover: string): Promise<PairKey[]> {
  return query<PairKey>(`
    SELECT user_id, toString(day) AS day
    FROM (${eligiblePairsSql(cutover)})
    ORDER BY user_id, day
  `);
}

/** What the events say, per (user, day), inside the window. */
export async function eventDays(cutover: string): Promise<EventDay[]> {
  return query<EventDay>(`
    SELECT
      user_id,
      toString(toDate(timestamp)) AS day,
      toFloat64(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)) AS event_tokens,
      toFloat64(sum(cost_usd)) AS event_cost,
      toUInt64(sum(
        (input_tokens > 0) + (output_tokens > 0) + (cache_read_tokens > 0)
        + (cache_write_tokens > 0) + (cost_usd > 0)
      )) AS rows_to_write
    FROM events_raw FINAL
    WHERE ${repairableEventsSql(cutover)}
    GROUP BY user_id, day
  `);
}

/** What the metric rows say, per (user, day, provenance), inside the window. */
export async function metricDays(cutover: string): Promise<MetricDay[]> {
  return query<MetricDay>(`
    SELECT
      user_id,
      toString(toDate(timestamp)) AS day,
      provenance,
      toFloat64(sumIf(value, metric_name = '${TOKEN_METRIC}')) AS tokens,
      toFloat64(sumIf(value, metric_name = '${COST_METRIC}')) AS cost
    FROM metrics_raw FINAL
    WHERE ${TOKEN_COST_METRICS_SQL}
      AND ${beforeCutover(cutover)}
    GROUP BY user_id, day, provenance
  `);
}

/** Exactly how many rows the DELETE will remove. Its own query, to stay legible. */
export async function supersededCount(cutover: string): Promise<number> {
  const rows = await query<{ n: number }>(`
    SELECT toUInt64(count()) AS n
    FROM metrics_raw FINAL
    WHERE ${supersededMetricsSql(cutover)}
  `);
  return Number(rows[0]?.n) || 0;
}

export interface Reconciliation {
  scope: string;
  /** Live + repair token/cost as the site reads them TODAY, inside the window. */
  metric_tokens: number;
  metric_cost: number;
  /** Everything the repairable events hold, eligible or not. */
  event_tokens: number;
  event_cost: number;
  /** What `metric_tokens` must read after the repair, to the row. */
  expected_tokens: number;
  expected_cost: number;
  rows_superseded: number;
  rows_to_write: number;
  /** (user, day) pairs with events whose metrics are NOT superseded. */
  losers: { day: string; event_tokens: number; metric_tokens: number; metric_cost: number; event_cost: number }[];
}

/**
 * Per USER over the whole cutover window, never per day.
 *
 * A repaired row moves from the export timestamp to the request timestamp, so a
 * datapoint exported at 00:00:05 lands on the previous day once it is rebuilt.
 * Per-day totals therefore shift across midnight for legitimate reasons and a
 * per-day equality check would fail on correct data. Per user over the whole
 * window is the coarsest scope that still localises a problem to one account,
 * and it is invariant under that shift.
 *
 * `expected_*` is the arithmetic the after-check needs: the events on the pairs
 * that WILL be superseded, plus the live rows on the pairs that will not, plus
 * every repair row already present from an earlier run.
 */
export function reconcileFrom(
  events: EventDay[],
  metrics: MetricDay[],
  eligible: PairKey[]
): Reconciliation[] {
  const eligibleKeys = new Set(eligible.map(pairKey));
  const users = new Set<string>([
    ...events.map((row) => row.user_id),
    ...metrics.map((row) => row.user_id),
  ]);

  const eventByPair = new Map(events.map((row) => [pairKey(row), row]));

  const out: Reconciliation[] = [];
  for (const user of [...users].sort()) {
    const acc: Reconciliation = {
      scope: user,
      metric_tokens: 0,
      metric_cost: 0,
      event_tokens: 0,
      event_cost: 0,
      expected_tokens: 0,
      expected_cost: 0,
      rows_superseded: 0,
      rows_to_write: 0,
      losers: [],
    };

    for (const row of events) {
      if (row.user_id !== user) continue;
      acc.event_tokens += Number(row.event_tokens);
      acc.event_cost += Number(row.event_cost);
      if (eligibleKeys.has(pairKey(row))) {
        acc.expected_tokens += Number(row.event_tokens);
        acc.expected_cost += Number(row.event_cost);
        acc.rows_to_write += Number(row.rows_to_write);
      }
    }

    for (const row of metrics) {
      if (row.user_id !== user) continue;
      const measured = row.provenance === 'live' || row.provenance === REPAIR_PROVENANCE;
      if (measured) {
        acc.metric_tokens += Number(row.tokens);
        acc.metric_cost += Number(row.cost);
      }
      // Live rows on a pair the repair will not touch stay exactly as they are.
      if (row.provenance === 'live' && !eligibleKeys.has(pairKey(row))) {
        acc.expected_tokens += Number(row.tokens);
        acc.expected_cost += Number(row.cost);
        const event = eventByPair.get(pairKey(row));
        if (event) {
          acc.losers.push({
            day: row.day,
            event_tokens: Number(event.event_tokens),
            event_cost: Number(event.event_cost),
            metric_tokens: Number(row.tokens),
            metric_cost: Number(row.cost),
          });
        }
      }
      // Repair rows already written by an earlier run are part of the target.
      if (row.provenance === REPAIR_PROVENANCE && !eligibleKeys.has(pairKey(row))) {
        acc.expected_tokens += Number(row.tokens);
        acc.expected_cost += Number(row.cost);
      }
    }

    acc.losers.sort((a, b) => a.day.localeCompare(b.day));
    out.push(acc);
  }

  return out.sort((a, b) => b.event_tokens - a.event_tokens);
}

/**
 * (user, day) pairs that hold BOTH live api_request events and reconstructed
 * token/cost rows.
 *
 * The DELETE only ever removes `provenance = 'live'` rows, so on such a pair the
 * import's reconstruction would SURVIVE the repair and the same history would be
 * counted twice. There is no safe automatic answer — whether the import or the
 * events describe that day better is a judgement about how the day was
 * recorded — so the script prints them and refuses unless told otherwise.
 */
export async function mixedProvenancePairs(cutover: string): Promise<
  { user_id: string; day: string; provenances: string; tokens: number }[]
> {
  return query(`
    SELECT
      m.user_id AS user_id,
      toString(m.day) AS day,
      arrayStringConcat(arraySort(m.provenances), ',') AS provenances,
      toFloat64(m.tokens) AS tokens
    FROM (
      SELECT
        user_id,
        toDate(timestamp) AS day,
        groupUniqArray(provenance) AS provenances,
        sumIf(value, metric_name = '${TOKEN_METRIC}') AS tokens
      FROM metrics_raw FINAL
      WHERE ${TOKEN_COST_METRICS_SQL}
        AND ${beforeCutover(cutover)}
        AND provenance IN (${RECONSTRUCTED_PROVENANCES.map((p) => `'${p}'`).join(', ')})
      GROUP BY user_id, day
    ) m
    INNER JOIN (
      SELECT DISTINCT user_id, toDate(timestamp) AS day
      FROM events_raw FINAL
      WHERE ${repairableEventsSql(cutover)}
    ) e ON m.user_id = e.user_id AND m.day = e.day
    ORDER BY tokens DESC
  `);
}

/**
 * Collisions that are still VISIBLE in events_raw. NOT a bound on the loss.
 *
 * `pending_collapse` is the gap between a raw count and a FINAL count: rows
 * that are still on disk and WILL be merged away. It says collisions keep
 * happening; it says nothing about how many already happened, because a
 * collapsed row leaves no trace of what it absorbed. `sharing_an_instant`
 * counts surviving api_request rows that share their millisecond with another
 * surviving one — same story, from the other side.
 *
 * The residual loss inside events_raw is UNKNOWABLE after the fact. Publish the
 * repaired totals as "at least", and do not dress either of these numbers up as
 * a floor on it.
 */
export async function collisionEvidence(cutover: string): Promise<{
  raw: number;
  deduped: number;
  pending_collapse: number;
  distinct_instants: number;
  sharing_an_instant: number;
}> {
  const scope = repairableEventsSql(cutover);
  const rows = await query<{
    raw: number;
    deduped: number;
    pending_collapse: number;
    distinct_instants: number;
    sharing_an_instant: number;
  }>(`
    SELECT
      toUInt64((SELECT count() FROM events_raw WHERE ${scope})) AS raw,
      toUInt64((SELECT count() FROM events_raw FINAL WHERE ${scope})) AS deduped,
      toUInt64(
        (SELECT count() FROM events_raw WHERE ${scope})
        - (SELECT count() FROM events_raw FINAL WHERE ${scope})
      ) AS pending_collapse,
      toUInt64((SELECT uniqExact(timestamp) FROM events_raw FINAL WHERE ${scope})) AS distinct_instants,
      toUInt64(
        (SELECT count() FROM events_raw FINAL WHERE ${scope})
        - (SELECT uniqExact(timestamp) FROM events_raw FINAL WHERE ${scope})
      ) AS sharing_an_instant
  `);
  return rows[0]!;
}

/**
 * The cutover-edge exposure, computed on events_raw and labelled as what it is.
 *
 * A metric datapoint stamped just after the cutover can describe a request made
 * just before it. Those datapoints are NOT superseded (they are past the
 * cutover) while the requests they describe ARE rebuilt, so their tokens can be
 * counted twice. This is the size of that window's traffic — an UPPER bound on
 * the overlap, not a measurement of it.
 */
export async function boundaryExposure(cutover: string): Promise<{
  tokens: number;
  cost: number;
  requests: number;
}> {
  const rows = await query<{ tokens: number; cost: number; requests: number }>(`
    SELECT
      toFloat64(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)) AS tokens,
      toFloat64(sum(cost_usd)) AS cost,
      toUInt64(count()) AS requests
    FROM events_raw FINAL
    WHERE ${repairableEventsSql(cutover)}
      AND timestamp >= toDateTime64('${cutover}', 3) - INTERVAL 2 MINUTE
  `);
  return rows[0] ?? { tokens: 0, cost: 0, requests: 0 };
}

/**
 * Evidence for the diagnosis, before anything is changed.
 *
 * If the export-interval theory is right, live metric rows share far fewer
 * distinct timestamps than there are requests. If `instants` is close to
 * `requests`, the theory is WRONG and this repair should not be run — stop and
 * work out what actually happened instead.
 */
export async function diagnose(cutover: string): Promise<{
  metric_rows: number;
  metric_instants: number;
  request_rows: number;
  request_instants: number;
}> {
  const live = `provenance = 'live' AND metric_name = '${TOKEN_METRIC}' AND ${beforeCutover(cutover)}`;
  const events = repairableEventsSql(cutover);
  const rows = await query<{
    metric_rows: number;
    metric_instants: number;
    request_rows: number;
    request_instants: number;
  }>(`
    SELECT
      toUInt64((SELECT count() FROM metrics_raw FINAL WHERE ${live})) AS metric_rows,
      toUInt64((SELECT uniqExact(timestamp) FROM metrics_raw FINAL WHERE ${live})) AS metric_instants,
      toUInt64((SELECT count() FROM events_raw FINAL WHERE ${events})) AS request_rows,
      toUInt64((SELECT uniqExact(timestamp) FROM events_raw FINAL WHERE ${events})) AS request_instants
  `);
  return rows[0]!;
}

// ═══════════════════════════════════════════════════════════════════════════
// Preflight — everything that must hold BEFORE a single row is deleted
// ═══════════════════════════════════════════════════════════════════════════

export interface Preflight {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  rowsToInsert: number;
}

/**
 * Prove the INSERT will succeed before the DELETE makes it compulsory.
 *
 * The order of operations here is the whole point. DELETE-then-INSERT is chosen
 * because a crash between them is visible rather than silent, but that only
 * holds if the INSERT is going to work: if it fails on a column prod does not
 * have, the tokens are gone until someone restores the backup. So the derive's
 * SELECT is RUN (counted) and the target's column list is read off
 * system.columns first. Both sorting keys are checked too — the repair is
 * pointless on the old metrics key and the derived identities are wrong without
 * row_id in events_raw's.
 */
export async function preflight(cutover: string): Promise<Preflight> {
  const checks: Preflight['checks'] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const keys = await query<{ name: string; sorting_key: string }>(`
    SELECT name, sorting_key FROM system.tables
    WHERE database = currentDatabase() AND name IN ('metrics_raw', 'events_raw')
  `);
  for (const table of ['metrics_raw', 'events_raw'] as const) {
    const key = keys.find((row) => row.name === table)?.sorting_key ?? '';
    add(
      `${table} sorting key ends in row_id`,
      /row_id\s*\)?\s*$/.test(key.trim()),
      key || '(table not found)'
    );
  }

  const columns = await query<{ name: string }>(`
    SELECT name FROM system.columns
    WHERE database = currentDatabase() AND table = 'metrics_raw'
  `);
  const present = new Set(columns.map((row) => row.name));
  const missing = DERIVE_COLUMNS.filter((column) => !present.has(column));
  add(
    'metrics_raw has every column the derive writes',
    missing.length === 0,
    missing.length === 0 ? `${DERIVE_COLUMNS.length} columns` : `missing: ${missing.join(', ')}`
  );

  const blankIds = await query<{ n: number }>(`
    SELECT toUInt64(count()) AS n FROM events_raw FINAL
    WHERE ${repairableEventsSql(cutover)} AND row_id = ''
  `);
  const blank = Number(blankIds[0]?.n) || 0;
  add(
    'every source event carries a row_id',
    blank === 0,
    blank === 0 ? 'none empty' : `${blank} rows with row_id = '' — their derived rows would collapse together`
  );

  // The derive's own SELECT, executed. An EXPLAIN would only prove it parses.
  let rowsToInsert = 0;
  try {
    const counted = await query<{ n: number }>(
      `SELECT toUInt64(count()) AS n FROM (${deriveSelectSql(cutover)})`,
      undefined,
      { timeoutMs: MUTATION_TIMEOUT_MS }
    );
    rowsToInsert = Number(counted[0]?.n) || 0;
    add('the derive SELECT runs on this schema', true, `${rowsToInsert.toLocaleString('en-US')} rows`);
  } catch (error) {
    add('the derive SELECT runs on this schema', false, String(error));
  }

  return { ok: checks.every((check) => check.ok), checks, rowsToInsert };
}

// ═══════════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════════

const WARNING = [
  '',
  '╔═══════════════════════════════════════════════════════════════════════════╗',
  '║  RUN THIS ONLY AFTER THE STEP-4 EXCHANGE.                                 ║',
  '║                                                                           ║',
  '║  The old sorting key is what collapsed these rows in the first place, so  ║',
  '║  rows inserted before the exchange are collapsed again on the next merge  ║',
  '║  and the repair silently achieves nothing. Both sorting keys must end in  ║',
  '║  `row_id` — the preflight below checks it.                                ║',
  '║                                                                           ║',
  '║  --before is the EXCHANGE INSTANT, recorded in the runbook beside the     ║',
  '║  step-3 watermark. Pass the same one on every run.                        ║',
  '╚═══════════════════════════════════════════════════════════════════════════╝',
  '',
].join('\n');

const USAGE = `Usage: bun <this file> --before 'YYYY-MM-DD HH:MM:SS' [--apply] [--allow-mixed-days]

  --before            REQUIRED. The step-4 EXCHANGE instant, in UTC. Rows at or
                      after it were written through the new sorting key: they are
                      exact and are never touched.
  --apply             Back up, delete and insert. Without it, nothing changes.
  --allow-mixed-days  Repair (user, day) pairs that also hold backfill/legacy/
                      import token metrics. Those days end up counting the same
                      history twice; only pass this having looked at the list.`;

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function big(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const apply = args.includes('--apply');
  const allowMixed = args.includes('--allow-mixed-days');

  const beforeIndex = args.indexOf('--before');
  const beforeRaw = beforeIndex >= 0 ? args[beforeIndex + 1] : undefined;
  if (!beforeRaw) {
    console.error('REFUSING: --before is required.\n');
    console.error(USAGE);
    process.exit(1);
  }

  let cutover: string;
  try {
    cutover = normalizeCutover(beforeRaw);
  } catch (error) {
    console.error(`REFUSING: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(WARNING);
  console.log(`cutover (--before): ${cutover} UTC`);

  console.log('\n── Preflight ─────────────────────────────────────────────────');
  const checked = await preflight(cutover);
  for (const check of checked.checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}: ${check.detail}`);
  }
  if (!checked.ok) {
    console.error('\nREFUSING: a preflight check failed. Nothing was changed.');
    process.exit(1);
  }

  const evidence = await diagnose(cutover);
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

  const collisions = await collisionEvidence(cutover);
  console.log('\n── Collisions still visible in events_raw ────────────────────');
  console.log(`api_request rows, raw         : ${big(collisions.raw)}`);
  console.log(`…after FINAL                  : ${big(collisions.deduped)}`);
  console.log(`still awaiting their merge    : ${big(collisions.pending_collapse)}`);
  console.log(`surviving rows sharing an ms  : ${big(collisions.sharing_an_instant)}`);
  console.log(
    '  Neither figure bounds what was already lost: a collapsed row leaves no\n' +
      '  trace of what it absorbed. The residual inside events_raw is unknowable,\n' +
      '  so publish the repaired totals as "at least".'
  );

  const mixed = await mixedProvenancePairs(cutover);
  if (mixed.length > 0) {
    console.log('\n── (user, day) pairs with BOTH events and reconstructed metrics ──');
    for (const pair of mixed.slice(0, 50)) {
      console.log(
        `  ${pair.user_id}  ${pair.day}  ${pair.provenances}  ${big(Number(pair.tokens))} tokens`
      );
    }
    if (mixed.length > 50) console.log(`  … and ${mixed.length - 50} more`);
    console.log(
      '  Repairing these counts the same history twice: the DELETE only removes\n' +
        "  'live' rows, so the reconstruction survives alongside the rebuilt events."
    );
    if (!allowMixed) {
      console.error(
        '\nREFUSING: pass --allow-mixed-days to repair them anyway, having looked.'
      );
      process.exit(1);
    }
    console.log('  --allow-mixed-days given: continuing.');
  }

  const [events, metrics, eligible, superseded, boundary] = await Promise.all([
    eventDays(cutover),
    metricDays(cutover),
    eligiblePairs(cutover),
    supersededCount(cutover),
    boundaryExposure(cutover),
  ]);
  const rows = reconcileFrom(events, metrics, eligible);

  const totals = rows.reduce(
    (acc, row) => ({
      metric_tokens: acc.metric_tokens + row.metric_tokens,
      event_tokens: acc.event_tokens + row.event_tokens,
      metric_cost: acc.metric_cost + row.metric_cost,
      event_cost: acc.event_cost + row.event_cost,
      expected_tokens: acc.expected_tokens + row.expected_tokens,
      expected_cost: acc.expected_cost + row.expected_cost,
      rows_to_write: acc.rows_to_write + row.rows_to_write,
    }),
    {
      metric_tokens: 0, event_tokens: 0, metric_cost: 0, event_cost: 0,
      expected_tokens: 0, expected_cost: 0, rows_to_write: 0,
    }
  );

  console.log('\n── Before and after, per user ────────────────────────────────');
  for (const row of rows) {
    console.log(
      `  ${row.scope}: tokens ${big(row.metric_tokens)} → ${big(row.expected_tokens)}` +
        `, cost ${money(row.metric_cost)} → ${money(row.expected_cost)}`
    );
    for (const loser of row.losers) {
      console.log(
        `      NOT superseded ${loser.day}: events ${big(loser.event_tokens)} tok / ` +
          `${money(loser.event_cost)} < metrics ${big(loser.metric_tokens)} tok / ` +
          `${money(loser.metric_cost)} — original rows kept`
      );
    }
  }
  console.log(
    `\n  ALL: tokens ${big(totals.metric_tokens)} → ${big(totals.expected_tokens)}` +
      ` (${totals.metric_tokens > 0 ? `${(totals.expected_tokens / totals.metric_tokens).toFixed(2)}x` : 'n/a'})`
  );
  console.log(`  ALL: cost ${money(totals.metric_cost)} → ${money(totals.expected_cost)}`);
  console.log(`  events in window (all pairs) : ${big(totals.event_tokens)} tokens, ${money(totals.event_cost)}`);
  console.log(`  eligible (user, day) pairs   : ${eligible.length}`);
  console.log(`  rows to delete               : ${big(superseded)}`);
  console.log(`  rows to write                : ${big(totals.rows_to_write)} (derive counted ${big(checked.rowsToInsert)})`);

  console.log('\n── Cutover-edge exposure ─────────────────────────────────────');
  console.log(
    `  requests in the 2 minutes before the cutover: ${big(boundary.requests)}` +
      `, ${big(boundary.tokens)} tokens, ${money(boundary.cost)}`
  );
  console.log(
    '  Their metric datapoints may have been exported just AFTER the cutover,\n' +
      '  where they are not superseded — an UPPER bound on tokens that could be\n' +
      '  counted twice at that edge. Same thing happens at the midnight after a\n' +
      "  user's last active day. Neither is repairable from here."
  );

  if (totals.expected_tokens < totals.metric_tokens) {
    console.log(
      '\n  ⚠ The repair would LOWER the total. The per-pair guard should make that\n' +
        '    impossible, so this means something is wrong. Do not apply it.'
    );
    if (apply) process.exit(1);
  }

  if (!apply) {
    console.log('\nDry run. Nothing was changed. Re-run with --apply.');
    return;
  }

  console.log(`\nCopying the ${big(superseded)} superseded rows into ${BACKUP_TABLE}…`);
  await query(CREATE_BACKUP_SQL);
  await query(backupSupersededSql(cutover), undefined, { timeoutMs: MUTATION_TIMEOUT_MS });
  const backedUp = await query<{ n: number }>(
    `SELECT toUInt64(count()) AS n FROM ${BACKUP_TABLE} FINAL`
  );
  console.log(`  ${BACKUP_TABLE} now holds ${big(Number(backedUp[0]?.n) || 0)} rows.`);
  console.log('  Rollback, if it comes to that:');
  console.log(ROLLBACK_SQL.split('\n').map((line) => `    ${line}`).join('\n'));

  console.log('\nDeleting the superseded live rows…');
  // The statement waits for its own mutation — see deleteSupersededSql(). The
  // delete and the insert are not atomic together, so the order matters: this
  // way a crash between them leaves the tokens briefly MISSING, which is
  // visible and fixed by re-running, rather than DOUBLED, which is silent.
  await query(deleteSupersededSql(cutover), undefined, { timeoutMs: MUTATION_TIMEOUT_MS });
  console.log('Inserting the derived rows…');
  await query(deriveInsertSql(cutover), undefined, { timeoutMs: MUTATION_TIMEOUT_MS });

  const after = reconcileFrom(
    events,
    await metricDays(cutover),
    eligible
  );
  console.log('\n── After ─────────────────────────────────────────────────────');
  let drift = 0;
  for (const row of after) {
    const target = rows.find((before) => before.scope === row.scope)?.expected_tokens ?? 0;
    const off = row.metric_tokens - target;
    if (Math.abs(off) > 1) {
      drift++;
      console.log(`  ✗ ${row.scope}: reads ${big(row.metric_tokens)}, expected ${big(target)}`);
    } else {
      console.log(`  ok ${row.scope}: ${big(row.metric_tokens)} tokens, ${money(row.metric_cost)}`);
    }
  }
  if (drift > 0) {
    console.error(
      `\n${drift} user(s) do not read what they should. The rollback above puts the\n` +
        'original rows back; work out why before re-running.'
    );
    process.exit(1);
  }
  console.log('\nDone. Every user reads the expected total.');
}

if (import.meta.main) {
  await main();
}
