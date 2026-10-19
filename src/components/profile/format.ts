/**
 * How the fingerprint prints a number.
 *
 * `group`, `tidy` and `compact` live in src/lib/format.ts and are re-exported
 * here, because the 🪙 board prints a token count too and two compact scales
 * for one figure is how two pages end up disagreeing about the same number.
 * What stays here is what only the profile asks — value at three magnitudes, a
 * per-prompt figure, a ratio, the date and clock labels — answered the same way
 * on the server, in the chart island and on the share card.
 *
 * Nothing here consults a locale: `toLocaleString` would group digits
 * differently for the server and for a visitor's browser, and the hydrated
 * chart would then disagree with the page it is drawn on.
 */

import { group, tidy } from '../../lib/format';

export { compact, group } from '../../lib/format';

/**
 * API-equivalent value, in DOLLARS (not cents — `claude_code.cost.usage` is
 * USD and so is everything on this page).
 *
 * Three scales, because the page prints this at three magnitudes and each one
 * is a different claim: $1.13 per prompt needs its cents, $1,284 this week
 * needs its digits, and $38.3K all time needs neither.
 */
export function money(dollars: number): string {
  const n = Math.max(0, dollars);
  if (n >= 1_000_000) return `$${tidy(n / 1_000_000)}M`;
  if (n >= 10_000) return `$${tidy(n / 1_000)}K`;
  if (n >= 10) return `$${group(n)}`;
  if (n === 0) return '$0';
  return `$${n.toFixed(2)}`;
}

/** A percentage, with a decimal only while it still means something. */
export function pct(value: number, decimals = 0): string {
  return `${value.toFixed(decimals)}%`;
}

/** The ratio in "151× for every character you type". */
export function times(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value >= 10 ? group(value) : tidy(value);
}

/** A per-prompt figure: 9.6 tool calls, 36 lines, 170 chars. */
export function perPrompt(value: number): string {
  if (value >= 100) return group(value);
  if (value >= 10) return tidy(value);
  return value.toFixed(1);
}

export interface Delta {
  arrow: '▲' | '▼';
  text: string;
  up: boolean;
}

/** "▲ 12%", or nothing at all when there is no week to compare against. */
export function delta(deltaPct: number | null): Delta | null {
  if (deltaPct === null || !Number.isFinite(deltaPct)) return null;
  const rounded = Math.round(deltaPct);
  if (rounded === 0) return null;
  return {
    arrow: rounded > 0 ? '▲' : '▼',
    text: `${Math.abs(rounded)}%`,
    up: rounded > 0,
  };
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * "Sep 30 ’26" from a 'YYYY-MM-DD' key, read in UTC.
 *
 * UTC on purpose: every date key on this page is a calendar day, not an
 * instant, and local getters would show a reader west of Greenwich the day
 * before the one the key names.
 */
export function dayLabel(date: string, withYear = true): string {
  const ms = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  const d = new Date(ms);
  const base = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
  return withYear ? `${base} ’${String(d.getUTCFullYear()).slice(2)}` : base;
}

/** "Oct ’26" from a 'YYYY-MM' key. */
export function monthLabel(month: string): string {
  const [year, index] = month.split('-');
  const name = MONTHS[Number(index) - 1];
  if (!name || !year) return month;
  return `${name} ’${year.slice(2)}`;
}

/** "2d 4h", "4h 10m", "9m" — the coarsest two units that still say something. */
export function countdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "20:00" from a unix epoch in seconds, in `timeZone`. */
export function clockAt(epochSeconds: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(new Date(epochSeconds * 1000));
  } catch {
    return '';
  }
}

/** "Sun 20:00" — the weekday matters for a seven-day window, not a five-hour one. */
export function weekdayClockAt(epochSeconds: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(new Date(epochSeconds * 1000));
  } catch {
    return '';
  }
}
