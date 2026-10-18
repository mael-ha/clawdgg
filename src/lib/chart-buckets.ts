/**
 * Bucketing for the analytics chart (day / week / month).
 *
 * ClickHouse aggregates into buckets in SQL (bucketSql) and the chart labels
 * them in JS (bucketLabel). The two have to derive the SAME key for a day or a
 * bucket silently splits in two, so the key is defined ONCE, here:
 *
 *   day   → 'YYYY-MM-DD'
 *   week  → the ISO Monday's 'YYYY-MM-DD'   (ClickHouse `toMonday`)
 *   month → 'YYYY-MM'                       (ClickHouse `toStartOfMonth`)
 *
 * Everything is UTC: the ClickHouse `timestamp` column is bare/UTC.
 *
 * There was a third consumer, bucketDailyRows(), which re-bucketed SQLite
 * daily_stats rows in JS for the legacy chart path. That path is gone — the
 * pre-OTEL days are ClickHouse rows now — so the only bucketing left is SQL's.
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

