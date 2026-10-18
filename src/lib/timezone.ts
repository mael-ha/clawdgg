/**
 * The user's own wall clock.
 *
 * Every number this project shows about WHEN someone works — peak hour, the
 * weekday ring, "this week" — is meaningless in UTC. A 23:00 prompt in Paris is
 * a 22:00 prompt in UTC, and a Monday-morning one in Auckland is a Sunday
 * prompt in UTC: the figure is not merely shifted, it lands in the wrong bucket
 * and the wrong week. So the timezone is stored per user (`users.timezone`) and
 * every hour/weekday/week query converts with ClickHouse `toTimeZone`.
 *
 * Pure on purpose: no database, no ClickHouse. The CLI resolves the zone from
 * Intl and posts it; this file is what decides whether to believe it.
 */

export const DEFAULT_TIMEZONE = 'UTC';

/**
 * The zone name reaches ClickHouse SQL, so the charset is bounded BEFORE Intl
 * ever sees it. Intl is the real test — it knows the IANA database — but it is
 * a big surface to put a hostile string into, and a name that cannot hold a
 * quote cannot end a string literal early either.
 *
 * Covers every form in the IANA database: 'UTC', 'Europe/Paris',
 * 'America/Argentina/Buenos_Aires', 'Etc/GMT+5'.
 */
const TIMEZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/;

/** True for a name Intl recognises. Anything else is not stored. */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (!TIMEZONE_SHAPE.test(value)) return false;
  try {
    // Throws RangeError on an unknown zone. There is no cheaper check: the
    // alternative is shipping a copy of the IANA database and letting it rot.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A storable zone name, or UTC.
 *
 * Reads fall back rather than throw: a row written before this column existed,
 * or by a client that sent nonsense, must still render a profile. UTC is the
 * honest default — it is what the raw timestamps already are.
 */
export function normalizeTimezone(value: unknown): string {
  return isValidTimezone(value) ? value : DEFAULT_TIMEZONE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Week boundaries
// ─────────────────────────────────────────────────────────────────────────────

/** Minutes a zone is ahead of UTC at a given instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  // 'en-CA' gives ISO-ordered parts, and the 'longOffset' timeZoneName is the
  // only formatter output that states the offset rather than implying it.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  // 'GMT' alone means +00:00; otherwise 'GMT+02:00' / 'GMT-05:30'.
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/** The local wall-clock date/time of an instant, as plain numbers. */
function localParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: number; // 1 = Monday … 7 = Sunday
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekdays.indexOf(get('weekday')) + 1,
  };
}

/**
 * The UTC instant of a local wall-clock midnight.
 *
 * Done by guessing from the offset and then re-reading it at the guess, because
 * the offset at midnight is not always the offset at the instant you started
 * from — that is the entire DST problem. Two passes settle every real zone: the
 * second guess is already inside the correct offset regime.
 */
function localMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let instant = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
  instant = new Date(naive - offsetMinutes(instant, timeZone) * 60_000);
  return instant;
}

export interface WeekBounds {
  /** Inclusive start of the Monday, as a UTC instant. */
  start: Date;
  /** EXCLUSIVE end — the following Monday's local midnight. */
  end: Date;
}

/**
 * The Monday–Sunday week containing `instant`, in local time, expressed as UTC
 * instants so ClickHouse can compare them against raw `timestamp`.
 *
 * Mon–Sun because that is the week the owner asked for, and it is what most of
 * the world outside the US means by "this week". The end is exclusive: a
 * half-open range is the only one that cannot double-count the boundary
 * millisecond between two adjacent weeks.
 *
 * `weeksAgo` walks back whole local weeks: 1 is last week. It subtracts 7 LOCAL
 * days rather than 7×24 hours, so a week containing a DST transition is still
 * Monday-to-Monday rather than an hour short or long.
 */
export function weekBounds(instant: Date, timeZone: string, weeksAgo = 0): WeekBounds {
  const zone = normalizeTimezone(timeZone);
  const { year, month, day, weekday } = localParts(instant, zone);

  // Shift to the Monday of this local week, in local calendar days.
  const mondayOffset = weekday - 1 + weeksAgo * 7;
  const monday = new Date(Date.UTC(year, month - 1, day - mondayOffset));
  const next = new Date(Date.UTC(year, month - 1, day - mondayOffset + 7));

  return {
    start: localMidnightUtc(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
      zone
    ),
    end: localMidnightUtc(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      zone
    ),
  };
}

/** 'YYYY-MM' for the local calendar month of an instant. */
export function localMonth(instant: Date, timeZone: string): string {
  const { year, month } = localParts(instant, normalizeTimezone(timeZone));
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD HH:MM:SS.sss' for a ClickHouse DateTime64(3) comparison (UTC). */
export function toClickHouseTimestamp(instant: Date): string {
  return instant.toISOString().replace('T', ' ').replace('Z', '');
}
