/**
 * 🔥 is a run of DAYS AS THE USER LIVED THEM, and it is only that if both ends
 * of the comparison are in their clock.
 *
 * The active days have been local since clickhouse.getUserActiveLocalDays
 * existed. "Today" was not: it was `Date.now() / 86_400_000`, the UTC day
 * number, so the streak was decided by comparing a local calendar day with a
 * UTC one. The error is one day in one direction east of UTC and one day in the
 * other west of it, which is where these two cases come from.
 */

import { describe, expect, it } from 'bun:test';
import { calculateStreaks, syncKey } from './sync-clickhouse';
import { localDate } from '../lib/timezone';

/** What the broken version used: the UTC calendar day of the instant. */
function utcToday(instant: Date): string {
  return localDate(instant, 'UTC');
}

describe('calculateStreaks · the longest run', () => {
  it('counts the longest run of consecutive days', () => {
    const streaks = calculateStreaks(
      ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-09', '2026-10-10'],
      '2026-10-10'
    );
    expect(streaks.longestStreak).toBe(3);
    expect(streaks.currentStreak).toBe(2);
  });

  it('has nothing to count with no active days', () => {
    expect(calculateStreaks([], '2026-10-19')).toEqual({ currentStreak: 0, longestStreak: 0 });
  });

  it('ignores a repeated day and an unsorted set', () => {
    const streaks = calculateStreaks(
      ['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-03'],
      '2026-10-03'
    );
    expect(streaks).toEqual({ currentStreak: 3, longestStreak: 3 });
  });

  it('keeps a run alive on the morning after, and not the day after that', () => {
    // Yesterday counts: a day is not over until it is over.
    expect(calculateStreaks(['2026-10-17', '2026-10-18'], '2026-10-19').currentStreak).toBe(2);
    // Two days of silence is a broken run, and the longest one is remembered.
    const lapsed = calculateStreaks(['2026-10-16', '2026-10-17'], '2026-10-19');
    expect(lapsed.currentStreak).toBe(0);
    expect(lapsed.longestStreak).toBe(2);
  });
});

describe('calculateStreaks · a non-UTC user', () => {
  /**
   * Tokyo is UTC+9, so between local midnight and 09:00 the UTC date is still
   * YESTERDAY. A user who prompted at 08:00 on the 19th had a last active day
   * of the 19th and was compared against a "today" of the 18th — neither today
   * nor yesterday — so their run came back as ZERO while they were using it.
   */
  it('keeps a Tokyo streak alive before 09:00 local', () => {
    const zone = 'Asia/Tokyo';
    const instant = new Date('2026-10-18T23:00:00Z'); // 08:00 on the 19th, local
    const active = ['2026-10-17', '2026-10-18', '2026-10-19'];

    expect(localDate(instant, zone)).toBe('2026-10-19');
    expect(calculateStreaks(active, localDate(instant, zone)).currentStreak).toBe(3);

    // The old comparison, kept here so the case above cannot quietly stop
    // being a case: against a UTC "today" of the 18th, a last active day of
    // the 19th is neither today nor yesterday, and the run reads as zero.
    expect(utcToday(instant)).toBe('2026-10-18');
    expect(calculateStreaks(active, utcToday(instant)).currentStreak).toBe(0);
    // One prompt this morning, which is a streak of one and was a streak of
    // none — the shortest version of the same arithmetic.
    expect(calculateStreaks(['2026-10-19'], localDate(instant, zone)).currentStreak).toBe(1);
    expect(calculateStreaks(['2026-10-19'], utcToday(instant)).currentStreak).toBe(0);
  });

  /**
   * Los Angeles is UTC-7 in October, so from 17:00 local the UTC date is
   * already TOMORROW. A user who last prompted yesterday evening — still
   * inside the one day of grace a streak gets — was compared against a "today"
   * two days after their last active day, and lost the run.
   */
  it('keeps a Los Angeles streak alive in the evening', () => {
    const zone = 'America/Los_Angeles';
    const instant = new Date('2026-10-19T01:00:00Z'); // 18:00 on the 18th, local
    const active = ['2026-10-15', '2026-10-16', '2026-10-17'];

    expect(localDate(instant, zone)).toBe('2026-10-18');
    // Yesterday locally, so the run stands at three.
    expect(calculateStreaks(active, localDate(instant, zone)).currentStreak).toBe(3);

    // The old comparison: a UTC "today" of the 19th makes the last active day
    // the day before yesterday, and the run reads as broken.
    expect(utcToday(instant)).toBe('2026-10-19');
    expect(calculateStreaks(active, utcToday(instant)).currentStreak).toBe(0);
  });

  it('is unchanged for a user actually on UTC', () => {
    const instant = new Date('2026-10-19T12:00:00Z');
    const active = ['2026-10-18', '2026-10-19'];
    expect(calculateStreaks(active, localDate(instant, 'UTC')).currentStreak).toBe(2);
  });

  // A date string is a calendar date, so the numbering must not depend on the
  // machine's own zone — the sync job runs in a container set to UTC and is
  // developed on laptops that are not.
  it('numbers calendar days, not instants', () => {
    expect(
      calculateStreaks(['2026-02-28', '2026-03-01'], '2026-03-01').longestStreak
    ).toBe(2);
    // 2028 is a leap year: the 29th exists and the run is three days long.
    expect(
      calculateStreaks(['2028-02-28', '2028-02-29', '2028-03-01'], '2028-03-01')
    ).toEqual({ currentStreak: 3, longestStreak: 3 });
  });
});

describe('syncKey · what makes an unchanged user worth recomputing', () => {
  const base = syncKey('e=10:2026-10-20 10:00:00.000|m=5:2026-10-20 10:00:00.000', 'Europe/Paris', '2026-10-20', 3);

  it('is stable for the same inputs', () => {
    expect(syncKey('e=10:2026-10-20 10:00:00.000|m=5:2026-10-20 10:00:00.000', 'Europe/Paris', '2026-10-20', 3)).toBe(base);
  });

  it('moves with a new row, an old-timestamped import, a new day, a new zone and a new rank', () => {
    const variants = [
      syncKey('e=11:2026-10-20 10:05:00.000|m=5:2026-10-20 10:00:00.000', 'Europe/Paris', '2026-10-20', 3),
      syncKey('e=12:2026-10-20 10:00:00.000|m=5:2026-10-20 10:00:00.000', 'Europe/Paris', '2026-10-20', 3),
      syncKey('e=10:2026-10-20 10:00:00.000|m=5:2026-10-20 10:00:00.000', 'Europe/Paris', '2026-10-21', 3),
      syncKey('e=10:2026-10-20 10:00:00.000|m=5:2026-10-20 10:00:00.000', 'Asia/Tokyo', '2026-10-20', 3),
      syncKey('e=10:2026-10-20 10:00:00.000|m=5:2026-10-20 10:00:00.000', 'Europe/Paris', '2026-10-20', 2),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
  });
});
