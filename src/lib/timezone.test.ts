import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  localMonth,
  normalizeTimezone,
  toClickHouseTimestamp,
  weekBounds,
} from './timezone';

describe('isValidTimezone', () => {
  it('accepts every shape the IANA database actually uses', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/Paris')).toBe(true);
    expect(isValidTimezone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimezone('Etc/GMT+5')).toBe(true);
    expect(isValidTimezone('Pacific/Auckland')).toBe(true);
  });

  it('rejects a name Intl does not know', () => {
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimezone('Europe/Pariss')).toBe(false);
  });

  it('rejects anything that could end a SQL string literal', () => {
    expect(isValidTimezone("UTC' OR 1=1 --")).toBe(false);
    expect(isValidTimezone('UTC\\')).toBe(false);
    expect(isValidTimezone('UTC; DROP')).toBe(false);
    expect(isValidTimezone('Europe/Paris ')).toBe(false);
  });

  it('rejects non-strings, the empty string and absurd lengths', () => {
    expect(isValidTimezone(undefined)).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('A'.repeat(65))).toBe(false);
  });
});

describe('normalizeTimezone', () => {
  it('falls back to UTC rather than throwing on junk', () => {
    expect(normalizeTimezone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(normalizeTimezone('nonsense')).toBe(DEFAULT_TIMEZONE);
    expect(normalizeTimezone(null)).toBe('UTC');
  });
});

describe('weekBounds', () => {
  // Thursday 2026-10-15 12:00 UTC.
  const thursday = new Date('2026-10-15T12:00:00.000Z');

  it('runs Monday 00:00 to the next Monday 00:00, exclusive', () => {
    const { start, end } = weekBounds(thursday, 'UTC');
    expect(start.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('anchors on the LOCAL Monday, not the UTC one', () => {
    // 2026-10-12T00:30Z is already Monday in UTC but still Sunday in New York,
    // so the local week it belongs to is the one that starts on Oct 5.
    const sundayNight = new Date('2026-10-12T00:30:00.000Z');
    const ny = weekBounds(sundayNight, 'America/New_York');
    expect(ny.start.toISOString()).toBe('2026-10-05T04:00:00.000Z'); // 00:00 EDT
    expect(ny.end.toISOString()).toBe('2026-10-12T04:00:00.000Z');

    const utc = weekBounds(sundayNight, 'UTC');
    expect(utc.start.toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });

  it('keeps the offset of each end of a non-UTC week', () => {
    const paris = weekBounds(thursday, 'Europe/Paris');
    // CEST is UTC+2, so local midnight is 22:00 the previous UTC day.
    expect(paris.start.toISOString()).toBe('2026-10-11T22:00:00.000Z');
    expect(paris.end.toISOString()).toBe('2026-10-18T22:00:00.000Z');
  });

  it('spans 25 hours more than six days across a fall-back DST week', () => {
    // US DST ends Sunday 2026-11-01: that local week is 169 hours long.
    const dstWeek = weekBounds(new Date('2026-10-28T12:00:00.000Z'), 'America/New_York');
    expect(dstWeek.start.toISOString()).toBe('2026-10-26T04:00:00.000Z'); // 00:00 EDT
    expect(dstWeek.end.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // 00:00 EST
    const hours = (dstWeek.end.getTime() - dstWeek.start.getTime()) / 3_600_000;
    expect(hours).toBe(169);
  });

  it('is 167 hours long across a spring-forward DST week', () => {
    // US DST starts Sunday 2026-03-08.
    const dstWeek = weekBounds(new Date('2026-03-04T12:00:00.000Z'), 'America/New_York');
    expect(dstWeek.start.toISOString()).toBe('2026-03-02T05:00:00.000Z'); // 00:00 EST
    expect(dstWeek.end.toISOString()).toBe('2026-03-09T04:00:00.000Z'); // 00:00 EDT
    const hours = (dstWeek.end.getTime() - dstWeek.start.getTime()) / 3_600_000;
    expect(hours).toBe(167);
  });

  it('walks back whole LOCAL weeks, so last week abuts this one', () => {
    const thisWeek = weekBounds(thursday, 'Pacific/Auckland', 0);
    const lastWeek = weekBounds(thursday, 'Pacific/Auckland', 1);
    expect(lastWeek.end.toISOString()).toBe(thisWeek.start.toISOString());
  });

  it('abuts across a DST transition too, with no gap and no overlap', () => {
    // NZ DST starts Sunday 2026-09-27, inside the previous week.
    const after = new Date('2026-09-30T12:00:00.000Z');
    const thisWeek = weekBounds(after, 'Pacific/Auckland', 0);
    const lastWeek = weekBounds(after, 'Pacific/Auckland', 1);
    expect(lastWeek.end.getTime()).toBe(thisWeek.start.getTime());
    expect((thisWeek.start.getTime() - lastWeek.start.getTime()) / 3_600_000).toBe(167);
  });

  it('treats an unknown zone as UTC instead of failing', () => {
    expect(weekBounds(thursday, 'Nowhere/Nothing').start.toISOString()).toBe(
      '2026-10-12T00:00:00.000Z'
    );
  });
});

describe('localMonth', () => {
  it('reports the local calendar month, which can differ from the UTC one', () => {
    const newYearUtc = new Date('2027-01-01T02:00:00.000Z');
    expect(localMonth(newYearUtc, 'UTC')).toBe('2027-01');
    expect(localMonth(newYearUtc, 'America/New_York')).toBe('2026-12');
    expect(localMonth(newYearUtc, 'Pacific/Auckland')).toBe('2027-01');
  });
});

describe('toClickHouseTimestamp', () => {
  it('renders DateTime64(3) with its three fractional digits', () => {
    expect(toClickHouseTimestamp(new Date('2026-10-15T12:34:56.789Z'))).toBe(
      '2026-10-15 12:34:56.789'
    );
    expect(toClickHouseTimestamp(new Date('2026-10-15T00:00:00.000Z'))).toBe(
      '2026-10-15 00:00:00.000'
    );
  });
});
