import { describe, expect, it } from 'bun:test';
import {
  formatCost,
  formatDateLong,
  formatHours,
  formatNumber,
  formatRelativeTime,
  formatTokens,
} from './format';

describe('formatTokens', () => {
  it('leaves sub-thousand counts alone', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('rounds K — no decimal', () => {
    expect(formatTokens(1_000)).toBe('1K');
    expect(formatTokens(1_499)).toBe('1K');
    expect(formatTokens(1_500)).toBe('2K');
    expect(formatTokens(552_900)).toBe('553K');
  });

  it('switches scale at each thousand boundary', () => {
    expect(formatTokens(999_999)).toBe('1000K');
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(65_900_000)).toBe('65.9M');
    expect(formatTokens(1_000_000_000)).toBe('1.0B');
    expect(formatTokens(38_800_000_000)).toBe('38.8B');
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
