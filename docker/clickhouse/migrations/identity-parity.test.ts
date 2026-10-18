/**
 * Proof that the SQL identity expression and the TypeScript one are the same
 * hash, run against a real ClickHouse.
 *
 * WHY THIS CANNOT BE REASONED ABOUT
 * The two sides agree only if six separate things line up, and every one of
 * them is a property of ClickHouse's implementation rather than of our code:
 *   - char(31) is the same byte as JS '\u001f'
 *   - arrayStringConcat joins exactly like Array.join
 *   - hex(SHA256(...)) is uppercase, so lower() is required, and substring is
 *     1-indexed where slice is 0-indexed
 *   - toString(DateTime64(3)) renders exactly three fractional digits, which
 *     the TS timestamp string must therefore always carry
 *   - toString() of an Int64 / UInt16 formats like JS String(n), including the
 *     negative event_sequence default
 *   - a column omitted from a JSONEachRow body takes its DEFAULT, and the TS
 *     hash must use that same default
 * Get any one wrong and every historical row carries a hash the app will never
 * reproduce: OTLP retries stop collapsing and the table grows a duplicate per
 * retry, silently. So this test inserts rows through the REAL serialisation
 * path (the JSON body src/db/clickhouse.ts `insert` sends) into the REAL DDL,
 * and asserts ClickHouse computes the row_id that TypeScript computed.
 *
 * HOW TO RUN
 * Needs the standalone `clickhouse` binary — no server, no Docker:
 *   curl https://clickhouse.com/ | sh          # ~182 MiB, drops ./clickhouse
 *   CLICKHOUSE_BIN=./clickhouse bun test docker/clickhouse/migrations
 * Without it the suite SKIPS rather than passing vacuously. CLICKHOUSE_BIN may
 * also be a bare name found on PATH.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENT_IDENTITY_COLUMNS,
  METRIC_IDENTITY_COLUMNS,
  eventRowId,
  identitySqlExpr,
  metricRowId,
  sanitizeForJson,
  type EventRow,
  type MetricRow,
} from '../../../src/db/clickhouse';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

function findClickhouse(): string | null {
  const candidates = [
    process.env.CLICKHOUSE_BIN,
    process.env.CLICKHOUSE_LOCAL_BIN,
    'clickhouse',
  ].filter((c): c is string => !!c);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['local', '--query', 'SELECT 1'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // not this one
    }
  }
  return null;
}

const CLICKHOUSE = findClickhouse();

/**
 * The two CREATE TABLE statements from the checked-in schema, with the
 * ReplacingMergeTree engine swapped for a plain MergeTree. clickhouse-local
 * needs no dedup here — the point is what the EXPRESSION computes over stored
 * values, and FINAL would hide a collision behind a merge.
 */
function schemaDdl(): string {
  const schema = readFileSync(join(REPO_ROOT, 'docker/clickhouse/init/01_schema.sql'), 'utf8');
  const creates = schema.match(/CREATE TABLE IF NOT EXISTS \w+ \([\s\S]*?SETTINGS index_granularity = 8192;/g);
  if (!creates || creates.length !== 2) {
    throw new Error(`expected 2 CREATE TABLE statements in 01_schema.sql, found ${creates?.length}`);
  }
  return creates
    .map(create =>
      create
        .replace(/ENGINE = ReplacingMergeTree\(\)/, 'ENGINE = MergeTree()')
        .replace(/TTL toDateTime\(timestamp\) \+ INTERVAL \d+ DAY/, '')
    )
    .join('\n\n');
}

/** Run a script through clickhouse-local and return stdout. */
function chLocal(script: string): string {
  return execFileSync(CLICKHOUSE!, ['local', '--multiquery', '--queries-file', '/dev/stdin'], {
    input: `${script}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The exact bytes src/db/clickhouse.ts `insert()` sends: one JSON object per
 * row, row_id filled in by the TS hash, lone surrogates replaced the way that
 * function replaces them. Testing anything else would test a serialisation
 * prod does not use — and it was this fixture set, through this path, that
 * found ClickHouse rejecting a whole batch over one `\ud83d`.
 */
function jsonEachRow(rows: Record<string, unknown>[]): string {
  return rows
    .map(row =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? sanitizeForJson(v) : v])
        )
      )
    )
    .join('\n');
}

// A string whose last character is half of a surrogate pair once sliced at a
// UTF-16 boundary — which is exactly what safeString()'s .slice(0, maxLen)
// produces. Both sides must agree on what that byte sequence is.
const EMOJI = '\u{1F680}'; // ROCKET, one astral codepoint, two UTF-16 units
const SPLIT_SURROGATE = `abc${EMOJI}`.slice(0, 4); // 'abc' + a lone high surrogate

const METRIC_ROWS: MetricRow[] = [
  // 1. realistic main-thread token usage
  {
    timestamp: '2026-10-18 09:30:00.123',
    user_id: 'github_61985678',
    session_id: 'c0ffee00-1111-2222-3333-444455556666',
    metric_name: 'claude_code.token.usage',
    value: 123456,
    model: 'claude-opus-5-5',
    token_type: 'cacheRead',
    query_source: 'main',
    effort: 'xhigh',
    terminal_type: 'iTerm.app',
    app_version: '2.1.302',
    account_uuid: 'acct-1',
    organization_id: 'org-1',
  },
  // 2. same instant, subagent — the collapse this key exists to prevent
  {
    timestamp: '2026-10-18 09:30:00.123',
    user_id: 'github_61985678',
    session_id: 'c0ffee00-1111-2222-3333-444455556666',
    metric_name: 'claude_code.token.usage',
    value: 999,
    model: 'claude-opus-5-5',
    token_type: 'cacheRead',
    query_source: 'subagent',
    agent_name: 'opus-coder',
  },
  // 3. active_time user vs cli, one timestamp
  {
    timestamp: '2026-10-18 09:30:00.000',
    user_id: 'u',
    session_id: 's',
    metric_name: 'claude_code.active_time.total',
    value: 42,
    time_type: 'user',
  },
  {
    timestamp: '2026-10-18 09:30:00.000',
    user_id: 'u',
    session_id: 's',
    metric_name: 'claude_code.active_time.total',
    value: 43,
    time_type: 'cli',
  },
  // 4. every optional field omitted — exercises the column DEFAULTs
  {
    timestamp: '2026-10-18 00:00:00.000',
    user_id: 'u',
    session_id: '',
    metric_name: 'claude_code.commit.count',
    value: 1,
  },
  // 5. unicode, a split surrogate pair, and separator-adjacent emptiness
  {
    timestamp: '2026-10-18 23:59:59.999',
    user_id: 'ユーザー',
    session_id: SPLIT_SURROGATE,
    metric_name: 'claude_code.code_edit_tool.decision',
    value: 1,
    language: 'Ελληνικά',
    tool: 'Edit',
    decision: 'accept',
    source: 'config',
    plugin_name: `plugin${EMOJI}`,
    marketplace_name: '',
  },
  // 6. a provenance other than the default, and a fractional-second edge
  {
    timestamp: '2026-01-01 12:00:00.001',
    user_id: 'u',
    session_id: '',
    metric_name: 'claude_code.cost.usage',
    value: 0.0001,
    provenance: 'legacy',
  },
  {
    timestamp: '2026-01-01 12:00:00.010',
    user_id: 'u',
    session_id: '',
    metric_name: 'claude_code.cost.usage',
    value: 0.0001,
    provenance: 'import',
  },
];

const EVENT_ROWS: EventRow[] = [
  // 1. realistic tool_result
  {
    timestamp: '2026-10-18 09:30:00.123',
    user_id: 'github_61985678',
    session_id: 'c0ffee00-1111-2222-3333-444455556666',
    event_name: 'claude_code.tool_result',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01ABCdef',
    tool_source: 'builtin',
    tool_success: 1,
    tool_duration_ms: 1234,
    decision: 'accept',
    source: 'config',
    event_sequence: 17,
  },
  // 2. same millisecond, second tool call
  {
    timestamp: '2026-10-18 09:30:00.123',
    user_id: 'github_61985678',
    session_id: 'c0ffee00-1111-2222-3333-444455556666',
    event_name: 'claude_code.tool_result',
    tool_name: 'Bash',
    tool_use_id: 'toolu_02XYZghi',
    event_sequence: 18,
  },
  // 3. every optional field omitted — event_sequence must hash as -1 and
  //    status_code as 0, matching the column DEFAULTs
  {
    timestamp: '2026-10-18 09:30:00.123',
    user_id: 'u',
    session_id: 's',
    event_name: 'claude_code.user_prompt',
  },
  // 4. explicit sequence 0, which must NOT equal the omitted case above
  {
    timestamp: '2026-10-18 09:30:00.123',
    user_id: 'u',
    session_id: 's',
    event_name: 'claude_code.user_prompt',
    event_sequence: 0,
  },
  // 5. an error path: redacted message, a status code, unicode
  {
    timestamp: '2026-10-18 10:00:00.500',
    user_id: 'u',
    session_id: 's',
    event_name: 'claude_code.api_error',
    model: 'claude-fable-5-1',
    status_code: 529,
    error_message: "EACCES: permission denied, open '<path>' — ошибка",
    error_type: 'Error:EACCES',
    request_id: 'req_011CSomething',
    client_request_id: 'creq_9',
    event_sequence: 4,
  },
  // 6. split surrogate pair in a stored string
  {
    timestamp: '2026-10-18 10:00:00.500',
    user_id: 'u',
    session_id: 's',
    event_name: 'claude_code.user_prompt',
    command_name: SPLIT_SURROGATE,
    command_source: 'custom',
    message_uuid: `msg-${EMOJI}`,
    marketplace_name: 'anthropic',
    event_sequence: 5,
  },
  // 7. a large sequence, to catch Int64 vs Float64 formatting
  {
    timestamp: '2026-10-18 10:00:00.500',
    user_id: 'u',
    session_id: 's',
    event_name: 'claude_code.compaction',
    event_sequence: 9007199254740991,
  },
];

describe.skipIf(!CLICKHOUSE)('SQL identity expression == TypeScript identity hash', () => {
  const ddl = schemaDdl();

  /**
   * Insert the rows exactly as prod would, then ask ClickHouse to recompute
   * every row's identity from the stored columns and report the disagreements.
   */
  function parityReport(
    table: 'metrics_raw' | 'events_raw',
    rows: Record<string, unknown>[],
    columns: readonly string[]
  ): { total: number; mismatches: string } {
    const script = `
${ddl}

INSERT INTO ${table} FORMAT JSONEachRow ${jsonEachRow(rows)};

SELECT count() FROM ${table};

SELECT row_id AS stored, ${identitySqlExpr(columns)} AS recomputed
FROM ${table}
WHERE stored != recomputed
FORMAT JSONEachRow;
`;
    const out = chLocal(script);
    const lines = out.split('\n').filter(Boolean);
    return { total: Number(lines[0] ?? 0), mismatches: lines.slice(1).join('\n') };
  }

  it('agrees on every metric row, including defaults and unicode', () => {
    const rows = METRIC_ROWS.map(row => ({ ...row, row_id: metricRowId(row) }));
    const { total, mismatches } = parityReport('metrics_raw', rows, METRIC_IDENTITY_COLUMNS);
    expect(mismatches).toBe('');
    expect(total).toBe(rows.length);
  });

  it('agrees on every event row, including the -1 sequence default', () => {
    const rows = EVENT_ROWS.map(row => ({ ...row, row_id: eventRowId(row) }));
    const { total, mismatches } = parityReport('events_raw', rows, EVENT_IDENTITY_COLUMNS);
    expect(mismatches).toBe('');
    expect(total).toBe(rows.length);
  });

  // The migration computes historical hashes with this expression; if it
  // collides, two genuinely different rows merge into one and a measurement is
  // lost. These fixtures include the pairs most at risk: same timestamp,
  // differing by one attribute.
  it('gives every fixture row a distinct hash', () => {
    const metricIds = new Set(METRIC_ROWS.map(metricRowId));
    expect(metricIds.size).toBe(METRIC_ROWS.length);
    const eventIds = new Set(EVENT_ROWS.map(eventRowId));
    expect(eventIds.size).toBe(EVENT_ROWS.length);
  });

  // The runbook's step-0 check. Reviewers suspected this defaults to 1, which
  // would mean a JSON body naming a column the table does not have is accepted
  // and the value silently dropped — so "the insert fails loudly" cannot be
  // relied on as a safety net. Whatever it is here, the migration is designed
  // not to depend on it: every INSERT names its columns explicitly.
  it('records what input_format_skip_unknown_fields actually defaults to', () => {
    const value = chLocal(
      `SELECT value FROM system.settings WHERE name = 'input_format_skip_unknown_fields'`
    );
    expect(['0', '1']).toContain(value);
    console.log(`[parity] input_format_skip_unknown_fields default = ${value}`);
  });
});

describe.skipIf(!!CLICKHOUSE)('SQL identity parity (skipped)', () => {
  it('needs the standalone clickhouse binary — see the header of this file', () => {
    expect(CLICKHOUSE).toBeNull();
  });
});
