import { describe, expect, it } from 'bun:test';
import {
  normalizeEpochSeconds,
  parseRateLimits,
  shouldInsertSnapshot,
  PLAN_USAGE_HEARTBEAT_SECONDS,
  type ParsedPlanUsageWindow,
} from './plan-usage';

const FULL_PAYLOAD = {
  five_hour: { used_percentage: 42.5, resets_at: 1790000000 },
  seven_day: { used_percentage: 13, resets_at: 1790400000 },
  spend_limit: { used_percentage: 0, resets_at: 1792000000 },
};

describe('parseRateLimits', () => {
  it('parses a full payload', () => {
    const { windows, rejected } = parseRateLimits(FULL_PAYLOAD);
    expect(rejected).toEqual([]);
    expect(windows).toEqual([
      { windowType: 'five_hour', usedPercentage: 42.5, resetsAt: 1790000000 },
      { windowType: 'seven_day', usedPercentage: 13, resetsAt: 1790400000 },
      { windowType: 'spend_limit', usedPercentage: 0, resetsAt: 1792000000 },
    ]);
  });

  it('parses a partial payload, ignoring absent windows', () => {
    const { windows, rejected } = parseRateLimits({
      seven_day: { used_percentage: 77.25, resets_at: 1790400000 },
    });
    expect(rejected).toEqual([]);
    expect(windows).toEqual([
      { windowType: 'seven_day', usedPercentage: 77.25, resetsAt: 1790400000 },
    ]);
  });

  it('returns nothing for an absent rate_limits object', () => {
    for (const raw of [undefined, null, {}, 'nope', 42, []]) {
      expect(parseRateLimits(raw)).toEqual({ windows: [], rejected: [] });
    }
  });

  it('rejects out-of-range percentages instead of clamping them', () => {
    const { windows, rejected } = parseRateLimits({
      five_hour: { used_percentage: 101, resets_at: 1790000000 },
      seven_day: { used_percentage: -1, resets_at: 1790000000 },
      spend_limit: { used_percentage: 50, resets_at: 1790000000 },
    });
    expect(rejected).toEqual(['five_hour', 'seven_day']);
    expect(windows).toEqual([
      { windowType: 'spend_limit', usedPercentage: 50, resetsAt: 1790000000 },
    ]);
  });

  it('rejects non-numeric percentages', () => {
    const { windows, rejected } = parseRateLimits({
      five_hour: { used_percentage: null },
      seven_day: { used_percentage: 'lots' },
      spend_limit: { resets_at: 1790000000 },
    });
    expect(rejected).toEqual(['five_hour', 'seven_day', 'spend_limit']);
    expect(windows).toEqual([]);
  });

  it('keeps the datapoint when resets_at is missing or implausible', () => {
    const { windows } = parseRateLimits({
      five_hour: { used_percentage: 10 },
      seven_day: { used_percentage: 20, resets_at: 0 },
      spend_limit: { used_percentage: 30, resets_at: 'soon' },
    });
    expect(windows.map((w) => w.resetsAt)).toEqual([null, null, null]);
    expect(windows.map((w) => w.usedPercentage)).toEqual([10, 20, 30]);
  });

  it('ignores unknown window keys', () => {
    const { windows } = parseRateLimits({
      thirty_day: { used_percentage: 99, resets_at: 1790000000 },
      seven_day: { used_percentage: 1, resets_at: 1790000000 },
    });
    expect(windows.map((w) => w.windowType)).toEqual(['seven_day']);
  });

  it('accepts numeric strings so a stringified payload still lands', () => {
    const { windows } = parseRateLimits({
      seven_day: { used_percentage: '55.5', resets_at: '1790000000' },
    });
    expect(windows).toEqual([
      { windowType: 'seven_day', usedPercentage: 55.5, resetsAt: 1790000000 },
    ]);
  });
});

describe('normalizeEpochSeconds', () => {
  it('passes through epoch seconds', () => {
    expect(normalizeEpochSeconds(1790000000)).toBe(1790000000);
  });

  it('downgrades epoch milliseconds', () => {
    expect(normalizeEpochSeconds(1790000000123)).toBe(1790000000);
  });

  it('nulls out implausible values', () => {
    for (const raw of [0, -1, 1, NaN, Infinity, null, undefined, {}, '']) {
      expect(normalizeEpochSeconds(raw)).toBeNull();
    }
  });
});

describe('shouldInsertSnapshot', () => {
  const incoming: ParsedPlanUsageWindow = {
    windowType: 'seven_day',
    usedPercentage: 42.5,
    resetsAt: 1790000000,
  };
  const now = 1790000500;

  it('inserts the first snapshot for a window', () => {
    expect(shouldInsertSnapshot(null, incoming, now)).toBe(true);
  });

  it('is a no-op when nothing changed inside the heartbeat window', () => {
    const latest = { usedPercentage: 42.5, resetsAt: 1790000000, capturedAt: now - 30 };
    expect(shouldInsertSnapshot(latest, incoming, now)).toBe(false);
  });

  it('inserts when the percentage moved', () => {
    const latest = { usedPercentage: 42.4, resetsAt: 1790000000, capturedAt: now - 1 };
    expect(shouldInsertSnapshot(latest, incoming, now)).toBe(true);
  });

  it('inserts when the window rolled over to a new reset boundary', () => {
    const latest = { usedPercentage: 42.5, resetsAt: 1789000000, capturedAt: now - 1 };
    expect(shouldInsertSnapshot(latest, incoming, now)).toBe(true);
  });

  it('inserts an unchanged heartbeat once the floor has elapsed', () => {
    const stale = {
      usedPercentage: 42.5,
      resetsAt: 1790000000,
      capturedAt: now - PLAN_USAGE_HEARTBEAT_SECONDS,
    };
    expect(shouldInsertSnapshot(stale, incoming, now)).toBe(true);

    const fresh = { ...stale, capturedAt: now - PLAN_USAGE_HEARTBEAT_SECONDS + 1 };
    expect(shouldInsertSnapshot(fresh, incoming, now)).toBe(false);
  });

  it('treats a missing resetsAt as a real difference', () => {
    const latest = { usedPercentage: 42.5, resetsAt: null, capturedAt: now - 1 };
    expect(shouldInsertSnapshot(latest, incoming, now)).toBe(true);
  });
});
