/**
 * Bucketing for the analytics chart (day / week / month).
 *
 * Two backends feed one chart — ClickHouse (OTEL) aggregates in SQL, SQLite
 * `daily_stats` (legacy) is re-bucketed here in JS — and mergeChartData aligns
 * them on the bucket key. If the two derive different keys for the same day,
 * one bucket silently splits in two, so the key is defined ONCE, here:
 *
 *   day   → 'YYYY-MM-DD'
 *   week  → the ISO Monday's 'YYYY-MM-DD'   (ClickHouse `toMonday`)
 *   month → 'YYYY-MM'                       (ClickHouse `toStartOfMonth`)
 *
 * Everything is UTC: the ClickHouse `timestamp` column is bare/UTC and
 * `daily_stats.date` is a UTC 'YYYY-MM-DD'.
 */

export type ChartGroupBy = 'day' | 'week' | 'month';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDate(dateStr: string): Date {
  const date = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`chart-buckets: unparseable date '${dateStr}'`);
  }
  return date;
}

/**
 * Canonical bucket key for a UTC 'YYYY-MM-DD' date.
 * Keys sort chronologically as plain strings — merging relies on that.
 */
export function bucketKey(dateStr: string, groupBy: ChartGroupBy): string {
  if (groupBy === 'month') return utcDate(dateStr).toISOString().slice(0, 7);
  if (groupBy === 'day') return utcDate(dateStr).toISOString().slice(0, 10);

  const date = utcDate(dateStr);
  // getUTCDay(): 0 = Sunday, so Sunday walks back 6 days, Monday walks back 0.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/**
 * ClickHouse expression yielding the same key as bucketKey, aliased `date`.
 */
export function bucketSql(groupBy: ChartGroupBy): string {
  switch (groupBy) {
    case 'week':
      return 'toString(toMonday(timestamp)) as date';
    case 'month':
      return `formatDateTime(toStartOfMonth(timestamp), '%Y-%m') as date`;
    default:
      return 'toString(toDate(timestamp)) as date';
  }
}

/**
 * Display label for a bucket key (e.g. "Jun 2", "Jun 2–8", "Jun 2026").
 */
export function bucketLabel(key: string, groupBy: ChartGroupBy): string {
  if (groupBy === 'month') {
    const [year, month] = key.split('-');
    return `${MONTHS[Number(month) - 1]} ${year}`;
  }

  const start = utcDate(key);
  const startLabel = `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}`;
  if (groupBy === 'day') return startLabel;

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${startLabel}–${end.getUTCDate()}`
    : `${startLabel}–${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`;
}

/**
 * Collapse per-day rows into week/month buckets, summing every numeric column.
 * `date` becomes the canonical bucket key; rows come back in key order.
 * Used by the legacy path, where SQLite already stores one row per day.
 */
export function bucketDailyRows<T extends { date: string }>(rows: T[], groupBy: ChartGroupBy): T[] {
  if (groupBy === 'day') return rows;

  const buckets = new Map<string, T>();
  for (const row of rows) {
    const key = bucketKey(row.date, groupBy);
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { ...row, date: key });
      continue;
    }
    for (const [field, value] of Object.entries(row)) {
      if (field === 'date' || typeof value !== 'number') continue;
      const acc = bucket as Record<string, unknown>;
      acc[field] = (typeof acc[field] === 'number' ? (acc[field] as number) : 0) + value;
    }
  }

  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}
