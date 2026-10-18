/**
 * The repair, run against a real ClickHouse on the real DDL.
 *
 * WHY THIS CANNOT BE REASONED ABOUT
 * The repair is one INSERT ... SELECT with an ARRAY JOIN over a tuple array, a
 * SQL-computed identity hash, and a DELETE scoped by a tuple IN subquery over a
 * LEFT JOIN. Every one of those is a property of ClickHouse's implementation
 * rather than of our code, and the whole point of the step is to change what the
 * site's dollar figures say. So this reproduces the prod failure — several token
 * datapoints sharing one export timestamp, collapsing under the OLD sorting key
 * — and asserts the repair restores the figure the api_request events hold.
 *
 * The cases that are NOT about the happy path are the reason the file is this
 * long: a day the cutover falls in the middle of, rows arriving while the
 * mutation runs, a second run, and a (user, day) pair whose metrics the events
 * cannot match. Each of those is a way to double-count or to lose a
 * measurement, which is the one failure mode a data repair may not have.
 *
 * HOW TO RUN
 *   curl https://clickhouse.com/ | sh          # ~182 MiB, drops ./clickhouse
 *   CLICKHOUSE_BIN=./clickhouse bun test docker/clickhouse/migrations
 * Without the binary the ClickHouse-backed suite SKIPS rather than passing
 * vacuously. The pure-TypeScript suite at the bottom always runs.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKUP_TABLE,
  CREATE_BACKUP_SQL,
  COST_METRIC,
  DERIVE_COLUMNS,
  MEASURED_PROVENANCE_SQL,
  REPAIR_PROVENANCE,
  TOKEN_METRIC,
  backupSupersededSql,
  deleteSupersededSql,
  deriveInsertSql,
  eligiblePairsSql,
  normalizeCutover,
  reconcileFrom,
  repairableEventsSql,
  repairedMetricRowId,
  supersededMetricsSql,
  type EventDay,
  type MetricDay,
} from './2026-10-19_repair_token_metrics';

function findClickHouse(): string | null {
  for (const candidate of [process.env.CLICKHOUSE_BIN, './clickhouse', 'clickhouse']) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ['local', '--query', 'SELECT 1'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

const CLICKHOUSE = findClickHouse();

/** The real DDL, minus the TTL (which would drop the fixture's own rows). */
function schemaSql(): string {
  const raw = readFileSync(join(import.meta.dir, '../init/01_schema.sql'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/CREATE DATABASE[^;]*;/g, '')
    .replace(/USE clawd;/g, '')
    .replace(/TTL toDateTime\(timestamp\) \+ INTERVAL \d+ DAY/g, '');
}

/**
 * Join a script out of steps. The exported SQL deliberately carries no trailing
 * semicolon — the app's `query()` sends one statement per request — so the
 * separator belongs here, where several are run in one file.
 */
function script(...steps: string[]): string {
  return steps.map((step) => step.trim().replace(/;$/, '')).join(';\n') + ';';
}

function chLocal(sql: string): string {
  return execFileSync(CLICKHOUSE!, ['local', '--multiquery', '--queries-file', '/dev/stdin'], {
    input: `${sql}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC' },
  }).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// The fixture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The step-4 exchange instant. It falls in the MIDDLE of 2026-10-01, which is
 * the point: that day is half collapsed (written through the old key) and half
 * exact (written through the new one), and the repair has to rebuild one half
 * without touching the other.
 */
const CUTOVER = '2026-10-01 12:00:00.000';

interface Request {
  ts: string;
  model: string;
  input: number;
  output: number;
  read: number;
  write: number;
  cost: number;
}

/** u1's three requests inside ONE export interval, before the cutover. */
const PRE: Request[] = [
  { ts: '2026-10-01 09:00:00.100', model: 'claude-opus-5-5', input: 1000, output: 200, read: 50_000, write: 4000, cost: 1.5 },
  { ts: '2026-10-01 09:00:03.250', model: 'claude-sonnet-5-5', input: 500, output: 100, read: 20_000, write: 0, cost: 0.4 },
  { ts: '2026-10-01 09:00:07.900', model: 'claude-opus-5-5', input: 800, output: 150, read: 30_000, write: 1000, cost: 0.9 },
];

/** u1's request AFTER the cutover. Its metrics are already exact. */
const POST: Request = {
  ts: '2026-10-01 13:00:00.000', model: 'claude-opus-5-5',
  input: 700, output: 100, read: 10_000, write: 500, cost: 0.6,
};

const sumTokens = (r: Request) => r.input + r.output + r.read + r.write;

const PRE_TOKENS = PRE.reduce((n, r) => n + sumTokens(r), 0);   // 107,750
const PRE_COST = PRE.reduce((n, r) => n + r.cost, 0);           // 2.80
const POST_TOKENS = sumTokens(POST);                             // 11,300

/** What the OLD key left of u1's pre-cutover interval: one row per token type. */
const COLLAPSED_TOKENS = 1000 + 200 + 50_000 + 4000;            // 55,200
const COLLAPSED_COST = 1.5;

/** u2 exported metrics and no logs; u4's events cannot match its metrics. */
const U2_TOKENS = 777;
const U2_COST = 9.99;
const U4_METRIC_TOKENS = 5000;
const U4_METRIC_COST = 0.05;
const U4_EVENT_TOKENS = 100;

const BEFORE_MEASURED_TOKENS = COLLAPSED_TOKENS + POST_TOKENS + U2_TOKENS + U4_METRIC_TOKENS;
const AFTER_MEASURED_TOKENS = PRE_TOKENS + POST_TOKENS + U2_TOKENS + U4_METRIC_TOKENS;
const BEFORE_MEASURED_COST = COLLAPSED_COST + POST.cost + U2_COST + U4_METRIC_COST;
const AFTER_MEASURED_COST = PRE_COST + POST.cost + U2_COST + U4_METRIC_COST;

function eventValues(user: string, requests: Request[], prefix: string): string {
  return requests
    .map(
      (r, i) =>
        `('${r.ts}','${user}','','claude_code.api_request',${r.input},${r.output},${r.read},${r.write},${r.cost},'${r.model}','live','${prefix}${i}')`
    )
    .join(',');
}

function metricRows(
  user: string,
  ts: string,
  parts: [string, number][],
  model: string,
  idPrefix: string,
  provenance = 'live'
): string {
  return parts
    .map(
      ([type, value], i) =>
        `('${ts}','${user}','','${TOKEN_METRIC}',${value},'${type}','${model}','${provenance}','${idPrefix}${i}')`
    )
    .join(',');
}

function fixture(): string {
  return `
INSERT INTO events_raw
  (timestamp, user_id, session_id, event_name, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, model, provenance, row_id)
VALUES
  ${eventValues('u1', PRE, 'pre')},
  ${eventValues('u1', [POST], 'post')},
  ('2026-09-15 09:00:00.000','u4','','claude_code.api_request',50,50,0,0,0.1,'claude-opus-5','live','u4e0');

-- u1, BEFORE the cutover: one row per token type for the whole export
-- interval, carrying only the first datapoint's value. This is the collapse.
INSERT INTO metrics_raw
  (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
VALUES
  ${metricRows('u1', '2026-10-01 09:00:10.000', [['input', 1000], ['output', 200], ['cacheRead', 50_000], ['cacheCreation', 4000]], 'claude-opus-5-5', 'm-pre-')},
  ('2026-10-01 09:00:10.000','u1','','${COST_METRIC}',${COLLAPSED_COST},'','claude-opus-5-5','live','m-pre-cost');

-- u1, AFTER the cutover: the new key keeps every datapoint, so these are exact.
-- They are on the SAME DAY as the collapsed ones and must survive untouched.
INSERT INTO metrics_raw
  (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
VALUES
  ${metricRows('u1', POST.ts, [['input', POST.input], ['output', POST.output], ['cacheRead', POST.read], ['cacheCreation', POST.write]], POST.model, 'm-post-')},
  ('${POST.ts}','u1','','${COST_METRIC}',${POST.cost},'','${POST.model}','live','m-post-cost');

-- A day with metric rows and NO api_request events: a user who exported
-- metrics but not logs. The repair must leave this one alone.
INSERT INTO metrics_raw
  (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
VALUES
  ('2026-09-01 09:00:00.000','u2','','${TOKEN_METRIC}',${U2_TOKENS},'input','claude-opus-5','live','m-u2'),
  ('2026-09-01 09:00:00.000','u2','','${COST_METRIC}',${U2_COST},'','claude-opus-5','live','m-u2c');

-- u4: a day whose live metrics hold MORE than its events do. Rebuilding it
-- would take a measurement away, so the pair is not superseded.
INSERT INTO metrics_raw
  (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
VALUES
  ('2026-09-15 09:00:05.000','u4','','${TOKEN_METRIC}',${U4_METRIC_TOKENS},'input','claude-opus-5','live','m-u4'),
  ('2026-09-15 09:00:05.000','u4','','${COST_METRIC}',${U4_METRIC_COST},'','claude-opus-5','live','m-u4c');

-- Rows of other provenances, and a metric with no per-event twin.
INSERT INTO metrics_raw
  (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
VALUES
  ('2026-02-01 12:00:00.000','u1','','${TOKEN_METRIC}',123456,'input','','legacy','m-leg'),
  ('2026-10-01 09:00:00.100','u1','','claude_code.lines_of_code.count',42,'','','live','m-lines');
`;
}

const SUMMARY = `
SELECT
  toUInt64(sumIf(value, metric_name = '${TOKEN_METRIC}' AND ${MEASURED_PROVENANCE_SQL})) AS measured_tokens,
  toFloat64(sumIf(value, metric_name = '${COST_METRIC}' AND ${MEASURED_PROVENANCE_SQL})) AS measured_cost,
  toUInt64(sumIf(value, provenance = 'legacy')) AS legacy_tokens,
  toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count')) AS lines,
  toUInt64(sumIf(value, metric_name = '${TOKEN_METRIC}' AND user_id = 'u2')) AS u2_tokens,
  toFloat64(sumIf(value, metric_name = '${COST_METRIC}' AND user_id = 'u2')) AS u2_cost,
  toUInt64(sumIf(value, metric_name = '${TOKEN_METRIC}' AND user_id = 'u4')) AS u4_tokens,
  toFloat64(sumIf(value, metric_name = '${COST_METRIC}' AND user_id = 'u4')) AS u4_cost,
  toUInt64(sumIf(value, metric_name = '${TOKEN_METRIC}' AND timestamp >= toDateTime64('${CUTOVER}', 3))) AS post_cutover_tokens,
  toUInt64(countIf(provenance = '${REPAIR_PROVENANCE}')) AS repair_rows
FROM metrics_raw FINAL
FORMAT TSVWithNames`;

const REPAIR = [deleteSupersededSql(CUTOVER), deriveInsertSql(CUTOVER)];

const describeIf = CLICKHOUSE ? describe : describe.skip;

if (!CLICKHOUSE) {
  console.warn(
    '[repair-token-metrics] no clickhouse binary found — SKIPPING the SQL suite. ' +
      'CLICKHOUSE_BIN=./clickhouse bun test docker/clickhouse/migrations'
  );
}

describeIf('the token/cost repair', () => {
  /** Run the fixture, then some steps, and return the final summary row. */
  function run(...steps: string[]): Record<string, string> {
    const out = chLocal(script(schemaSql(), fixture(), ...steps, SUMMARY));
    const lines = out.trim().split('\n');
    const names = lines[lines.length - 2]!.split('\t');
    const values = lines[lines.length - 1]!.split('\t');
    return Object.fromEntries(names.map((name, i) => [name, values[i]!]));
  }

  /** Run a one-row SELECT after the fixture and return its first column. */
  function scalar(...steps: string[]): string {
    const out = chLocal(script(schemaSql(), fixture(), ...steps));
    return out.trim().split('\n').pop()!.trim();
  }

  it('reads the collapsed total before anything is changed', () => {
    const before = run();
    expect(Number(before.measured_tokens)).toBe(BEFORE_MEASURED_TOKENS);
    expect(Number(before.measured_cost)).toBeCloseTo(BEFORE_MEASURED_COST, 6);
  });

  it('restores the figure the api_request events hold', () => {
    const after = run(...REPAIR);
    expect(Number(after.measured_tokens)).toBe(AFTER_MEASURED_TOKENS);
    expect(Number(after.measured_cost)).toBeCloseTo(AFTER_MEASURED_COST, 6);
    // The whole point: the total goes UP, by the share the old key discarded.
    expect(Number(after.measured_tokens)).toBeGreaterThan(BEFORE_MEASURED_TOKENS);
  });

  // The cutover's reason for existing. The day is half collapsed and half
  // exact; the exact half is neither deleted nor rebuilt, so it is counted
  // exactly once in a total that is otherwise entirely replaced.
  it('leaves the post-cutover half of a partly covered day untouched', () => {
    const before = run();
    const after = run(...REPAIR);
    expect(Number(before.post_cutover_tokens)).toBe(POST_TOKENS);
    expect(Number(after.post_cutover_tokens)).toBe(POST_TOKENS);

    // And it was not rebuilt either: every repaired row sits before the cutover.
    const past = scalar(
      ...REPAIR,
      `SELECT toUInt64(count()) FROM metrics_raw FINAL
       WHERE provenance = '${REPAIR_PROVENANCE}'
         AND timestamp >= toDateTime64('${CUTOVER}', 3) FORMAT TSV`
    );
    expect(Number(past)).toBe(0);
  });

  it('leaves a day that has metrics but no events exactly as it was', () => {
    const after = run(...REPAIR);
    expect(Number(after.u2_tokens)).toBe(U2_TOKENS);
    expect(Number(after.u2_cost)).toBeCloseTo(U2_COST, 6);
  });

  // The guard that keeps the repair from being a deletion. u4's events hold a
  // hundred tokens where its metrics hold five thousand: whatever happened
  // there, the events are not a better record of it.
  it('refuses a (user, day) pair whose events cannot match its metrics', () => {
    const after = run(...REPAIR);
    expect(Number(after.u4_tokens)).toBe(U4_METRIC_TOKENS);
    expect(Number(after.u4_cost)).toBeCloseTo(U4_METRIC_COST, 6);

    const u4Repaired = scalar(
      ...REPAIR,
      `SELECT toUInt64(count()) FROM metrics_raw FINAL
       WHERE user_id = 'u4' AND provenance = '${REPAIR_PROVENANCE}' FORMAT TSV`
    );
    expect(Number(u4Repaired)).toBe(0);
  });

  it('names exactly the eligible (user, day) pairs', () => {
    const out = chLocal(
      script(
        schemaSql(),
        fixture(),
        `SELECT user_id, toString(day) AS day FROM (${eligiblePairsSql(CUTOVER)})
         ORDER BY user_id, day FORMAT TSV`
      )
    );
    // u1's 2026-10-01 only: u2 has no events, u4's events fall short.
    expect(out.trim().split('\n').slice(-1)).toEqual(['u1\t2026-10-01']);
  });

  it('does not touch legacy rows or any other metric', () => {
    const after = run(...REPAIR);
    expect(Number(after.legacy_tokens)).toBe(123_456);
    expect(Number(after.lines)).toBe(42);
  });

  // Running it twice must be a no-op: the derived rows carry the same
  // deterministic row_id, so the second insert collapses under FINAL. And the
  // second DELETE finds nothing, because the pair's live rows are already gone.
  it('is idempotent across a full re-run', () => {
    const once = run(...REPAIR);
    const twice = run(...REPAIR, ...REPAIR);
    expect(twice.measured_tokens).toBe(once.measured_tokens);
    expect(twice.measured_cost).toBe(once.measured_cost);
    expect(twice.repair_rows).toBe(once.repair_rows);
  });

  /**
   * The live-ingest race. The app stays up for every step of the runbook, so
   * rows keep arriving while the mutation runs — and they arrive stamped NOW,
   * which is past the cutover. Simulated by inserting between the DELETE and
   * the INSERT, which is the window the two-statement order leaves open.
   *
   * Neither double counted (the derive cannot reach them) nor lost (the DELETE
   * cannot either): that is what the cutover bound buys.
   */
  it('neither doubles nor loses rows that arrive mid-mutation', () => {
    const arriving = `
      INSERT INTO metrics_raw
        (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
      VALUES
        ('2026-10-01 14:00:00.000','u1','','${TOKEN_METRIC}',9000,'cacheRead','claude-opus-5-5','live','m-live-1'),
        ('2026-10-01 14:00:00.000','u1','','${COST_METRIC}',0.25,'','claude-opus-5-5','live','m-live-1c')`;

    const after = run(deleteSupersededSql(CUTOVER), arriving, deriveInsertSql(CUTOVER));
    expect(Number(after.measured_tokens)).toBe(AFTER_MEASURED_TOKENS + 9000);
    expect(Number(after.measured_cost)).toBeCloseTo(AFTER_MEASURED_COST + 0.25, 6);
    expect(Number(after.post_cutover_tokens)).toBe(POST_TOKENS + 9000);
  });

  it('restores the model on every repaired row, which the model mix reads', () => {
    const out = chLocal(
      script(
        schemaSql(),
        fixture(),
        ...REPAIR,
        `SELECT model, toUInt64(sum(value)) AS tokens
         FROM metrics_raw FINAL
         WHERE provenance = '${REPAIR_PROVENANCE}' AND metric_name = '${TOKEN_METRIC}'
         GROUP BY model ORDER BY tokens DESC FORMAT TSVWithNames`
      )
    );
    const rows = out.trim().split('\n').slice(1).map((line) => line.split('\t'));
    expect(rows.map((r) => r[0])).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    // Opus: (1000+200+50000+4000) + (800+150+30000+1000). The post-cutover
    // Opus request is NOT here — it was never rebuilt.
    expect(Number(rows[0]![1])).toBe(55_200 + 31_950);
  });

  it('keeps each request at its own instant, so the hour shape is real', () => {
    const instants = scalar(
      ...REPAIR,
      `SELECT toUInt64(uniqExact(timestamp)) FROM metrics_raw FINAL
       WHERE provenance = '${REPAIR_PROVENANCE}' FORMAT TSV`
    );
    // Three pre-cutover requests, three instants — not one export timestamp.
    expect(Number(instants)).toBe(3);
  });

  /**
   * The hash the SQL computes must be the hash TypeScript computes, or a
   * repaired row stops collapsing on a re-run.
   *
   * And it is hung off the SOURCE EVENT's row_id, not the attribute list: that
   * is what lets two requests in the same export interval — same timestamp,
   * same model, same empty session — keep separate identities. Hashing the
   * attributes would re-collapse them into the one row this step exists to
   * undo, which the next test proves by construction.
   */
  it('computes the same row_id TypeScript would, from the source event', () => {
    const out = chLocal(
      script(
        schemaSql(),
        fixture(),
        ...REPAIR,
        `SELECT m.timestamp, m.metric_name, m.token_type, e.row_id AS src, m.row_id
         FROM metrics_raw AS m FINAL
         INNER JOIN (SELECT timestamp, row_id FROM events_raw FINAL
                     WHERE ${repairableEventsSql(CUTOVER)}) e
           ON m.timestamp = e.timestamp
         WHERE m.provenance = '${REPAIR_PROVENANCE}'
         ORDER BY m.timestamp, m.metric_name, m.token_type FORMAT TSVWithNames`
      )
    );
    const rows = out.trim().split('\n').slice(1).map((line) => line.split('\t'));
    expect(rows.length).toBe(14); // (4+1) + (3+1) + (4+1) datapoints over three requests

    for (const [, metricName, tokenType, src, rowId] of rows) {
      expect(rowId).toBe(repairedMetricRowId(src!, metricName!, tokenType!));
    }
  });

  /**
   * The bug the old identity had, as a test. Two requests in the SAME
   * millisecond with the same model and the same empty session differ only by
   * their source event — so only an identity derived from that event keeps them
   * apart. Under METRIC_IDENTITY_COLUMNS they would hash alike and the repair
   * would re-collapse its own output.
   */
  it('keeps two requests that share a millisecond apart', () => {
    const collide = `
      INSERT INTO events_raw
        (timestamp, user_id, session_id, event_name, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, model, provenance, row_id)
      VALUES
        ('2026-10-01 10:00:00.000','u5','','claude_code.api_request',100,0,0,0,0.01,'claude-opus-5','live','c1'),
        ('2026-10-01 10:00:00.000','u5','','claude_code.api_request',250,0,0,0,0.02,'claude-opus-5','live','c2')`;

    const out = chLocal(
      script(
        schemaSql(),
        fixture(),
        collide,
        ...REPAIR,
        `SELECT toUInt64(count()) AS rows, toUInt64(sum(value)) AS tokens
         FROM metrics_raw FINAL
         WHERE user_id = 'u5' AND metric_name = '${TOKEN_METRIC}' FORMAT TSVWithNames`
      )
    );
    const [rows, tokens] = out.trim().split('\n').pop()!.split('\t');
    expect(Number(rows)).toBe(2);
    expect(Number(tokens)).toBe(350);
  });

  // Also the proof that the delete WAITS for its own mutation: without
  // `mutations_sync = 2` inside the statement, this read races it.
  it('leaves nothing in scope behind, synchronously', () => {
    const left = scalar(
      deleteSupersededSql(CUTOVER),
      `SELECT toUInt64(count()) FROM metrics_raw FINAL
       WHERE ${supersededMetricsSql(CUTOVER)} FORMAT TSV`
    );
    expect(Number(left)).toBe(0);
  });

  /**
   * The rollback, exercised end to end. The step-0a backup is not one — it
   * predates step 5's import — so the only honest reversal is the rows this
   * step itself removed, kept aside before it removed them.
   */
  it('can be rolled back to the exact rows it deleted', () => {
    const rolledBack = run(
      CREATE_BACKUP_SQL,
      backupSupersededSql(CUTOVER),
      ...REPAIR,
      `ALTER TABLE metrics_raw DELETE WHERE provenance = '${REPAIR_PROVENANCE}' SETTINGS mutations_sync = 2`,
      `INSERT INTO metrics_raw SELECT * FROM ${BACKUP_TABLE} FINAL`
    );
    expect(Number(rolledBack.measured_tokens)).toBe(BEFORE_MEASURED_TOKENS);
    expect(Number(rolledBack.measured_cost)).toBeCloseTo(BEFORE_MEASURED_COST, 6);
    expect(Number(rolledBack.repair_rows)).toBe(0);
  });

  it('backs up exactly as many rows as the delete removes', () => {
    const out = chLocal(
      script(
        schemaSql(),
        fixture(),
        CREATE_BACKUP_SQL,
        `SELECT toUInt64(count()) AS in_scope FROM metrics_raw FINAL
         WHERE ${supersededMetricsSql(CUTOVER)} FORMAT TSV`,
        backupSupersededSql(CUTOVER),
        `SELECT toUInt64(count()) AS backed_up FROM ${BACKUP_TABLE} FINAL FORMAT TSV`
      )
    );
    const values = out.trim().split('\n').filter((line) => /^\d+$/.test(line.trim()));
    expect(values.length).toBe(2);
    expect(values[0]).toBe(values[1]);
    expect(Number(values[0])).toBe(5); // four token rows plus the cost row
  });

  it('ignores an api_request that measured nothing', () => {
    const repairable = scalar(
      `INSERT INTO events_raw
         (timestamp, user_id, session_id, event_name, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd, model, provenance, row_id)
       VALUES ('2026-10-01 09:00:00.000','u3','','claude_code.api_request',0,0,0,0,0,'claude-opus-5','live','z1')`,
      `SELECT toUInt64(count()) FROM events_raw FINAL
       WHERE ${repairableEventsSql(CUTOVER)} AND user_id = 'u3' FORMAT TSV`
    );
    expect(Number(repairable)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No ClickHouse needed: the cutover's shape, the arithmetic the operator reads,
// and the column list the derive writes.
// ─────────────────────────────────────────────────────────────────────────────

describe('the cutover argument', () => {
  it('accepts the two shapes an operator will paste', () => {
    expect(normalizeCutover('2026-10-19 09:14:00')).toBe('2026-10-19 09:14:00.000');
    expect(normalizeCutover('2026-10-19T09:14:00.5Z')).toBe('2026-10-19 09:14:00.500');
  });

  it('refuses anything it cannot vouch for', () => {
    // It is interpolated into an ALTER, where there is no parameter to bind.
    expect(() => normalizeCutover("2026-10-19' OR '1")).toThrow();
    expect(() => normalizeCutover('yesterday')).toThrow();
    expect(() => normalizeCutover('2024-06-01 00:00:00')).toThrow(/predates/);
    expect(() => normalizeCutover('2099-01-01 00:00:00')).toThrow(/future/);
  });
});

describe('what the operator is told', () => {
  const events: EventDay[] = [
    { user_id: 'u1', day: '2026-10-01', event_tokens: 107_750, event_cost: 2.8, rows_to_write: 14 },
    { user_id: 'u4', day: '2026-09-15', event_tokens: 100, event_cost: 0.1, rows_to_write: 3 },
  ];
  const metrics: MetricDay[] = [
    { user_id: 'u1', day: '2026-10-01', provenance: 'live', tokens: 55_200, cost: 1.5 },
    { user_id: 'u2', day: '2026-09-01', provenance: 'live', tokens: 777, cost: 9.99 },
    { user_id: 'u4', day: '2026-09-15', provenance: 'live', tokens: 5000, cost: 0.05 },
    { user_id: 'u1', day: '2026-02-01', provenance: 'legacy', tokens: 123_456, cost: 0 },
  ];
  const eligible = [{ user_id: 'u1', day: '2026-10-01' }];

  const rows = reconcileFrom(events, metrics, eligible);
  const byUser = new Map(rows.map((row) => [row.scope, row]));

  it('states what each user will read after the repair', () => {
    expect(byUser.get('u1')!.metric_tokens).toBe(55_200);
    expect(byUser.get('u1')!.expected_tokens).toBe(107_750);
    // Not superseded, so the target is what is there now — not the events.
    expect(byUser.get('u4')!.expected_tokens).toBe(5000);
    expect(byUser.get('u2')!.expected_tokens).toBe(777);
  });

  it('leaves reconstructed rows out of the measured totals', () => {
    // The legacy row is u1's and is neither counted now nor expected later.
    expect(byUser.get('u1')!.metric_tokens).toBe(55_200);
    expect(byUser.get('u1')!.expected_tokens).toBe(107_750);
  });

  it('names the (user, day) pairs it is refusing, with both sides', () => {
    expect(byUser.get('u1')!.losers).toEqual([]);
    expect(byUser.get('u4')!.losers).toEqual([
      { day: '2026-09-15', event_tokens: 100, event_cost: 0.1, metric_tokens: 5000, metric_cost: 0.05 },
    ]);
  });

  it('counts only the rows it will actually write', () => {
    expect(byUser.get('u1')!.rows_to_write).toBe(14);
    expect(byUser.get('u4')!.rows_to_write).toBe(0);
  });

  it('treats repair rows from an earlier run as already landed', () => {
    const again = reconcileFrom(
      events,
      [...metrics, { user_id: 'u9', day: '2026-08-01', provenance: 'repair', tokens: 4242, cost: 1 }],
      eligible
    );
    expect(again.find((row) => row.scope === 'u9')!.expected_tokens).toBe(4242);
  });
});

describe('the derive column list', () => {
  it('names only columns metrics_raw actually has', () => {
    const ddl = readFileSync(join(import.meta.dir, '../init/01_schema.sql'), 'utf8');
    const body = /CREATE TABLE IF NOT EXISTS metrics_raw \(([\s\S]*?)\n\) ENGINE/.exec(ddl)?.[1] ?? '';
    const declared = new Set(
      body
        .split('\n')
        .map((line) => /^\s{4}([a-z_]+)\s/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name))
    );
    expect(declared.size).toBeGreaterThan(20);
    expect(DERIVE_COLUMNS.filter((column) => !declared.has(column))).toEqual([]);
  });
});
