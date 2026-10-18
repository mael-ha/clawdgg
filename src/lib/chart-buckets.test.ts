import { describe, expect, it } from 'bun:test';
import { bucketKey, bucketLabel, bucketSql, type ChartGroupBy } from './chart-buckets';

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

describe('canonical key agreement between SQL and JS', () => {
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

