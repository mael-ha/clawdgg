import { describe, expect, it } from 'bun:test';
import {
  compact,
  formatCost,
  formatDateLong,
  formatHours,
  formatNumber,
  formatRelativeTime,
  group,
  tidy,
} from './format';
import { compact as profileCompact, group as profileGroup } from '../components/profile/format';

/**
 * `compact` moved here from src/components/profile/format.ts when the 🪙 board
 * started printing a token count: two compact scales for one figure is how two
 * pages end up disagreeing about the same number. It replaces `formatTokens`,
 * which rounded K to the nearest thousand ("553K") and was the second answer.
 */
describe('compact', () => {
  it('groups a count below a thousand instead of abbreviating it', () => {
    expect(compact(0)).toBe('0');
    expect(compact(999)).toBe('999');
  });

  it('keeps one decimal and drops a pointless .0', () => {
    expect(compact(9_800)).toBe('9.8K');
    expect(compact(23_300)).toBe('23.3K');
    expect(compact(2_000)).toBe('2K');
    expect(compact(412_000_000)).toBe('412M');
  });

  // Losing the decimal at a boundary turns 3.7M into 4M, a different claim.
  it('switches scale at each thousand boundary', () => {
    expect(compact(1_000)).toBe('1K');
    expect(compact(999_999)).toBe('1000K');
    expect(compact(1_000_000)).toBe('1M');
    expect(compact(3_700_000)).toBe('3.7M');
    expect(compact(1_000_000_000)).toBe('1B');
    expect(compact(78_100_000_000)).toBe('78.1B');
  });

  it('never prints a negative magnitude', () => {
    expect(compact(-5_000)).toBe('0');
  });

  /** The profile's module is the same function, not a copy of it. */
  it('is the one the profile prints with', () => {
    expect(profileCompact).toBe(compact);
    expect(profileGroup).toBe(group);
  });
});

describe('group / tidy', () => {
  it('separates thousands without a locale', () => {
    expect(group(0)).toBe('0');
    expect(group(1_284)).toBe('1,284');
    expect(group(37_214_882_901)).toBe('37,214,882,901');
    expect(group(-1_284.6)).toBe('-1,285');
  });

  it('keeps a decimal only while it says something', () => {
    expect(tidy(3.74)).toBe('3.7');
    expect(tidy(4)).toBe('4');
    expect(tidy(4.04)).toBe('4');
  });
});

describe('formatNumber', () => {
  it('keeps one decimal at K', () => {
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1_000)).toBe('1.0K');
    expect(formatNumber(1_500)).toBe('1.5K');
    expect(formatNumber(224_500)).toBe('224.5K');
  });

  it('carries M and B', () => {
    expect(formatNumber(1_000_000)).toBe('1.0M');
    expect(formatNumber(526_600_000)).toBe('526.6M');
    expect(formatNumber(38_800_000_000)).toBe('38.8B');
  });
});

describe('formatCost', () => {
  it('takes cents, prints dollars', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(3)).toBe('$0.03');
    expect(formatCost(99)).toBe('$0.99');
    expect(formatCost(100)).toBe('$1');
    expect(formatCost(29_780)).toBe('$298');
  });

  it('abbreviates at a thousand dollars', () => {
    expect(formatCost(99_999)).toBe('$1000');
    expect(formatCost(100_000)).toBe('$1.0K');
    expect(formatCost(3_829_900)).toBe('$38.3K');
  });
});

describe('formatHours', () => {
  it('falls back to minutes under an hour', () => {
    expect(formatHours(0)).toBe('0m');
    expect(formatHours(59)).toBe('0m');
    expect(formatHours(60)).toBe('1m');
    expect(formatHours(3_599)).toBe('59m');
  });

  it('floors to whole hours', () => {
    expect(formatHours(3_600)).toBe('1h');
    expect(formatHours(2_278_800)).toBe('633h');
  });
});

describe('formatRelativeTime', () => {
  const ago = (ms: number) => new Date(Date.now() - ms);

  it('has no opinion about a missing date', () => {
    expect(formatRelativeTime(null)).toBe('');
  });

  it('walks the units', () => {
    expect(formatRelativeTime(ago(5_000))).toBe('now');
    expect(formatRelativeTime(ago(5 * 60_000))).toBe('5m');
    expect(formatRelativeTime(ago(3 * 3_600_000))).toBe('3h');
    expect(formatRelativeTime(ago(3 * 86_400_000))).toBe('3d');
    expect(formatRelativeTime(ago(20 * 86_400_000))).toBe('2w');
  });
});

describe('formatDateLong', () => {
  it('reads the key in UTC, not the viewer timezone', () => {
    // 2026-01-05T00:00Z is still Jan 4 in every timezone west of Greenwich —
    // local getters would print "January 4, 2026" for half the planet.
    expect(formatDateLong('2026-01-05')).toBe('January 5, 2026');
    expect(formatDateLong('2025-12-31')).toBe('December 31, 2025');
  });

  it('tolerates a full timestamp and gives up loudly on garbage', () => {
    expect(formatDateLong('2026-10-18T14:03:00Z')).toBe('October 18, 2026');
    expect(formatDateLong('not-a-date')).toBe('not-a-date');
  });
});
