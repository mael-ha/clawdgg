import { describe, expect, it } from 'bun:test';
import { eventRowId, metricRowId } from '../../../src/db/clickhouse';
import {
  legacyRowsForDay,
  legacyTimestamp,
  type LegacyDay,
} from './2026-10-18_import_daily_stats';

const DAY: LegacyDay = {
  date: '2025-11-03',
  promptCount: 3,
  toolCallCount: 2,
  inputTokens: 1_000,
  outputTokens: 2_000,
  cacheReadTokens: 3_000,
  cacheCreationTokens: 4_000,
  costUsdCents: 1_234,
  linesWritten: 500,
  commitCount: 7,
  sessionCount: 4,
};

describe('legacyTimestamp', () => {
  it('lands at noon UTC in ClickHouse DateTime64(3) form', () => {
    expect(legacyTimestamp('2025-11-03')).toBe('2025-11-03 12:00:00.000');
  });

  it('offsets in milliseconds', () => {
    expect(legacyTimestamp('2025-11-03', 1)).toBe('2025-11-03 12:00:00.001');
    expect(legacyTimestamp('2025-11-03', 1500)).toBe('2025-11-03 12:00:01.500');
  });

  it('refuses an offset that would spill into the next day', () => {
    // A legacy row on the wrong date would double-count against a day OTEL owns.
    expect(() => legacyTimestamp('2025-11-03', 12 * 60 * 60 * 1000)).toThrow(/spill past midnight/);
  });

  it('rejects an unparseable date rather than emitting an Invalid Date', () => {
    expect(() => legacyTimestamp('not-a-date')).toThrow(/Unparseable/);
  });
});

describe('legacyRowsForDay', () => {
  const { metrics, events } = legacyRowsForDay('github_1', DAY);

  it('tags every row provenance=legacy', () => {
    for (const row of [...metrics, ...events]) {
      expect(row.provenance).toBe('legacy');
    }
  });

  it('emits one metric row per measure, summable by the existing queries', () => {
    const byKey = metrics.map(m => `${m.metric_name}/${m.token_type ?? ''}${m.line_type ?? ''}`);
    expect(byKey).toEqual([
      'claude_code.token.usage/input',
      'claude_code.token.usage/output',
      'claude_code.token.usage/cacheRead',
      'claude_code.token.usage/cacheCreation',
      'claude_code.cost.usage/',
      'claude_code.lines_of_code.count/added',
      'claude_code.commit.count/',
      'claude_code.session.count/',
    ]);
    expect(metrics.map(m => m.value)).toEqual([1000, 2000, 3000, 4000, 12.34, 500, 7, 4]);
  });

  it('converts cents to dollars', () => {
    const cost = metrics.find(m => m.metric_name === 'claude_code.cost.usage');
    expect(cost?.value).toBe(12.34);
  });

  it('emits one event per prompt and per tool call, because both are counted', () => {
    expect(events.filter(e => e.event_name === 'claude_code.user_prompt')).toHaveLength(3);
    expect(events.filter(e => e.event_name === 'claude_code.tool_result')).toHaveLength(2);
  });

  it('counts as prompts under PROMPT_EVENT_SQL (no command_source set)', () => {
    // The rule excludes command_source='builtin'; legacy rows leave it empty,
    // and the JSONL path they came from already dropped "/" prompts.
    for (const e of events.filter(e => e.event_name === 'claude_code.user_prompt')) {
      expect(e.command_source ?? '').toBe('');
    }
  });

  it('leaves unknown fields empty instead of inventing them', () => {
    for (const row of [...metrics, ...events]) {
      expect(row.session_id).toBe('');
      expect(row.model ?? '').toBe('');
    }
    for (const e of events.filter(e => e.event_name === 'claude_code.user_prompt')) {
      expect(e.prompt_length).toBe(0);
    }
  });

  it('gives every row of one kind a distinct identity', () => {
    // Same timestamp + same attributes = one row by definition, so N prompts
    // need N timestamps or the day collapses to a single prompt.
    const ids = new Set([...metrics.map(metricRowId), ...events.map(eventRowId)]);
    expect(ids.size).toBe(metrics.length + events.length);
  });

  it('is deterministic, so a re-run writes the same row_ids', () => {
    const again = legacyRowsForDay('github_1', DAY);
    expect(again.metrics.map(metricRowId)).toEqual(metrics.map(metricRowId));
    expect(again.events.map(eventRowId)).toEqual(events.map(eventRowId));
  });

  it('separates two users on the same day', () => {
    const other = legacyRowsForDay('github_2', DAY);
    expect(other.metrics.map(metricRowId)).not.toEqual(metrics.map(metricRowId));
  });

  it('skips zero measures rather than storing a measurement of nothing', () => {
    const empty = legacyRowsForDay('github_1', {
      date: '2025-11-04',
      promptCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsdCents: 0,
      linesWritten: 0,
      commitCount: 0,
      sessionCount: 0,
    });
    expect(empty.metrics).toHaveLength(0);
    expect(empty.events).toHaveLength(0);
  });

  it('keeps a day with prompts but no recorded tokens', () => {
    const sparse = legacyRowsForDay('github_1', { ...DAY, inputTokens: 0, outputTokens: 0 });
    expect(
      sparse.metrics.filter(m => m.metric_name === 'claude_code.token.usage').map(m => m.token_type)
    ).toEqual(['cacheRead', 'cacheCreation']);
    expect(sparse.events.filter(e => e.event_name === 'claude_code.user_prompt')).toHaveLength(3);
  });

  it('puts every row on the requested date', () => {
    for (const row of [...metrics, ...events]) {
      expect(row.timestamp.startsWith('2025-11-03 ')).toBe(true);
    }
  });
});
