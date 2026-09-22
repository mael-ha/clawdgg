import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { bucketDailyRows, bucketKey, bucketLabel, bucketSql, type ChartGroupBy } from './chart-buckets';

// clickhouse.ts opens the SQLite dev DB at import time — send it somewhere disposable
process.env.DATABASE_PATH = join(tmpdir(), `clawdgg-chart-buckets-${process.pid}.db`);
const { mergeChartData } = await import('../db/clickhouse');

const DAY_MS = 86_400_000;

function addDays(dateStr: string, n: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * ClickHouse `toMonday` semantics derived from scratch: epoch day 0
 * (1970-01-01) was a Thursday, so a Monday is any day where
 * (epochDay - 4) % 7 === 0. Deliberately NOT sharing bucketKey's arithmetic —
 * this is the second opinion that catches the two paths drifting apart.
 */
function clickhouseWeekKey(dateStr: string): string {
  const epochDay = Math.round(Date.parse(`${dateStr}T00:00:00Z`) / DAY_MS);
  const sinceMonday = (((epochDay - 4) % 7) + 7) % 7;
  return new Date((epochDay - sinceMonday) * DAY_MS).toISOString().slice(0, 10);
}

/** ClickHouse `formatDateTime(toStartOfMonth(t), '%Y-%m')`. */
function clickhouseMonthKey(dateStr: string): string {
  return `${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}`;
}

interface SyntheticDay {
  date: string;
  dayCount: number; // sums to a day census — proves nothing is lost or double-counted
  promptCount: number;
  tokenCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdCents: number;
  linesWritten: number;
  commitCount: number;
}

const METRIC_FIELDS = [
  'dayCount',
  'promptCount',
  'tokenCount',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costUsdCents',
  'linesWritten',
  'commitCount',
] as const;

// 47 days spanning three months and seven week boundaries, values deterministic
// but uneven so a boundary slip can't cancel itself out.
const SYNTHETIC_START = '2026-05-20';
const SYNTHETIC_DAYS = Array.from({ length: 47 }, (_, i): SyntheticDay => {
  const n = i + 1;
  return {
    date: addDays(SYNTHETIC_START, i),
    dayCount: 1,
    promptCount: n * 3 + (n % 5),
    tokenCount: n * 1013 + 7,
    inputTokens: n * 211,
    outputTokens: n * 97 + 3,
    cacheReadTokens: n * 4001,
    cacheCreationTokens: n * 53,
    costUsdCents: n * 17 + (n % 7),
    linesWritten: n * 29,
    commitCount: n % 4,
  };
});

function sumField(rows: SyntheticDay[], field: keyof SyntheticDay): number {
  return rows.reduce((acc, row) => acc + (row[field] as number), 0);
}

describe('bucketKey', () => {
  it('keeps a Sunday and the following Monday in different weeks', () => {
    // 2026-06-01 is a Monday; 2026-06-07 the Sunday that closes that week
    expect(bucketKey('2026-06-07', 'week')).toBe('2026-06-01');
    expect(bucketKey('2026-06-08', 'week')).toBe('2026-06-08');
  });

  it('maps every day Monday..Sunday onto the same Monday', () => {
    for (let i = 0; i < 7; i++) {
      expect(bucketKey(addDays('2026-06-01', i), 'week')).toBe('2026-06-01');
    }
  });

  it('spans the year boundary on the ISO Monday', () => {
    expect(bucketKey('2025-12-29', 'week')).toBe('2025-12-29');
    expect(bucketKey('2026-01-04', 'week')).toBe('2025-12-29');
    expect(bucketKey('2026-01-05', 'week')).toBe('2026-01-05');
  });

  it('uses calendar months and passes days through', () => {
    expect(bucketKey('2026-06-30', 'month')).toBe('2026-06');
    expect(bucketKey('2026-07-01', 'month')).toBe('2026-07');
    expect(bucketKey('2026-07-01', 'day')).toBe('2026-07-01');
  });

  it('rejects a date it cannot parse instead of mis-bucketing it', () => {
    expect(() => bucketKey('not-a-date', 'week')).toThrow(/unparseable date/);
  });
});

describe('canonical key agreement between the two backends', () => {
  it('matches ClickHouse toMonday / toStartOfMonth over 800 days', () => {
    for (let i = 0; i < 800; i++) {
      const date = addDays('2024-11-15', i); // crosses two leap-year boundaries
      expect(bucketKey(date, 'week')).toBe(clickhouseWeekKey(date));
      expect(bucketKey(date, 'month')).toBe(clickhouseMonthKey(date));
      expect(bucketKey(date, 'day')).toBe(date);
    }
  });

  it('pins the ClickHouse expressions that mirror bucketKey', () => {
    expect(bucketSql('day')).toBe('toString(toDate(timestamp)) as date');
    expect(bucketSql('week')).toBe('toString(toMonday(timestamp)) as date');
    expect(bucketSql('month')).toBe(`formatDateTime(toStartOfMonth(timestamp), '%Y-%m') as date`);
  });
});

describe('bucketDailyRows reconciliation', () => {
  const byWeek = bucketDailyRows(SYNTHETIC_DAYS, 'week');
  const byMonth = bucketDailyRows(SYNTHETIC_DAYS, 'month');

  it('conserves every metric across week and month buckets', () => {
    for (const field of METRIC_FIELDS) {
      const daily = sumField(SYNTHETIC_DAYS, field);
      // Compared as an object so a failure names the field that drifted
      expect({ field, week: sumField(byWeek, field), month: sumField(byMonth, field) })
        .toEqual({ field, week: daily, month: daily });
    }
  });

  it('accounts for every day exactly once', () => {
    expect(sumField(byWeek, 'dayCount')).toBe(SYNTHETIC_DAYS.length);
    expect(sumField(byMonth, 'dayCount')).toBe(SYNTHETIC_DAYS.length);
  });

  it('returns buckets in chronological key order', () => {
    expect(byWeek.map(r => r.date)).toEqual([...byWeek.map(r => r.date)].sort());
    expect(byMonth.map(r => r.date)).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('puts a Sunday and the next Monday in separate week buckets', () => {
    const sunday = SYNTHETIC_DAYS.find(r => r.date === '2026-06-07')!;
    const monday = SYNTHETIC_DAYS.find(r => r.date === '2026-06-08')!;
    const closing = byWeek.find(r => r.date === '2026-06-01')!;
    const opening = byWeek.find(r => r.date === '2026-06-08')!;

    expect(closing.dayCount).toBe(7);
    expect(opening.dayCount).toBe(7);
    expect(closing.promptCount).toBeGreaterThanOrEqual(sunday.promptCount);
    expect(opening.promptCount).toBeGreaterThanOrEqual(monday.promptCount);
    expect(closing.promptCount + opening.promptCount).toBe(
      sumField(SYNTHETIC_DAYS.filter(r => r.date >= '2026-06-01' && r.date <= '2026-06-14'), 'promptCount')
    );
  });

  it('leaves day grouping untouched', () => {
    expect(bucketDailyRows(SYNTHETIC_DAYS, 'day')).toBe(SYNTHETIC_DAYS);
  });

  it('treats a partial leading bucket as partial, not as a whole week', () => {
    // 2026-05-20 is a Wednesday, so the first week bucket holds 5 days
    expect(byWeek[0]!.date).toBe('2026-05-18');
    expect(byWeek[0]!.dayCount).toBe(5);
  });
});

describe('bucketLabel', () => {
  it.each([
    ['day', '2026-06-02', 'Jun 2'],
    ['week', '2026-06-01', 'Jun 1–7'],
    ['week', '2026-06-29', 'Jun 29–Jul 5'],
    ['month', '2026-06', 'Jun 2026'],
  ] as Array<[ChartGroupBy, string, string]>)('formats a %s bucket', (groupBy, key, expected) => {
    expect(bucketLabel(key, groupBy)).toBe(expected);
  });
});

describe('mergeChartData', () => {
  const chart = (keys: string[], data: number[], hover?: Record<string, Record<string, number>>) => ({
    chartType: 'line' as const,
    keys,
    labels: keys.map(key => bucketLabel(key, 'week')),
    datasets: [{ label: 'Tokens', data, color: '#22d3ee' }],
    ...(hover && { hover }),
    summary: { total: 0, average: 0, peak: null, trend: '—' },
  });

  it('sums the bucket both backends contribute to instead of duplicating it', () => {
    const legacy = chart(['2026-05-25', '2026-06-01'], [100, 40]);
    const otel = chart(['2026-06-01', '2026-06-08'], [60, 500]);

    const merged = mergeChartData(legacy, otel);

    expect(merged.keys).toEqual(['2026-05-25', '2026-06-01', '2026-06-08']);
    expect(merged.datasets[0]!.data).toEqual([100, 100, 500]);
    expect(merged.summary.total).toBe(700);
  });

  it('sums the hover breakdown on a shared bucket', () => {
    const legacy = chart(['2026-06-01'], [40], { 'Jun 1–7': { input: 10, output: 30 } });
    const otel = chart(['2026-06-01'], [60], { 'Jun 1–7': { input: 25, output: 35 } });

    const merged = mergeChartData(legacy, otel);

    expect(merged.hover).toEqual({ 'Jun 1–7': { input: 35, output: 65 } });
  });

  it('orders merged buckets chronologically even when legacy runs late', () => {
    const legacy = chart(['2026-06-08'], [1]);
    const otel = chart(['2026-05-25', '2026-06-01'], [2, 3]);

    expect(mergeChartData(legacy, otel).keys).toEqual(['2026-05-25', '2026-06-01', '2026-06-08']);
  });

  it('pads legacy "Lines Added" into the dual-bar shape', () => {
    const legacy = {
      chartType: 'bar' as const,
      keys: ['2026-06-01'],
      labels: ['Jun 1–7'],
      datasets: [{ label: 'Lines Added', data: [80], color: '#22c55e' }],
      summary: { total: 80, average: 80, peak: null, trend: '—' },
    };
    const otel = {
      chartType: 'dualBar' as const,
      keys: ['2026-06-01', '2026-06-08'],
      labels: ['Jun 1–7', 'Jun 8–14'],
      datasets: [
        { label: 'Added', data: [20, 50], color: '#22c55e' },
        { label: 'Removed', data: [-5, -9], color: '#ef4444' },
      ],
      summary: { total: 56, average: 28, peak: null, trend: '—' },
    };

    const merged = mergeChartData(legacy, otel);

    expect(merged.chartType).toBe('dualBar');
    expect(merged.keys).toEqual(['2026-06-01', '2026-06-08']);
    expect(merged.datasets[0]!.data).toEqual([100, 50]);
    expect(merged.datasets[1]!.data).toEqual([-5, -9]);
  });
});
