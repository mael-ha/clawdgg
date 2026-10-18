import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENT_IDENTITY_COLUMNS,
  METRIC_IDENTITY_COLUMNS,
  MODEL_ID_SQL,
  PROMPT_EVENT_SQL,
  eventRowId,
  identitySqlExpr,
  metricRowId,
  type EventRow,
  type MetricRow,
} from './clickhouse';
import { stripModelDecorations } from '../lib/pricing';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// A realistic token.usage datapoint: main-thread Opus input tokens.
const METRIC: MetricRow = {
  timestamp: '2026-10-18 09:30:00.123',
  user_id: 'github_1',
  session_id: 'sess-a',
  metric_name: 'claude_code.token.usage',
  value: 1234,
  model: 'claude-opus-5-5',
  token_type: 'input',
  query_source: 'main',
  effort: 'xhigh',
  terminal_type: 'iTerm.app',
  app_version: '2.1.302',
};

const EVENT: EventRow = {
  timestamp: '2026-10-18 09:30:00.123',
  user_id: 'github_1',
  session_id: 'sess-a',
  event_name: 'claude_code.tool_result',
  tool_name: 'Bash',
  tool_use_id: 'toolu_01',
  tool_success: 1,
  tool_duration_ms: 900,
  decision: 'accept',
  source: 'config',
};

describe('metricRowId', () => {
  it('is a 32-char lowercase hex digest', () => {
    expect(metricRowId(METRIC)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes an OTLP retry of the same datapoint identically', () => {
    // Same identity, re-sent — must collapse, so the hash must not move.
    expect(metricRowId({ ...METRIC })).toBe(metricRowId(METRIC));
  });

  it('ignores the measured value, so a retried counter still dedups', () => {
    expect(metricRowId({ ...METRIC, value: 99999 })).toBe(metricRowId(METRIC));
  });

  it('ignores pricing_source-style annotations it does not read', () => {
    // pricing_source is deliberately absent from METRIC_IDENTITY_COLUMNS: a
    // re-run backfill after a price-table change must update, not duplicate.
    expect(METRIC_IDENTITY_COLUMNS).not.toContain('pricing_source');
  });

  it('treats main and subagent usage at the same instant as different rows', () => {
    expect(metricRowId({ ...METRIC, query_source: 'subagent' })).not.toBe(metricRowId(METRIC));
  });

  it.each([
    ['model', { model: 'claude-sonnet-5-5' }],
    ['token_type', { token_type: 'output' }],
    ['line_type', { line_type: 'added' }],
    ['speed', { speed: 'fast' }],
    ['effort', { effort: 'low' }],
    ['agent_name', { agent_name: 'opus-coder' }],
    ['skill_name', { skill_name: 'dataviz' }],
    ['plugin_name', { plugin_name: 'pr-review-toolkit' }],
    ['mcp_server_name', { mcp_server_name: 'gmail' }],
    ['mcp_tool_name', { mcp_tool_name: 'send_message' }],
    ['start_type', { start_type: 'resume' }],
    ['tool', { tool: 'Edit' }],
    ['decision', { decision: 'reject' }],
    ['language', { language: 'TypeScript' }],
    ['source', { source: 'user_permanent' }],
    ['session_id', { session_id: 'sess-b' }],
    ['timestamp', { timestamp: '2026-10-18 09:30:00.124' }],
    ['organization_id', { organization_id: 'org-2' }],
    ['marketplace_name', { marketplace_name: 'anthropic' }],
  ] as const)('a different %s is a different row', (_name, patch) => {
    expect(metricRowId({ ...METRIC, ...patch })).not.toBe(metricRowId(METRIC));
  });

  // active_time.total reports keyboard time and tool/response time as two
  // datapoints on ONE timestamp. Before time_type they were a single row and
  // half the active time was lost.
  it('separates active_time user and cli datapoints at the same instant', () => {
    const activeTime: MetricRow = {
      timestamp: '2026-10-18 09:30:00.123',
      user_id: 'github_1',
      session_id: 'sess-a',
      metric_name: 'claude_code.active_time.total',
      value: 42,
    };
    expect(metricRowId({ ...activeTime, time_type: 'user' })).not.toBe(
      metricRowId({ ...activeTime, time_type: 'cli' })
    );
  });

  it('keeps a backfill estimate off a live measured row', () => {
    expect(metricRowId({ ...METRIC, provenance: 'backfill' })).not.toBe(metricRowId(METRIC));
  });

  it('treats an omitted provenance as live, matching the column DEFAULT', () => {
    expect(metricRowId({ ...METRIC, provenance: 'live' })).toBe(metricRowId(METRIC));
  });

  it('cannot be fooled by shifting a separator between adjacent fields', () => {
    const a = metricRowId({ ...METRIC, model: 'ab', token_type: 'c' });
    const b = metricRowId({ ...METRIC, model: 'a', token_type: 'bc' });
    expect(a).not.toBe(b);
  });
});

describe('eventRowId', () => {
  it('is a 32-char lowercase hex digest', () => {
    expect(eventRowId(EVENT)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes a retry identically and ignores the measures', () => {
    expect(eventRowId({ ...EVENT })).toBe(eventRowId(EVENT));
    expect(eventRowId({ ...EVENT, tool_duration_ms: 5, duration_ms: 5, prompt_length: 7 })).toBe(
      eventRowId(EVENT)
    );
  });

  it('separates two parallel tool calls in the same millisecond', () => {
    expect(eventRowId({ ...EVENT, tool_use_id: 'toolu_02' })).not.toBe(eventRowId(EVENT));
  });

  it.each([
    ['event_name', { event_name: 'claude_code.tool_decision' }],
    ['tool_name', { tool_name: 'Edit' }],
    ['model', { model: 'claude-opus-5-5' }],
    ['decision', { decision: 'reject' }],
    ['source', { source: 'user_reject' }],
    ['request_id', { request_id: 'req_1' }],
    ['prompt_id', { prompt_id: 'prompt-1' }],
    ['command_name', { command_name: 'commit' }],
    ['command_source', { command_source: 'builtin' }],
    ['query_source', { query_source: 'subagent' }],
    ['speed', { speed: 'fast' }],
    ['effort', { effort: 'max' }],
    ['agent_name', { agent_name: 'explorer' }],
    ['skill_name', { skill_name: 'claude-api' }],
    ['status_code', { status_code: 529 }],
    ['error_message', { error_message: 'overloaded' }],
    ['error_type', { error_type: 'Error:ENOENT' }],
    ['tool_source', { tool_source: 'mcp' }],
    ['client_request_id', { client_request_id: 'creq_1' }],
    ['message_uuid', { message_uuid: 'msg-1' }],
    ['marketplace_name', { marketplace_name: 'anthropic' }],
    ['event_sequence', { event_sequence: 7 }],
  ] as const)('a different %s is a different row', (_name, patch) => {
    expect(eventRowId({ ...EVENT, ...patch })).not.toBe(eventRowId(EVENT));
  });

  it('treats an omitted status_code as 0', () => {
    expect(eventRowId({ ...EVENT, status_code: 0 })).toBe(eventRowId(EVENT));
  });

  // -1, not 0: a record that carried no event.sequence and the genuine first
  // record of a process must not collapse into one row.
  it('treats an omitted event_sequence as -1, distinct from sequence 0', () => {
    expect(eventRowId({ ...EVENT, event_sequence: -1 })).toBe(eventRowId(EVENT));
    expect(eventRowId({ ...EVENT, event_sequence: 0 })).not.toBe(eventRowId(EVENT));
  });

  // The general case: two records of ANY event type in one millisecond are kept
  // apart by the sequence alone, including event types with no other columns.
  it('separates two same-millisecond records by event.sequence alone', () => {
    const compaction: EventRow = {
      timestamp: '2026-10-18 09:30:00.123',
      user_id: 'github_1',
      session_id: 'sess-a',
      event_name: 'claude_code.compaction',
    };
    expect(eventRowId({ ...compaction, event_sequence: 11 })).not.toBe(
      eventRowId({ ...compaction, event_sequence: 12 })
    );
  });
});

// The hash is a stored dedup key: changing the algorithm orphans every row
// already in ClickHouse (old rows keep a hash the app will never reproduce, so
// retries stop collapsing). These golden values pin it.
//
// Both are reproducible from a shell with no TypeScript involved, which is how
// to re-derive them when the field list changes. 27 fields, so 26 separators;
// the unset ones are empty strings and the two numeric ones hash as their
// column DEFAULT ('-1' for event_sequence, '0' for status_code). Verified
// against these exact values on 2026-10-18:
//
//   S=$(printf '\037')
//   M="2026-10-18 09:30:00.123${S}u${S}s${S}claude_code.token.usage"
//   for i in $(seq 23); do M="${M}${S}"; done; M="${M}live"
//   printf '%s' "$M" | shasum -a 256 | cut -c1-32   # metric
//
//   E="2026-10-18 09:30:00.123${S}u${S}s${S}claude_code.user_prompt${S}-1"
//   for i in $(seq 18); do E="${E}${S}"; done; E="${E}${S}0${S}${S}${S}live"
//   printf '%s' "$E" | shasum -a 256 | cut -c1-32   # event
describe('identity hash golden values', () => {
  it('hashes a minimal metric row to a known digest', () => {
    expect(
      metricRowId({
        timestamp: '2026-10-18 09:30:00.123',
        user_id: 'u',
        session_id: 's',
        metric_name: 'claude_code.token.usage',
        value: 1,
      })
    ).toBe('272b0cecffadd10df0b7ed9e274f55de');
  });

  it('hashes a minimal event row to a known digest', () => {
    expect(
      eventRowId({
        timestamp: '2026-10-18 09:30:00.123',
        user_id: 'u',
        session_id: 's',
        event_name: 'claude_code.user_prompt',
      })
    ).toBe('e8b59a7f17330ebfa4ad75d11c0efa6c');
  });
});

describe('identitySqlExpr', () => {
  const migration = readFileSync(
    join(REPO_ROOT, 'docker/clickhouse/migrations/2026-10-18_dedup_identity_v2.sql'),
    'utf8'
  );

  // The historical-row hash is computed in SQL. If the TS field list changes
  // without the migration being regenerated, every pre-migration row gets a
  // hash the app will never reproduce, and retries stop deduplicating.
  it('matches the metrics expression checked into the v2 migration', () => {
    expect(migration).toContain(identitySqlExpr(METRIC_IDENTITY_COLUMNS));
  });

  it('matches the events expression checked into the v2 migration', () => {
    expect(migration).toContain(identitySqlExpr(EVENT_IDENTITY_COLUMNS));
  });

  it('separates fields with the same unit separator the TS hash uses', () => {
    expect(identitySqlExpr(['a', 'b'])).toContain('char(31)');
  });
});

describe('PROMPT_EVENT_SQL', () => {
  const source = readFileSync(join(import.meta.dir, 'clickhouse.ts'), 'utf8');

  it('excludes builtin slash commands and nothing else', () => {
    expect(PROMPT_EVENT_SQL).toBe(
      "event_name = 'claude_code.user_prompt' AND command_source != 'builtin'"
    );
  });

  // A surface that counts prompts its own way is a surface that disagrees with
  // the others, which is the one thing the prompt number must never do.
  it('is the only prompt predicate in the file', () => {
    const bareChecks = source
      .split('\n')
      .filter(line => line.includes("'claude_code.user_prompt'") && !line.trimStart().startsWith('*'))
      // the declaration itself is the one legitimate mention
      .filter(line => !line.includes('export const PROMPT_EVENT_SQL'));
    expect(bareChecks).toEqual([
      "  `event_name = 'claude_code.user_prompt' AND command_source != 'builtin'`;",
    ]);
  });

  it('is used by every prompt query', () => {
    // 14 call sites at the time of writing; the guard is that none regressed
    // to a bare event_name check, which the test above enforces.
    expect(source.match(/\$\{PROMPT_EVENT_SQL\}/g)?.length).toBeGreaterThanOrEqual(14);
  });
});

describe('MODEL_ID_SQL', () => {
  it('strips the same decorations as the TS normalizer', () => {
    // The TS and SQL normalizers must agree, or a model is priced under one id
    // and displayed under another.
    expect(stripModelDecorations('claude-sonnet-4-5-20250929[1m]')).toBe(
      'claude-sonnet-4-5-20250929'
    );
    expect(stripModelDecorations('us.anthropic.claude-sonnet-5-v1:0')).toBe('claude-sonnet-5');
    expect(stripModelDecorations('CLAUDE-OPUS-5-5')).toBe('claude-opus-5-5');
  });

  it('emits regex literals ClickHouse will unescape to the right pattern', () => {
    // One `\` in the pattern becomes `\\` in the SQL literal, which ClickHouse
    // unescapes back to `\` for RE2.
    expect(MODEL_ID_SQL).toContain(String.raw`'^(?:us|eu|apac|global)\\.'`);
    expect(MODEL_ID_SQL).toContain(String.raw`'\\[[^\\]]*\\]$'`);
    expect(MODEL_ID_SQL).toContain(String.raw`'-v\\d+:\\d+$'`);
    expect(MODEL_ID_SQL.startsWith('replaceRegexpOne(')).toBe(true);
    expect(MODEL_ID_SQL).toContain('lower(model)');
  });
});

describe('schema and migrations stay in sync', () => {
  const schema = readFileSync(join(REPO_ROOT, 'docker/clickhouse/init/01_schema.sql'), 'utf8');
  const migration = readFileSync(
    join(REPO_ROOT, 'docker/clickhouse/migrations/2026-10-18_dedup_identity_v2.sql'),
    'utf8'
  );

  it('puts row_id last in both sorting keys', () => {
    expect(schema).toContain(
      'ORDER BY (user_id, metric_name, token_type, line_type, timestamp, row_id)'
    );
    expect(schema).toContain('ORDER BY (user_id, session_id, event_name, timestamp, tool_name, row_id)');
  });

  it('gives the v2 tables the same sorting keys a fresh volume gets', () => {
    expect(migration).toContain(
      'ORDER BY (user_id, metric_name, token_type, line_type, timestamp, row_id)'
    );
    expect(migration).toContain(
      'ORDER BY (user_id, session_id, event_name, timestamp, tool_name, row_id)'
    );
  });

  it('declares every identity column on both tables', () => {
    for (const column of METRIC_IDENTITY_COLUMNS) {
      if (column === 'timestamp') continue;
      expect(schema).toContain(`    ${column} `);
    }
    for (const column of EVENT_IDENTITY_COLUMNS) {
      if (column === 'timestamp') continue;
      expect(schema).toContain(`    ${column} `);
    }
  });

  // "Store less": a tool's arguments are the user's content. The column is
  // gone from a fresh volume and dropped by omission from the v2 copy, which
  // is what physically removes the values prod already holds.
  it('has no tool_parameters column and never copies one', () => {
    expect(schema).not.toContain('tool_parameters String');
    expect(migration).not.toContain('tool_parameters');
  });

  it('copies the old tables without FINAL — FINAL would re-apply the broken key', () => {
    const statements = migration
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).toContain('FROM metrics_raw;');
    expect(statements).toContain('FROM events_raw;');
    expect(statements).not.toContain('FINAL');
  });
});
