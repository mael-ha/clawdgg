/**
 * The repair, run against a real ClickHouse on the real DDL.
 *
 * WHY THIS CANNOT BE REASONED ABOUT
 * The repair is one INSERT ... SELECT with an ARRAY JOIN over a tuple array, a
 * SQL-computed identity hash, and a DELETE scoped by a tuple IN subquery. Every
 * one of those is a property of ClickHouse's implementation rather than of our
 * code, and the whole point of the step is to change what the site's dollar
 * figures say. So this reproduces the prod failure — several token datapoints
 * sharing one export timestamp, collapsing under the OLD sorting key — and
 * asserts the repair restores the figure the api_request events hold.
 *
 * It also asserts the hash the SQL computes is the one TypeScript computes for
 * the same row: a repaired row with a row_id the app would never reproduce
 * would stop collapsing on OTLP retry, which is the bug the v2 key exists to
 * fix.
 *
 * HOW TO RUN
 *   curl https://clickhouse.com/ | sh          # ~182 MiB, drops ./clickhouse
 *   CLICKHOUSE_BIN=./clickhouse bun test docker/clickhouse/migrations
 * Without the binary the suite SKIPS rather than passing vacuously.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricRowId, type MetricRow } from '../../../src/db/clickhouse';
import {
  DELETE_SUPERSEDED_SQL,
  DERIVE_INSERT_SQL,
  REPAIRABLE_EVENTS_SQL,
  REPAIR_PROVENANCE,
  SUPERSEDED_METRICS_SQL,
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
function schema(): string {
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
 * Join a script out of steps. The exported SQL constants deliberately carry no
 * trailing semicolon — the app's `query()` sends one statement per request —
 * so the separator belongs here, where several are run in one file.
 */
function script(...steps: string[]): string {
  return steps.map((step) => step.trim().replace(/;$/, '')).join(';\n') + ';';
}

function chLocal(script: string): string {
  return execFileSync(CLICKHOUSE!, ['local', '--multiquery', '--queries-file', '/dev/stdin'], {
    input: `${script}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC' },
  }).trim();
}

/**
 * Three api_requests inside one export interval, exactly as prod has them:
 * each event carries its own millisecond and its own model, while the metric
 * datapoints all carry the export timestamp and so differ only by token_type.
 */
const EVENTS = [
  { ts: '2026-10-01 09:00:00.100', model: 'claude-opus-5-5', input: 1000, output: 200, read: 50_000, write: 4000, cost: 1.5 },
  { ts: '2026-10-01 09:00:03.250', model: 'claude-sonnet-5-5', input: 500, output: 100, read: 20_000, write: 0, cost: 0.4 },
  { ts: '2026-10-01 09:00:07.900', model: 'claude-opus-5-5', input: 800, output: 150, read: 30_000, write: 1000, cost: 0.9 },
];

const EXPECTED_EVENT_TOKENS = EVENTS.reduce(
  (sum, e) => sum + e.input + e.output + e.read + e.write,
  0
);
const EXPECTED_EVENT_COST = EVENTS.reduce((sum, e) => sum + e.cost, 0);

function fixture(): string {
  const eventRows = EVENTS.map(
    (e, i) =>
      `('${e.ts}','u1','','claude_code.api_request',${e.input},${e.output},${e.read},${e.write},${e.cost},'${e.model}','live','ev${i}')`
  ).join(',');

  // What the OLD key left behind: ONE row per token type for the whole export
  // interval, carrying only the first datapoint's value. This is the collapse.
  const collapsed = [
    ['input', 1000],
    ['output', 200],
    ['cacheRead', 50_000],
    ['cacheCreation', 4000],
  ]
    .map(
      ([type, value]) =>
        `('2026-10-01 09:00:10.000','u1','','claude_code.token.usage',${value},'${type}','claude-opus-5-5','live','m-${type}')`
    )
    .join(',');

  return `
INSERT INTO events_raw
  (timestamp, user_id, session_id, event_name, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, model, provenance, row_id)
VALUES ${eventRows};

INSERT INTO metrics_raw
  (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
VALUES ${collapsed},
  ('2026-10-01 09:00:10.000','u1','','claude_code.cost.usage',1.5,'','claude-opus-5-5','live','m-cost');

-- A day with metric rows and NO api_request events: a user who exported
-- metrics but not logs. The repair must leave this one alone.
INSERT INTO metrics_raw
  (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
VALUES
  ('2026-09-01 09:00:00.000','u2','','claude_code.token.usage',777,'input','claude-opus-5','live','m-u2'),
  ('2026-09-01 09:00:00.000','u2','','claude_code.cost.usage',9.99,'','claude-opus-5','live','m-u2c');

-- Rows of other provenances, which the repair must never touch.
INSERT INTO metrics_raw
  (timestamp, user_id, session_id, metric_name, value, token_type, model, provenance, row_id)
VALUES
  ('2026-02-01 12:00:00.000','u1','','claude_code.token.usage',123456,'input','','legacy','m-leg'),
  ('2026-10-01 09:00:00.100','u1','','claude_code.lines_of_code.count',42,'','','live','m-lines');
`;
}

const TOKEN_SUM = `
SELECT
  toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND provenance IN ('live','${REPAIR_PROVENANCE}'))) AS measured_tokens,
  toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage' AND provenance IN ('live','${REPAIR_PROVENANCE}'))) AS measured_cost,
  toUInt64(sumIf(value, provenance = 'legacy')) AS legacy_tokens,
  toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count')) AS lines,
  toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND user_id = 'u2')) AS u2_tokens,
  toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage' AND user_id = 'u2')) AS u2_cost
FROM metrics_raw FINAL
FORMAT TSVWithNames`;

const describeIf = CLICKHOUSE ? describe : describe.skip;

if (!CLICKHOUSE) {
  console.warn(
    '[repair-token-metrics] no clickhouse binary found — SKIPPING. ' +
      'CLICKHOUSE_BIN=./clickhouse bun test docker/clickhouse/migrations'
  );
}

describeIf('the token/cost repair', () => {
  /** Run the fixture, then a script, and return the final token summary. */
  function run(...steps: string[]): Record<string, string> {
    const out = chLocal(script(schema(), fixture(), ...steps, TOKEN_SUM));
    const lines = out.trim().split('\n');
    const names = lines[lines.length - 2]!.split('\t');
    const values = lines[lines.length - 1]!.split('\t');
    return Object.fromEntries(names.map((name, i) => [name, values[i]!]));
  }

  // u1's three requests collapsed to one row per token type (1000+200+50000+
  // 4000 = 55,200), plus u2's untouched 777 on a day with no events.
  const COLLAPSED_TOKENS = 55_200 + 777;

  it('reads the collapsed total before anything is changed', () => {
    const before = run();
    expect(Number(before.measured_tokens)).toBe(COLLAPSED_TOKENS);
    expect(Number(before.measured_cost)).toBeCloseTo(1.5 + 9.99, 6);
  });

  it('restores the figure the api_request events hold', () => {
    const after = run(DELETE_SUPERSEDED_SQL, DERIVE_INSERT_SQL);

    // u1's real total from the events, plus u2's untouched row.
    expect(Number(after.measured_tokens)).toBe(EXPECTED_EVENT_TOKENS + 777);
    expect(Number(after.measured_cost)).toBeCloseTo(EXPECTED_EVENT_COST + 9.99, 6);
    // The whole point: the total goes UP, by the share the old key discarded.
    expect(Number(after.measured_tokens)).toBeGreaterThan(COLLAPSED_TOKENS);
  });

  it('leaves a day that has metrics but no events exactly as it was', () => {
    const after = run(DELETE_SUPERSEDED_SQL, DERIVE_INSERT_SQL);
    expect(Number(after.u2_tokens)).toBe(777);
    expect(Number(after.u2_cost)).toBeCloseTo(9.99, 6);
  });

  it('does not touch legacy rows or any other metric', () => {
    const after = run(DELETE_SUPERSEDED_SQL, DERIVE_INSERT_SQL);
    expect(Number(after.legacy_tokens)).toBe(123_456);
    expect(Number(after.lines)).toBe(42);
  });

  // Running it twice must be a no-op: the derived rows carry the same
  // deterministic row_id, so the second insert collapses under FINAL.
  it('is idempotent', () => {
    const once = run(DELETE_SUPERSEDED_SQL, DERIVE_INSERT_SQL);
    const twice = run(
      DELETE_SUPERSEDED_SQL,
      DERIVE_INSERT_SQL,
      DELETE_SUPERSEDED_SQL,
      DERIVE_INSERT_SQL
    );
    expect(twice.measured_tokens).toBe(once.measured_tokens);
    expect(twice.measured_cost).toBe(once.measured_cost);
  });

  it('restores the model on every repaired row, which the model mix reads', () => {
    const out = chLocal(
      script(
        schema(),
        fixture(),
        DELETE_SUPERSEDED_SQL,
        DERIVE_INSERT_SQL,
        `SELECT model, toUInt64(sum(value)) AS tokens
         FROM metrics_raw FINAL
         WHERE provenance = '${REPAIR_PROVENANCE}' AND metric_name = 'claude_code.token.usage'
         GROUP BY model ORDER BY tokens DESC FORMAT TSVWithNames`,
      )
    );
    const rows = out.trim().split('\n').slice(1).map((line) => line.split('\t'));
    expect(rows.map((r) => r[0])).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    // Opus: (1000+200+50000+4000) + (800+150+30000+1000)
    expect(Number(rows[0]![1])).toBe(55_200 + 31_950);
  });

  it('keeps each request at its own instant, so the hour shape is real', () => {
    const out = chLocal(
      script(
        schema(),
        fixture(),
        DELETE_SUPERSEDED_SQL,
        DERIVE_INSERT_SQL,
        `SELECT toUInt64(uniqExact(timestamp)) AS instants
         FROM metrics_raw FINAL WHERE provenance = '${REPAIR_PROVENANCE}' FORMAT TSV`,
      )
    );
    // Three requests, three instants — not one export timestamp.
    expect(Number(out.trim().split('\n').pop())).toBe(3);
  });

  /**
   * The hash the SQL computes must be the hash the APP computes, or a repaired
   * row stops collapsing on an OTLP retry and the v2 key's whole purpose is
   * defeated for it.
   */
  it('computes the same row_id TypeScript would', () => {
    const out = chLocal(
      script(
        schema(),
        fixture(),
        DELETE_SUPERSEDED_SQL,
        DERIVE_INSERT_SQL,
        `SELECT timestamp, token_type, model, row_id
         FROM metrics_raw FINAL
         WHERE provenance = '${REPAIR_PROVENANCE}' AND metric_name = 'claude_code.token.usage'
         ORDER BY timestamp, token_type FORMAT TSVWithNames`,
      )
    );
    const rows = out.trim().split('\n').slice(1).map((line) => line.split('\t'));
    expect(rows.length).toBeGreaterThan(5);

    for (const [timestamp, token_type, model, row_id] of rows) {
      const expected = metricRowId({
        timestamp: timestamp!,
        user_id: 'u1',
        session_id: '',
        metric_name: 'claude_code.token.usage',
        value: 0, // not part of the identity
        model: model!,
        token_type: token_type!,
        provenance: REPAIR_PROVENANCE as MetricRow['provenance'],
      });
      expect(row_id).toBe(expected);
    }
  });

  // Also the proof that the delete WAITS for its own mutation: without
  // `mutations_sync = 2` inside the statement, this read races it.
  it('leaves nothing in scope behind, synchronously', () => {
    // Nothing matching SUPERSEDED_METRICS_SQL may survive the delete.
    const out = chLocal(
      script(
        schema(),
        fixture(),
        DELETE_SUPERSEDED_SQL,
        `SELECT toUInt64(count()) AS left_behind
         FROM metrics_raw FINAL WHERE ${SUPERSEDED_METRICS_SQL} FORMAT TSV`,
      )
    );
    expect(Number(out.trim().split('\n').pop())).toBe(0);
  });

  it('ignores an api_request that measured nothing', () => {
    const out = chLocal(
      script(
        schema(),
        `INSERT INTO events_raw
           (timestamp, user_id, session_id, event_name, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_usd, model, provenance, row_id)
         VALUES ('2026-10-01 09:00:00.000','u3','','claude_code.api_request',0,0,0,0,0,'claude-opus-5','live','z1');`,
        `SELECT toUInt64(count()) AS repairable FROM events_raw FINAL WHERE ${REPAIRABLE_EVENTS_SQL} FORMAT TSV`,
      )
    );
    expect(Number(out.trim().split('\n').pop())).toBe(0);
  });
});
