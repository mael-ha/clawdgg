import { describe, expect, it } from 'bun:test';
import {
  dropDuplicates,
  runImport,
  sanitizeImportRows,
  type ImportDeps,
} from './cli';
import { mapLine, type MapOptions } from '../lib/session-import';
import {
  eventRowId,
  metricRowId,
  type EventRow,
  type MetricRow,
} from '../db/clickhouse';

const USER = 'github_1';
const CUTOFF = Date.parse('2026-05-06T00:00:00.000Z');

/**
 * A ClickHouse stand-in. It stores what was inserted under the same row_id the
 * real insert would compute, so the dedup path is exercised for real.
 */
function stubStore(seed: { events?: EventRow[]; metrics?: MetricRow[] } = {}) {
  const events: EventRow[] = [...(seed.events ?? [])];
  const metrics: MetricRow[] = [...(seed.metrics ?? [])];

  const deps: ImportDeps = {
    cutoffMs: CUTOFF,
    existingEventIds: async (ids) => {
      const have = new Set(events.map(eventRowId));
      return new Set(ids.filter((id) => have.has(id)));
    },
    existingMetricIds: async (ids) => {
      const have = new Set(metrics.map(metricRowId));
      return new Set(ids.filter((id) => have.has(id)));
    },
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

  it('rejects unknown event and metric names', () => {
    const result = sanitizeImportRows(
      USER,
      {
        events: [event({ event_name: 'claude_code.made_up' }), event()],
        metrics: [{ timestamp: '2026-03-01 10:00:00.000', metric_name: 'evil', value: 1 }],
      },
      CUTOFF
    );

    expect(result.events).toHaveLength(1);
    expect(result.metrics).toHaveLength(0);
    expect(result.rejected).toBe(2);
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

  it('clamps nonsense numbers', () => {
    const { events, metrics } = sanitizeImportRows(
      USER,
      {
        events: [
          event({
            event_name: 'claude_code.api_request',
            model: 'claude-opus-5',
            cost_usd: Number.POSITIVE_INFINITY,
            input_tokens: -5,
            output_tokens: 'lots',
            cache_read_tokens: 1e30,
          }),
        ],
        metrics: [
          {
            timestamp: '2026-03-01 10:00:00.000',
            metric_name: 'claude_code.token.usage',
            token_type: 'input',
            value: Number.NaN,
          },
        ],
      },
      CUTOFF
    );

    // Infinity is nonsense rather than "very large": it becomes 0, never a
    // clamped maximum that would inflate someone's spend.
    expect(events[0]!.cost_usd).toBe(0);
    expect(events[0]!.input_tokens).toBe(0);
    expect(events[0]!.output_tokens).toBe(0);
    expect(events[0]!.cache_read_tokens).toBe(1e12);
    expect(metrics[0]!.value).toBe(0);
  });

  it('keeps only known token types', () => {
    const { metrics } = sanitizeImportRows(
      USER,
      {
        metrics: [
          { timestamp: '2026-03-01 10:00:00.000', metric_name: 'claude_code.token.usage', token_type: 'input', value: 1 },
          { timestamp: '2026-03-01 10:00:00.000', metric_name: 'claude_code.token.usage', token_type: 'sneaky', value: 1 },
        ],
      },
      CUTOFF
    );

    expect(metrics.map((m) => m.token_type)).toEqual(['input', undefined]);
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

describe('dropDuplicates', () => {
  it('drops rows already stored and rows repeated inside the batch', () => {
    const rows = ['a', 'a', 'b'];
    const ids = (row: string) => [`${row}-own`, `${row}-alt`];

    const { kept, skipped } = dropDuplicates(rows, ids, new Set(['b-own']));

    expect(kept).toEqual(['a']);
    expect(skipped).toBe(2);
  });

  it('treats a match on any candidate id as already stored', () => {
    // 'b-alt' is the same row under another provenance.
    const { kept, skipped } = dropDuplicates(['b'], (r) => [`${r}-own`, `${r}-alt`], new Set(['b-alt']));

    expect(kept).toEqual([]);
    expect(skipped).toBe(1);
  });
});

describe('runImport', () => {
  it('inserts once and then nothing — a re-import is a no-op', async () => {
    const store = stubStore();
    const payload = {
      events: [
        event(),
        event({ event_name: 'claude_code.api_request', model: 'claude-opus-5', input_tokens: 10, cost_usd: 0.5 }),
      ],
      metrics: [
        { timestamp: '2026-03-01 10:00:00.000', session_id: 's1', metric_name: 'claude_code.token.usage', token_type: 'input', value: 10 },
      ],
    };

    const first = await runImport(USER, payload, store.deps);
    expect(first.inserted).toBe(3);
    expect(first.skippedDuplicate).toBe(0);
    expect(store.events).toHaveLength(2);
    expect(store.metrics).toHaveLength(1);

    const second = await runImport(USER, payload, store.deps);
    expect(second.accepted).toBe(3);
    expect(second.inserted).toBe(0);
    expect(second.skippedDuplicate).toBe(3);
    expect(store.events).toHaveLength(2);
    expect(store.metrics).toHaveLength(1);
  });

  it('reports the cutoff it enforced', async () => {
    const store = stubStore();
    const result = await runImport(USER, { events: [event({ timestamp: '2026-06-01 00:00:00.000' })] }, store.deps);

    expect(result.cutoff).toBe('2026-05-06T00:00:00.000Z');
    expect(result.inserted).toBe(0);
    expect(result.skippedAfterCutoff).toBe(1);
    expect(store.events).toHaveLength(0);
  });

  it('does not call the insert at all for an empty batch', async () => {
    let called = 0;
    const result = await runImport(USER, { events: [], metrics: [] }, {
      cutoffMs: CUTOFF,
      existingEventIds: async () => new Set(),
      existingMetricIds: async () => new Set(),
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
    expect(result.inserted).toBe(mapped.events.length + mapped.metrics.length);
    expect(store.events.every((e) => e.user_id === USER)).toBe(true);
    expect(store.metrics.every((m) => (m as any).provenance === 'import')).toBe(true);
  });

  it('inserts nothing for history the operator backfill already put in', async () => {
    // provenance is part of the row identity, so the same JSONL line hashes
    // differently as 'import' than as 'backfill'. Without the cross-provenance
    // check this would be a second copy of every row.
    const alreadyThere = {
      ...(sanitizeImportRows(USER, { events: [event()] }, CUTOFF).events[0] as unknown as EventRow),
      provenance: 'backfill' as const,
    };
    const store = stubStore({ events: [alreadyThere] });

    const result = await runImport(USER, { events: [event()] }, store.deps);

    expect(result.inserted).toBe(0);
    expect(result.skippedDuplicate).toBe(1);
    expect(store.events).toHaveLength(1);
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
