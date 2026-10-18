/**
 * Every number the UI prints goes through here — server components and client
 * islands both import this module, so a value can never be rendered one way on
 * the server and another way after hydration.
 *
 * Two compact scales, deliberately:
 *   formatTokens  — big counters (tokens, lines). K is rounded: "553K", not
 *                   "552.9K". Reads as a magnitude, which is all it is.
 *   formatNumber  — human counts (users, prompts, tool calls). K keeps one
 *                   decimal, because "1.5K prompts" and "2K prompts" are
 *                   different claims.
 * Both carry B, so a 38-billion-token total reads "38.8B" and not "38800.0M".
 */

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toString();
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Cost is stored in cents everywhere (users.total_cost_cents,
 * daily_stats.cost_usd_cents) — pass cents, never dollars.
 */
export function formatCost(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}K`;
  if (dollars >= 1) return `$${dollars.toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Active time, stored in seconds. */
export function formatHours(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.floor(seconds / 60)}m`;
}

/** "3m" / "5h" / "2d" / "6w" since `date`, or '' when there is no date. */
export function formatRelativeTime(date: Date | null): string {
  if (!date) return '';
  const diff = Date.now() - date.getTime();

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "January 5, 2026" from a 'YYYY-MM-DD' key. Read in UTC: every date key in
 * this app is UTC (see chart-buckets.ts), so local getters would show a
 * viewer west of Greenwich the previous day.
 */
export function formatDateLong(dateStr: string): string {
  const date = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateStr;
  return `${MONTHS_LONG[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}
