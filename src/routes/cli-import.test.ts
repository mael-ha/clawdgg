import { describe, expect, it } from 'bun:test';
import {
  checkImportRate,
  dropCoveredDays,
  dropDuplicates,
  EARLIEST_PLAUSIBLE_MS,
  MAX_CACHE_TOKENS_PER_REQUEST,
  MAX_INPUT_TOKENS_PER_REQUEST,
  MAX_OUTPUT_TOKENS_PER_REQUEST,
  runImport,
  sanitizeImportRows,
  type ImportDeps,
} from './cli';
import { computeCostUsd, mapLine, type MapOptions } from '../lib/session-import';
import { eventRowId, type EventRow, type MetricRow } from '../db/clickhouse';

const USER = 'github_1';
const CUTOFF = Date.parse('2026-05-06T00:00:00.000Z');

/**
 * A ClickHouse stand-in. The day-coverage set is what the real endpoint
 * computes from the raw tables before the batch is processed.
 */
function stubStore(coveredDays: string[] = []) {
  const events: EventRow[] = [];
  const metrics: MetricRow[] = [];

  const deps: ImportDeps = {
    cutoffMs: CUTOFF,
    coveredDays: new Set(coveredDays),
    insertEvents: async (rows) => { events.push(...rows); },
    insertMetrics: async (rows) => { metrics.push(...rows); },
  };

  return { deps, events, metrics };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  timestamp: '2026-03-01 10:00:00.000',
  session_id: 's1',
  event_name: 'claude_code.user_prompt',
  prompt_length: 12,
  ...overrides,
});

const apiRequest = (overrides: Record<string, unknown> = {}) =>
  event({
    event_name: 'claude_code.api_request',
    model: 'claude-opus-5',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 2000,
    cache_write_tokens: 100,
    prompt_length: undefined,
    ...overrides,
  });

describe('sanitizeImportRows', () => {
  it('always stamps the authenticated user and provenance=import', () => {
    const { events } = sanitizeImportRows(
      USER,
      { events: [event({ user_id: 'github_999', provenance: 'live' })] },
      CUTOFF
    );

    expect(events[0]!.user_id).toBe(USER);
    expect(events[0]!.provenance).toBe('import');
  });

  it('enforces the cutoff strictly', () => {
    const result = sanitizeImportRows(
      USER,
      {
        events: [
          event({ timestamp: '2026-05-05 23:59:59.999' }),
          event({ timestamp: '2026-05-06 00:00:00.000' }), // exactly at setup: refused
          event({ timestamp: '2026-05-06 00:00:00.001' }),
        ],
      },
      CUTOFF
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.timestamp).toBe('2026-05-05 23:59:59.999');
    expect(result.skippedAfterCutoff).toBe(2);
  });

  it('refuses rows that claim to predate Claude Code', () => {
    // A backdated row is either a broken clock or a forgery, and a 2019 row
    // would stretch every "first session" and streak calculation we have.
    const result = sanitizeImportRows(
      USER,
      {
        events: [
          event({ timestamp: '2019-06-01 10:00:00.000' }),
          event({ timestamp: '2025-01-31 23:59:59.999' }),
          event({ timestamp: '2025-02-01 00:00:00.000' }),
        ],
      },
      CUTOFF
    );

    expect(result.skippedBeforeEpoch).toBe(2);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.timestamp).toBe('2025-02-01 00:00:00.000');
    expect(EARLIEST_PLAUSIBLE_MS).toBe(Date.parse('2025-02-01T00:00:00.000Z'));
  });

  it('rejects unknown event names', () => {
    const result = sanitizeImportRows(
      USER,
      { events: [event({ event_name: 'claude_code.made_up' }), event()] },
      CUTOFF
    );

    expect(result.events).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });

  it('rejects malformed timestamps instead of coercing them', () => {
    const result = sanitizeImportRows(
      USER,
      {
        events: [
          event({ timestamp: '2026-03-01T10:00:00.000Z' }),
          event({ timestamp: 'now' }),
          event({ timestamp: 1790000000000 }),
          event({ timestamp: '2026-03-01 10:00:00' }),
        ],
      },
      CUTOFF
    );

    expect(result.events).toHaveLength(0);
    expect(result.rejected).toBe(4);
  });

  it('strips anything that could escape a ClickHouse string literal', () => {
    const { events } = sanitizeImportRows(
      USER,
      {
        events: [
          event({
            event_name: 'claude_code.tool_result',
            session_id: "s1') OR 1=1 --",
            tool_name: "Bash'; DROP TABLE events_raw; --",
          }),
        ],
      },
      CUTOFF
    );

    expect(events[0]!.session_id).toBe('s1OR11--');
    expect(events[0]!.tool_name).toBe('BashDROPTABLEevents_raw--');
    expect(JSON.stringify(events)).not.toContain("'");
  });

  it('never carries a prompt_length on rows that have no prompt', () => {
    const { events } = sanitizeImportRows(
      USER,
      { events: [event({ event_name: 'claude_code.tool_result', prompt_length: 500 })] },
      CUTOFF
    );
    expect(events[0]!.prompt_length).toBeUndefined();
  });

  it('survives a payload that is not even the right shape', () => {
    expect(sanitizeImportRows(USER, null, CUTOFF).events).toEqual([]);
    expect(sanitizeImportRows(USER, { events: 'nope' }, CUTOFF).events).toEqual([]);
    expect(sanitizeImportRows(USER, { events: [null, 7] }, CUTOFF).rejected).toBe(2);
  });
});

describe('the client cannot state a cost', () => {
  it('IGNORES a forged cost_usd and prices the row itself', () => {
    // The leaderboard is ranked on this number, so it is never the client's.
    const forged = apiRequest({ cost_usd: 40_000 });
    const { events } = sanitizeImportRows(USER, { events: [forged] }, CUTOFF);

    const expected = computeCostUsd('claude-opus-5', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 100 },
    }).costUsd;

    expect(events[0]!.cost_usd).toBeCloseTo(expected, 12);
    expect(events[0]!.cost_usd).toBeLessThan(1);
    expect(events[0]!.pricing_source).toBe('exact');
  });

  it('prices an unknown model through the shared fallback, not at zero', () => {
    const { events } = sanitizeImportRows(
      USER,
      { events: [apiRequest({ model: 'claude-from-the-future-9' })] },
      CUTOFF
    );
    expect(events[0]!.cost_usd).toBeGreaterThan(0);
    expect(events[0]!.pricing_source).toBe('fallback');
  });

  it('uses the 1h cache split when the client reports one, clamped to the total', () => {
    const allFlat = sanitizeImportRows(USER, { events: [apiRequest()] }, CUTOFF).events[0]!;
    const withSplit = sanitizeImportRows(
      USER,
      { events: [apiRequest({ cache_write_1h_tokens: 100 })] },
      CUTOFF
    ).events[0]!;

    // 1h cache writes cost more than 5m ones, so the split row is dearer.
    expect(withSplit.cost_usd!).toBeGreaterThan(allFlat.cost_usd!);

    // A 1h count larger than the total is clamped to the total, never beyond.
    const overclaimed = sanitizeImportRows(
      USER,
      { events: [apiRequest({ cache_write_1h_tokens: 1e9 })] },
      CUTOFF
    ).events[0]!;
    expect(overclaimed.cost_usd!).toBeCloseTo(withSplit.cost_usd!, 12);
  });

  it('clamps per-request token counts to a plausible maximum', () => {
    const { events, clamped } = sanitizeImportRows(
      USER,
      {
        events: [
          apiRequest({
            input_tokens: 1e12,
            output_tokens: 1e12,
            cache_read_tokens: 1e30,
            cache_write_tokens: 1e12,
          }),
        ],
      },
      CUTOFF
    );

    expect(events[0]!.input_tokens).toBe(MAX_INPUT_TOKENS_PER_REQUEST);
    expect(events[0]!.output_tokens).toBe(MAX_OUTPUT_TOKENS_PER_REQUEST);
    expect(events[0]!.cache_read_tokens).toBe(MAX_CACHE_TOKENS_PER_REQUEST);
    expect(events[0]!.cache_write_tokens).toBe(MAX_CACHE_TOKENS_PER_REQUEST);
    expect(clamped).toBe(1);
  });

  it('turns nonsense numbers into zero, not into the clamped maximum', () => {
    const { events } = sanitizeImportRows(
      USER,
      {
        events: [
          apiRequest({
            input_tokens: -5,
            output_tokens: 'lots',
            cache_read_tokens: Number.POSITIVE_INFINITY,
            cache_write_tokens: Number.NaN,
          }),
        ],
      },
      CUTOFF
    );

    expect(events[0]!.input_tokens).toBe(0);
    expect(events[0]!.output_tokens).toBe(0);
    expect(events[0]!.cache_read_tokens).toBe(0);
    expect(events[0]!.cache_write_tokens).toBe(0);
    expect(events[0]!.cost_usd).toBe(0);
  });
});

describe('metrics are derived, never accepted', () => {
  it('throws the client\'s metrics array away and counts it', () => {
    const { metrics, ignoredClientMetrics } = sanitizeImportRows(
      USER,
      {
        events: [],
        metrics: [
          { timestamp: '2026-03-01 10:00:00.000', metric_name: 'claude_code.cost.usage', value: 99999 },
          { timestamp: '2026-03-01 10:00:00.000', metric_name: 'claude_code.token.usage', token_type: 'input', value: 1e12 },
        ],
      },
      CUTOFF
    );

    expect(metrics).toEqual([]);
    expect(ignoredClientMetrics).toBe(2);
  });

  it('derives one token metric per non-zero counter, plus cost', () => {
    const { metrics } = sanitizeImportRows(USER, { events: [apiRequest()] }, CUTOFF);

    expect(metrics.map((m) => `${m.metric_name}:${m.token_type ?? ''}`).sort()).toEqual([
      'claude_code.cost.usage:',
      'claude_code.token.usage:cacheCreation',
      'claude_code.token.usage:cacheRead',
      'claude_code.token.usage:input',
      'claude_code.token.usage:output',
    ]);
    expect(metrics.every((m) => m.user_id === USER && m.provenance === 'import')).toBe(true);
  });

  it('omits a counter that is zero', () => {
    const { metrics } = sanitizeImportRows(
      USER,
      { events: [apiRequest({ cache_read_tokens: 0, cache_write_tokens: 0 })] },
      CUTOFF
    );
    expect(metrics.some((m) => m.token_type === 'cacheRead')).toBe(false);
    expect(metrics.some((m) => m.token_type === 'cacheCreation')).toBe(false);
  });

  it('derives rows that hash exactly like the shared mapper\'s', () => {
    // They must: provenance aside, a derived metric and a backfilled one are
    // the same datapoint, and they only collapse under ReplacingMergeTree if
    // their row ids agree.
    const opts: MapOptions = {
      userId: USER,
      provenance: 'import',
      sessionFallback: 'f',
      isSubagentFile: false,
      excludeBuiltinSlashPrompts: true,
    };
    const mapped = mapLine(
      {
        type: 'assistant',
        timestamp: '2026-03-01T10:00:01.500Z',
        sessionId: 'abc-123',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
        },
      },
      opts
    );

    const derived = sanitizeImportRows(USER, mapped, CUTOFF);

    expect(derived.metrics).toHaveLength(mapped.metrics.length);
    const key = (m: any) => `${m.timestamp}|${m.session_id}|${m.metric_name}|${m.token_type ?? ''}|${m.model}`;
    expect(derived.metrics.map(key).sort()).toEqual(mapped.metrics.map(key).sort());
  });
});

describe('built-in slash commands', () => {
  it('drops them server-side, whatever the client claims', () => {
    const result = sanitizeImportRows(
      USER,
      {
        events: [
          event({ command_source: 'builtin', command_name: 'clear' }),
          // command_source says custom, but /compact is a built-in: the name
          // is checked too, because the client mapper is not a guarantee.
          event({ command_source: 'custom', command_name: 'compact' }),
          event({ command_source: 'custom', command_name: 'code-review' }),
          event(),
        ],
      },
      CUTOFF
    );

    expect(result.skippedBuiltinCommand).toBe(2);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.command_name).toBe('code-review');
  });

  it('rejects a command_source it does not recognise', () => {
    const result = sanitizeImportRows(
      USER,
      { events: [event({ command_source: 'definitely-not-builtin' })] },
      CUTOFF
    );
    expect(result.rejected).toBe(1);
    expect(result.events).toHaveLength(0);
  });
});

describe('dropCoveredDays', () => {
  it('drops a whole UTC day that is already on record', () => {
    const rows = [
      { timestamp: '2026-03-01 10:00:00.000' },
      { timestamp: '2026-03-01 23:59:00.000' },
      { timestamp: '2026-03-02 00:00:00.000' },
    ];

    const { kept, skipped, days } = dropCoveredDays(rows, new Set(['2026-03-01']));

    expect(kept).toEqual([{ timestamp: '2026-03-02 00:00:00.000' }]);
    expect(skipped).toBe(2);
    expect(days).toEqual(['2026-03-01']);
  });
});

describe('dropDuplicates', () => {
  it('drops rows repeated inside the batch', () => {
    const { kept, skipped } = dropDuplicates(['a', 'a', 'b'], (row) => row);
    expect(kept).toEqual(['a', 'b']);
    expect(skipped).toBe(1);
  });
});

describe('runImport', () => {
  it('inserts once and then nothing — a re-import is a no-op', async () => {
    const store = stubStore();
    const payload = { events: [event(), apiRequest()] };

    const first = await runImport(USER, payload, store.deps);
    expect(first.inserted).toBeGreaterThan(0);
    expect(first.skippedCoveredDay).toBe(0);
    expect(store.events).toHaveLength(2);
    expect(store.metrics).toHaveLength(5);

    // The next RUN recomputes the covered days from ClickHouse, which now
    // holds 2026-03-01 — so the whole day is skipped.
    const second = stubStore(['2026-03-01']);
    const result = await runImport(USER, payload, second.deps);

    expect(result.inserted).toBe(0);
    expect(result.skippedCoveredDay).toBe(7);
    expect(result.skippedDays).toEqual(['2026-03-01']);
    expect(second.events).toHaveLength(0);
    expect(second.metrics).toHaveLength(0);
  });

  it('skips only the covered days, and reports which', async () => {
    const store = stubStore(['2026-03-01', '2026-03-03']);
    const result = await runImport(
      USER,
      {
        events: [
          event({ timestamp: '2026-03-01 10:00:00.000' }),
          event({ timestamp: '2026-03-02 10:00:00.000' }),
          event({ timestamp: '2026-03-03 10:00:00.000' }),
          event({ timestamp: '2026-03-04 10:00:00.000' }),
        ],
      },
      store.deps
    );

    expect(result.inserted).toBe(2);
    expect(result.skippedCoveredDay).toBe(2);
    expect(result.skippedDays).toEqual(['2026-03-01', '2026-03-03']);
    expect(store.events.map((e) => e.timestamp.slice(0, 10))).toEqual([
      '2026-03-02',
      '2026-03-04',
    ]);
  });

  it('skips a day held by ANY provenance, not just a previous import', async () => {
    // provenance is part of the row identity, so a row-id check cannot see
    // that the operator backfill, the daily_stats import or live telemetry
    // already counted this day. The date can.
    for (const day of ['2026-03-01']) {
      const store = stubStore([day]);
      const result = await runImport(USER, { events: [event(), apiRequest()] }, store.deps);
      expect(result.inserted).toBe(0);
      expect(store.events).toHaveLength(0);
    }
  });

  it('reports the cutoff it enforced', async () => {
    const store = stubStore();
    const result = await runImport(
      USER,
      { events: [event({ timestamp: '2026-06-01 00:00:00.000' })] },
      store.deps
    );

    expect(result.cutoff).toBe('2026-05-06T00:00:00.000Z');
    expect(result.inserted).toBe(0);
    expect(result.skippedAfterCutoff).toBe(1);
    expect(store.events).toHaveLength(0);
  });

  it('does not call the insert at all for an empty batch', async () => {
    let called = 0;
    const result = await runImport(USER, { events: [], metrics: [] }, {
      cutoffMs: CUTOFF,
      coveredDays: new Set(),
      insertEvents: async () => { called++; },
      insertMetrics: async () => { called++; },
    });

    expect(called).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it('round-trips rows straight out of the shared mapper', async () => {
    const opts: MapOptions = {
      userId: 'whatever-the-client-says',
      provenance: 'import',
      sessionFallback: 'f',
      isSubagentFile: false,
      excludeBuiltinSlashPrompts: true,
    };
    const mapped = mapLine(
      {
        type: 'assistant',
        timestamp: '2026-03-01T10:00:01.500Z',
        sessionId: 'abc-123',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
        },
      },
      opts
    );

    const store = stubStore();
    const result = await runImport(USER, mapped, store.deps);

    expect(result.rejected).toBe(0);
    expect(store.events.every((e) => e.user_id === USER)).toBe(true);
    expect(store.metrics.every((m) => (m as any).provenance === 'import')).toBe(true);
    // The client's metrics were ignored and ours derived in their place.
    expect(result.ignoredClientMetrics).toBe(mapped.metrics.length);
    expect(store.metrics).toHaveLength(mapped.metrics.length);
  });

  it('keeps two calls to the same tool in one message apart', async () => {
    const store = stubStore();
    const result = await runImport(
      USER,
      {
        events: [
          event({ event_name: 'claude_code.tool_result', tool_name: 'Read', tool_use_id: 'toolu_1' }),
          event({ event_name: 'claude_code.tool_result', tool_name: 'Read', tool_use_id: 'toolu_2' }),
        ],
      },
      store.deps
    );

    expect(result.inserted).toBe(2);
    expect(new Set(store.events.map(eventRowId)).size).toBe(2);
  });

  it('collapses two tool calls that are genuinely indistinguishable', async () => {
    const store = stubStore();
    const result = await runImport(
      USER,
      {
        events: [
          event({ event_name: 'claude_code.tool_result', tool_name: 'Read' }),
          event({ event_name: 'claude_code.tool_result', tool_name: 'Read' }),
        ],
      },
      store.deps
    );

    // Same millisecond, same tool, no tool_use_id to tell them apart: by the
    // row-identity definition these ARE one row, and inserting both would just
    // collapse under FINAL anyway.
    expect(result.inserted).toBe(1);
    expect(result.skippedDuplicate).toBe(1);
  });
});

describe('checkImportRate', () => {
  it('allows a full history and then throttles', () => {
    const user = `rate-test-${Math.random()}`;
    const now = Date.now();

    for (let i = 0; i < 300; i++) {
      expect(checkImportRate(user, now).ok).toBe(true);
    }
    const blocked = checkImportRate(user, now);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // A new window lets them back in.
    expect(checkImportRate(user, now + 11 * 60 * 1000).ok).toBe(true);
  });

  it('counts per user', () => {
    const now = Date.now();
    const a = `rate-a-${Math.random()}`;
    const b = `rate-b-${Math.random()}`;
    for (let i = 0; i < 301; i++) checkImportRate(a, now);
    expect(checkImportRate(a, now).ok).toBe(false);
    expect(checkImportRate(b, now).ok).toBe(true);
  });
});
