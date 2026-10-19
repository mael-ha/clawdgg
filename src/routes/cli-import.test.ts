import { describe, expect, it } from 'bun:test';
import cli, {
  buildImportCoverage,
  buildUltrathinkRow,
  checkImportRate,
  checkUltrathinkRate,
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
import {
  ULTRATHINK_EVENT_NAME,
  eventRowId,
  type EventRow,
  type MetricRow,
} from '../db/clickhouse';

const USER = 'github_1';
const CUTOFF = Date.parse('2026-05-06T00:00:00.000Z');

/**
 * The flag cutoff is LATER than the measured one, which is the whole point: the
 * window between them is the gap the hook never recorded and live telemetry
 * never could — see ImportDeps.flagCutoffMs.
 */
const FLAG_CUTOFF = Date.parse('2026-09-01T00:00:00.000Z');

/**
 * A ClickHouse stand-in. The two day-coverage sets are what the real endpoint
 * computes from the raw tables before the batch is processed.
 */
function stubStore(coveredDays: string[] = [], ultrathinkDays: string[] = []) {
  const events: EventRow[] = [];
  const metrics: MetricRow[] = [];

  const deps: ImportDeps = {
    cutoffMs: CUTOFF,
    flagCutoffMs: FLAG_CUTOFF,
    coveredDays: new Set(coveredDays),
    ultrathinkDays: new Set(ultrathinkDays),
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
      flagCutoffMs: FLAG_CUTOFF,
      coveredDays: new Set(),
      ultrathinkDays: new Set(),
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


// ═══════════════════════════════════════════════════════════════════════════
// The ultrathink flag
// ═══════════════════════════════════════════════════════════════════════════

const ultrathinkEvent = (overrides: Record<string, unknown> = {}) => ({
  timestamp: '2026-03-01 10:00:00.000',
  session_id: 's1',
  event_name: ULTRATHINK_EVENT_NAME,
  ...overrides,
});

describe('sanitizeImportRows — ultrathink flags', () => {
  it('accepts a flag and stamps it as imported', () => {
    const { events, rejected } = sanitizeImportRows(USER, { events: [ultrathinkEvent()] }, CUTOFF);
    expect(rejected).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_name).toBe(ULTRATHINK_EVENT_NAME);
    expect(events[0]!.provenance).toBe('import');
    expect(events[0]!.user_id).toBe(USER);
  });

  // The row has no payload at all beyond when and where. Anything a client
  // tried to attach must not survive, least of all a prompt or its length.
  it('keeps nothing a client attaches to a flag', () => {
    const { events } = sanitizeImportRows(
      USER,
      {
        events: [
          ultrathinkEvent({
            prompt_length: 9999,
            model: 'claude-opus-5',
            cost_usd: 1000,
            input_tokens: 1e9,
            prompt: 'the secret text',
          }),
        ],
      },
      CUTOFF
    );
    const row = events[0]!;
    expect(row.prompt_length).toBeUndefined();
    expect(row.cost_usd).toBeUndefined();
    expect(row.input_tokens).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('derives no cost or token metrics from a flag', () => {
    const { metrics } = sanitizeImportRows(USER, { events: [ultrathinkEvent()] }, CUTOFF);
    expect(metrics).toEqual([]);
  });

  it('still refuses a flag predating Claude Code', () => {
    const early = sanitizeImportRows(
      USER,
      { events: [ultrathinkEvent({ timestamp: '2024-01-01 10:00:00.000' })] },
      CUTOFF,
      FLAG_CUTOFF
    );
    expect(early.skippedBeforeEpoch).toBe(1);
  });

  /**
   * THE COVERAGE GAP. A flag between the measured cutoff and the flag cutoff is
   * in the window live telemetry never carried a flag for and the hook was not
   * installed yet — the import is the only source there is, and judging it by
   * the prompt cutoff made that window permanently unrecordable.
   */
  it('accepts a flag past the measured cutoff but before the flag cutoff', () => {
    const inGap = sanitizeImportRows(
      USER,
      {
        events: [
          ultrathinkEvent({ timestamp: '2026-06-01 10:00:00.000' }),
          event({ timestamp: '2026-06-01 10:00:00.000' }),
        ],
      },
      CUTOFF,
      FLAG_CUTOFF
    );
    // The flag is in; the PROMPT beside it, on the same day, is not.
    expect(inGap.events.map((row) => row.event_name)).toEqual([ULTRATHINK_EVENT_NAME]);
    expect(inGap.skippedAfterCutoff).toBe(1);
    expect(inGap.skippedAfterFlagCutoff).toBe(0);
  });

  it('refuses a flag past the flag cutoff, where the hook was already running', () => {
    const late = sanitizeImportRows(
      USER,
      { events: [ultrathinkEvent({ timestamp: '2026-10-01 10:00:00.000' })] },
      CUTOFF,
      FLAG_CUTOFF
    );
    expect(late.events).toEqual([]);
    expect(late.skippedAfterFlagCutoff).toBe(1);
    expect(late.skippedAfterCutoff).toBe(0);
  });

  it('falls back to the measured cutoff when told nothing else', () => {
    // The default exists so a caller that has not been taught the difference
    // cannot widen the window by forgetting an argument.
    const late = sanitizeImportRows(
      USER,
      { events: [ultrathinkEvent({ timestamp: '2026-06-01 10:00:00.000' })] },
      CUTOFF
    );
    expect(late.skippedAfterFlagCutoff).toBe(1);
  });
});

describe('runImport — flags answer to their own coverage set', () => {
  /**
   * The case that matters: everyone who imported before the counter existed has
   * every day already covered for prompts. Judging flags by that set would mean
   * their ultrathink count could never be filled in.
   */
  it('inserts a flag on a day already covered for prompts', async () => {
    const store = stubStore(['2026-03-01'], []);
    const result = await runImport(
      USER,
      { events: [event(), ultrathinkEvent()] },
      store.deps
    );

    expect(store.events.map((e) => e.event_name)).toEqual([ULTRATHINK_EVENT_NAME]);
    expect(result.skippedCoveredDay).toBe(1); // the prompt, not the flag
  });

  it('skips a flag on a day that already holds one', async () => {
    const store = stubStore([], ['2026-03-01']);
    const result = await runImport(USER, { events: [ultrathinkEvent()] }, store.deps);

    expect(store.events).toEqual([]);
    expect(result.skippedCoveredDay).toBe(1);
  });

  it('is a no-op run twice, because the row identity is deterministic', async () => {
    const first = stubStore();
    await runImport(USER, { events: [ultrathinkEvent()] }, first.deps);
    expect(first.events).toHaveLength(1);

    // Same batch again, now that the day holds a flag.
    const second = stubStore([], ['2026-03-01']);
    await runImport(USER, { events: [ultrathinkEvent()] }, second.deps);
    expect(second.events).toEqual([]);

    // And even without the day guard, the identity collapses it.
    expect(eventRowId(first.events[0]!)).toBe(
      eventRowId({ ...first.events[0]!, session_id: 's1' })
    );
  });

  it('drops a flag duplicated inside one batch', async () => {
    const store = stubStore();
    const result = await runImport(
      USER,
      { events: [ultrathinkEvent(), ultrathinkEvent()] },
      store.deps
    );
    expect(store.events).toHaveLength(1);
    expect(result.skippedDuplicate).toBe(1);
  });
});

describe('buildUltrathinkRow', () => {
  const NOW = Date.parse('2026-10-18T09:00:00.000Z');

  it('builds a row from the flag, the session and the time', () => {
    const built = buildUltrathinkRow(
      USER,
      { session_id: 's1', timestamp: '2026-10-18T08:59:30.250Z', ultrathink: true },
      NOW
    );
    expect('row' in built).toBe(true);
    if (!('row' in built)) return;
    expect(built.row).toEqual({
      timestamp: '2026-10-18 08:59:30.250',
      user_id: USER,
      session_id: 's1',
      event_name: ULTRATHINK_EVENT_NAME,
      provenance: 'hook',
    });
  });

  it('refuses a report that does not claim the flag', () => {
    expect(buildUltrathinkRow(USER, { timestamp: '2026-10-18T09:00:00.000Z' }, NOW)).toHaveProperty(
      'error'
    );
    expect(
      buildUltrathinkRow(USER, { timestamp: '2026-10-18T09:00:00.000Z', ultrathink: 'yes' }, NOW)
    ).toHaveProperty('error');
    expect(buildUltrathinkRow(USER, {}, NOW)).toHaveProperty('error');
    expect(buildUltrathinkRow(USER, null, NOW)).toHaveProperty('error');
  });

  it.each([
    ['not a date', 'nonsense'],
    ['a number', 1_760_000_000_000 as unknown as string],
    ['nothing', undefined as unknown as string],
  ])('refuses %s as a timestamp', (_label, timestamp) => {
    expect(buildUltrathinkRow(USER, { timestamp, ultrathink: true }, NOW)).toHaveProperty('error');
  });

  // A flag in the future would park itself in a week that has not happened and
  // move the header figure when it arrives.
  it('refuses a timestamp beyond the clock slack, and one predating Claude Code', () => {
    expect(
      buildUltrathinkRow(USER, { timestamp: '2026-10-18T09:30:00.000Z', ultrathink: true }, NOW)
    ).toHaveProperty('error');
    expect(
      buildUltrathinkRow(USER, { timestamp: '2024-01-01T00:00:00.000Z', ultrathink: true }, NOW)
    ).toHaveProperty('error');
  });

  it('allows a small amount of clock skew, in either direction', () => {
    expect(
      buildUltrathinkRow(USER, { timestamp: '2026-10-18T09:05:00.000Z', ultrathink: true }, NOW)
    ).toHaveProperty('row');
    expect(
      buildUltrathinkRow(USER, { timestamp: '2026-10-18T08:55:00.000Z', ultrathink: true }, NOW)
    ).toHaveProperty('row');
  });

  /**
   * The endpoint is for a prompt being typed NOW. It used to accept anything
   * back to 2025-02-01, which made it a history endpoint with no coverage
   * check — and since a row's identity is its timestamp, varying the
   * millisecond produced unlimited distinct flags on any day of the past year.
   * History goes through /import, which dedupes against what is covered.
   */
  it('refuses history, however plausible the date', () => {
    for (const timestamp of [
      '2026-10-18T08:00:00.000Z', // an hour ago
      '2026-10-17T09:00:00.000Z', // yesterday
      '2026-06-01T09:00:00.000Z', // in the coverage gap, where /import belongs
    ]) {
      const built = buildUltrathinkRow(USER, { timestamp, ultrathink: true }, NOW);
      expect(built).toHaveProperty('error');
      if ('error' in built) expect(built.error).toContain('import');
    }
  });

  it('never takes the user id from the payload', () => {
    const built = buildUltrathinkRow(
      USER,
      { user_id: 'github_someone_else', timestamp: '2026-10-18T09:00:00.000Z', ultrathink: true },
      NOW
    );
    if (!('row' in built)) throw new Error('expected a row');
    expect(built.row.user_id).toBe(USER);
  });

  it('reduces a session id to a charset that cannot carry SQL', () => {
    const built = buildUltrathinkRow(
      USER,
      { session_id: "s1'; DROP TABLE events_raw --", timestamp: '2026-10-18T09:00:00.000Z', ultrathink: true },
      NOW
    );
    if (!('row' in built)) throw new Error('expected a row');
    expect(built.row.session_id).toBe('s1DROPTABLEevents_raw--');
  });
});

describe('checkUltrathinkRate', () => {
  it('allows a normal prompt rate and stops a loop', () => {
    const user = `rate_${Math.random()}`;
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      expect(checkUltrathinkRate(user, now).ok).toBe(true);
    }
    const blocked = checkUltrathinkRate(user, now);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('opens a fresh window after the old one passes', () => {
    const user = `rate_${Math.random()}`;
    const now = Date.now();
    for (let i = 0; i < 61; i++) checkUltrathinkRate(user, now);
    expect(checkUltrathinkRate(user, now + 61_000).ok).toBe(true);
  });

  it('counts each user separately', () => {
    const now = Date.now();
    const a = `rate_a_${Math.random()}`;
    const b = `rate_b_${Math.random()}`;
    for (let i = 0; i < 61; i++) checkUltrathinkRate(a, now);
    expect(checkUltrathinkRate(a, now).ok).toBe(false);
    expect(checkUltrathinkRate(b, now).ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/cli/import/coverage
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/cli/import/coverage', () => {
  it('refuses a request with no bearer token', async () => {
    const response = await cli.request('http://localhost/import/coverage');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'Unauthorized' });
  });

  it('refuses a cookie session, like every other /api/cli route', async () => {
    const response = await cli.request('http://localhost/import/coverage', {
      headers: { cookie: 'session=whatever' },
    });
    expect(response.status).toBe(401);
  });

  it('refuses a bearer token that is not one of ours', async () => {
    const response = await cli.request('http://localhost/import/coverage', {
      headers: { Authorization: 'Bearer not-a-clawdgg-token' },
    });
    expect(response.status).toBe(401);
  });

  it('answers with sorted day lists and both cutoffs as ISO instants', () => {
    const body = buildImportCoverage(
      {
        days: new Set(['2026-03-02', '2026-01-01', '2026-02-01']),
        ultrathinkDays: new Set(['2026-02-01']),
      },
      CUTOFF,
      FLAG_CUTOFF
    );

    expect(body).toEqual({
      days: ['2026-01-01', '2026-02-01', '2026-03-02'],
      ultrathinkDays: ['2026-02-01'],
      cutoff: '2026-05-06T00:00:00.000Z',
      flagCutoff: '2026-09-01T00:00:00.000Z',
    });
  });

  it('keeps the two day sets apart, because the guard does', () => {
    // A day with a flag on it but no measured row is NOT covered for prompts,
    // and a day with prompts on it is NOT covered for flags. Collapsing them
    // is the bug ImportDeps.ultrathinkDays exists to prevent.
    const body = buildImportCoverage(
      { days: new Set(['2026-01-01']), ultrathinkDays: new Set(['2026-02-02']) },
      CUTOFF,
      FLAG_CUTOFF
    );
    expect(body.days).toEqual(['2026-01-01']);
    expect(body.ultrathinkDays).toEqual(['2026-02-02']);
  });

  it('reports exactly the set the import guard then drops rows by', async () => {
    // The point of the endpoint: a day the preview calls covered is a day the
    // import skips whole, and a day it does not is a day the import keeps. Both
    // halves asserted through the real guard, so the two cannot drift.
    const covered = ['2026-03-01'];
    const uncovered = '2026-03-02';
    const { deps, events } = stubStore(covered, covered);

    const body = buildImportCoverage(
      { days: deps.coveredDays, ultrathinkDays: deps.ultrathinkDays },
      deps.cutoffMs,
      deps.flagCutoffMs
    );

    const result = await runImport(
      USER,
      {
        events: [
          event({ timestamp: '2026-03-01 10:00:00.000' }),
          event({ timestamp: `${uncovered} 10:00:00.000` }),
          event({ timestamp: '2026-03-01 11:00:00.000', event_name: ULTRATHINK_EVENT_NAME }),
          event({ timestamp: `${uncovered} 11:00:00.000`, event_name: ULTRATHINK_EVENT_NAME }),
        ],
      },
      deps
    );

    for (const day of body.days) expect(covered).toContain(day);
    expect(body.days).not.toContain(uncovered);
    expect(result.skippedCoveredDay).toBe(2);
    expect(events.map((row) => row.timestamp.slice(0, 10))).toEqual([uncovered, uncovered]);
  });

  it('states the flag cutoff separately, because flags answer to their own', () => {
    const body = buildImportCoverage(
      { days: new Set(), ultrathinkDays: new Set() },
      CUTOFF,
      FLAG_CUTOFF
    );
    expect(Date.parse(body.flagCutoff)).toBeGreaterThan(Date.parse(body.cutoff));
  });
});
