import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema';
import { rankSnapshots } from '../db/schema';
import {
  BOARDS,
  BOARD_KEYS,
  DEFAULT_BOARD_LIMIT,
  MAX_BOARD_LIMIT,
  SCOPE_LABELS,
  boardCaption,
  clampBoardLimit,
  clampBoardOffset,
  boardMetricName,
  boardRankChanges,
  boardSnapshotSentinel,
  boardRowFor,
  boardValue,
  classFromEvidence,
  classLabel,
  formatBoardValue,
  formatCountdown,
  leverageRatio,
  parseBoard,
  parseScope,
  rankBoard,
  resetCountdown,
  weekStartUtc,
  type BoardFigures,
  type BoardUser,
} from './boards';
import { compact } from './format';
import { defaultVisibility } from './profile-settings';
import { MIN_PROMPTS_FOR_CLASS } from './fingerprint';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

// ═══════════════════════════════════════════════════════════════════════════
// The week boundary
// ═══════════════════════════════════════════════════════════════════════════

describe('weekStartUtc', () => {
  // 2026-10-18 is a Sunday, so its week began on Monday the 12th.
  it('walks back to Monday from a Sunday', () => {
    expect(weekStartUtc(new Date('2026-10-18T22:30:00Z')).toISOString()).toBe(
      '2026-10-12T00:00:00.000Z'
    );
  });

  it('is the day itself on a Monday', () => {
    expect(weekStartUtc(new Date('2026-10-19T00:00:00Z')).toISOString()).toBe(
      '2026-10-19T00:00:00.000Z'
    );
  });

  // The boundary millisecond: a prompt at 23:59:59.999 on Sunday belongs to the
  // week that is ending, and one at 00:00:00.000 on Monday to the new one.
  it('splits the two weeks at the Monday instant', () => {
    expect(weekStartUtc(new Date('2026-10-18T23:59:59.999Z')).toISOString()).toBe(
      '2026-10-12T00:00:00.000Z'
    );
    expect(weekStartUtc(new Date('2026-10-19T00:00:00.000Z')).toISOString()).toBe(
      '2026-10-19T00:00:00.000Z'
    );
  });

  // UTC, not the server's zone: a machine in Auckland must not shift the field
  // everybody is being compared in.
  it('ignores the local zone of the clock it is given', () => {
    const sameInstant = new Date(Date.UTC(2026, 9, 14, 3, 0, 0));
    expect(weekStartUtc(sameInstant).toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });
});

describe('resetCountdown', () => {
  it('counts whole days and hours to the next Monday', () => {
    // Saturday 20:00 → Monday 00:00 is 1d 4h.
    expect(resetCountdown(new Date('2026-10-17T20:00:00Z'))).toEqual({ days: 1, hours: 4 });
  });

  // Floored, so the countdown never goes backwards between two page loads: 1d
  // 3h 59m reads "1d 3h" and then "1d 2h", never "1d 4h" and then "1d 3h".
  it('floors the remainder instead of rounding it up', () => {
    expect(resetCountdown(new Date('2026-10-17T20:00:59Z'))).toEqual({ days: 1, hours: 3 });
  });

  it('is a full week just after a reset', () => {
    expect(resetCountdown(new Date('2026-10-19T00:00:00Z'))).toEqual({ days: 7, hours: 0 });
  });

  it('drops the days from the label inside the last day', () => {
    expect(formatCountdown(new Date('2026-10-18T20:30:00Z'))).toBe('3h');
    expect(formatCountdown(new Date('2026-10-17T20:00:00Z'))).toBe('1d 4h');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Leverage
// ═══════════════════════════════════════════════════════════════════════════

describe('leverageRatio', () => {
  // 1,000 output tokens is ~4,000 characters; 100 characters typed → 40×.
  it('is output characters over characters typed', () => {
    expect(leverageRatio(1_000, 100)).toBe(40);
  });

  /**
   * A ratio of SUMS, not an average of ratios. The two differ, and only the
   * first reconciles against the totals printed beside it: one prompt at 10/10
   * and one at 1000/1 average to 500.5× per prompt, but the board says 364×
   * because that is what the character totals say.
   */
  it('is a ratio of sums, not the mean of per-prompt ratios', () => {
    const summed = leverageRatio(10 + 1_000, 40 + 4);
    expect(summed).toBeCloseTo((1_010 * 4) / 44, 10);
    expect(summed).not.toBeCloseTo((10 * 4 / 40 + 1_000 * 4 / 4) / 2, 1);
  });

  // Not Infinity: pre-OTEL rows record no prompt_length, and a user whose
  // characters were never measured would otherwise top the board forever.
  it('is zero when nothing was typed', () => {
    expect(leverageRatio(5_000, 0)).toBe(0);
  });

  it('is zero when Claude wrote nothing', () => {
    expect(leverageRatio(0, 900)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Which figure a board ranks on
// ═══════════════════════════════════════════════════════════════════════════

function figures(overrides: Partial<BoardFigures> = {}): BoardFigures {
  return {
    userId: 'u',
    tokens: 0,
    valueUsd: 0,
    ultrathinks: 0,
    outputTokens: 0,
    promptChars: 0,
    prompts: 0,
    streak: 0,
    longestStreak: 0,
    ...overrides,
  };
}

describe('boardValue', () => {
  const sample = figures({
    valueUsd: 1_284.4,
    ultrathinks: 312,
    outputTokens: 50_000,
    promptChars: 10_000,
    prompts: 900,
    streak: 19,
  });

  it('reads each board off its own figure', () => {
    expect(boardValue('value', sample, 'week')).toBe(1_284.4);
    expect(boardValue('streak', sample, 'current')).toBe(19);
    expect(boardValue('ultrathinks', sample, 'week')).toBe(312);
    expect(boardValue('leverage', sample, 'week')).toBe(20);
  });

  /**
   * 🔥 is the one board whose two scopes read different COLUMNS rather than
   * the same figure over a different window — "this week's streak" is not a
   * number anybody has.
   */
  it('reads the streak board off current or longest, by scope', () => {
    const runner = figures({ streak: 4, longestStreak: 31 });
    expect(boardValue('streak', runner, 'current')).toBe(4);
    expect(boardValue('streak', runner, 'best')).toBe(31);
  });

  it('ignores the scope on the three boards that are windowed', () => {
    for (const scope of ['week', 'all'] as const) {
      expect(boardValue('value', sample, scope)).toBe(1_284.4);
      expect(boardValue('ultrathinks', sample, scope)).toBe(312);
    }
  });

  /**
   * The ultrathink flag is a synthetic `clawdgg.ultrathink` event, not a prompt
   * (commit 1afec9d). Counting it as one would inflate the prompt count AND the
   * leverage denominator for everyone who uses the hook.
   */
  it('never counts an ultrathink as a prompt', () => {
    const quiet = figures({ prompts: 10, ultrathinks: 7, promptChars: 100, outputTokens: 25 });
    expect(boardValue('ultrathinks', quiet, 'week')).toBe(7);
    expect(boardValue('leverage', quiet, 'week')).toBe(1);
    expect(quiet.prompts).toBe(10);
  });

  it('has a figure of zero for a user with no rows', () => {
    for (const board of BOARD_KEYS) {
      for (const scope of BOARDS[board].scopes) expect(boardValue(board, figures(), scope)).toBe(0);
    }
  });
});

describe('formatBoardValue', () => {
  it('prints value in exact dollars', () => {
    expect(formatBoardValue('value', 1_284.4)).toBe('$1,284');
  });

  it('prints a one-day streak in the singular', () => {
    expect(formatBoardValue('streak', 1)).toBe('1 day');
    expect(formatBoardValue('streak', 19)).toBe('19 days');
  });

  it('prints ultrathinks as a count', () => {
    expect(formatBoardValue('ultrathinks', 2_904)).toBe('2,904');
  });

  // "≈" because the character count behind it is tokens × 4, a rule of thumb.
  it('marks leverage as approximate', () => {
    expect(formatBoardValue('leverage', 128.6)).toBe('≈129×');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ranking the field
// ═══════════════════════════════════════════════════════════════════════════

function boardUser(userId: string, overrides: Partial<BoardUser> = {}): BoardUser {
  return {
    userId,
    username: userId,
    avatarUrl: null,
    timezone: 'UTC',
    streak: 0,
    longestStreak: 0,
    visibility: defaultVisibility(),
    ...overrides,
  };
}

function figureMap(entries: [string, Partial<BoardFigures>][]): Map<string, BoardFigures> {
  return new Map(entries.map(([userId, f]) => [userId, figures({ userId, ...f })]));
}

describe('rankBoard', () => {
  it('ranks the highest figure first, from 1', () => {
    const ranked = rankBoard(
      'value',
      'week',
      [boardUser('a'), boardUser('b'), boardUser('c')],
      figureMap([
        ['a', { valueUsd: 10 }],
        ['b', { valueUsd: 30 }],
        ['c', { valueUsd: 20 }],
      ])
    );
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([
      ['b', 1],
      ['c', 2],
      ['a', 3],
    ]);
  });

  /**
   * The tiebreaker is load-bearing, not tidiness. Two users on the same figure
   * are in an arbitrary order without one, and a snapshot taken under one order
   * and compared with a board rendered under another shows BOTH of them a move
   * that never happened — every day, forever. Same rule as rank-snapshots.ts.
   */
  /**
   * BINARY id order, matching SQL `ORDER BY value DESC, id ASC` — the ordering
   * the snapshot side uses. localeCompare disagrees with it on ids containing
   * punctuation (it sorts `github_1_x` before `github_10`, SQLite after), and a
   * tie ordered one way in the snapshot and the other on the page shows both
   * users an arrow for a move that never happened.
   */
  it('breaks ties the way SQLite does, not the way a locale would', () => {
    const tied = figureMap([
      ['github_10', { valueUsd: 7 }],
      ['github_1_x', { valueUsd: 7 }],
    ]);
    const ranked = rankBoard(
      'value',
      'week',
      [boardUser('github_10'), boardUser('github_1_x')],
      tied
    );
    expect(ranked.map((r) => r.userId)).toEqual(['github_10', 'github_1_x']);
    expect('github_10' < 'github_1_x').toBe(true);
  });

  it('breaks ties by user id, so the order is stable across runs', () => {
    const tied = figureMap([
      ['zoe', { ultrathinks: 5 }],
      ['adam', { ultrathinks: 5 }],
      ['mia', { ultrathinks: 5 }],
    ]);
    const first = rankBoard('ultrathinks', 'week', [boardUser('zoe'), boardUser('adam'), boardUser('mia')], tied);
    const second = rankBoard('ultrathinks', 'week', [boardUser('mia'), boardUser('zoe'), boardUser('adam')], tied);
    expect(first.map((r) => r.userId)).toEqual(['adam', 'mia', 'zoe']);
    expect(second.map((r) => r.userId)).toEqual(first.map((r) => r.userId));
    expect(first.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  // A board of people who have none of the thing is a list, not a ranking.
  it('leaves out a user whose figure is zero', () => {
    const ranked = rankBoard(
      'ultrathinks',
      'week',
      [boardUser('a'), boardUser('b')],
      figureMap([
        ['a', { ultrathinks: 0 }],
        ['b', { ultrathinks: 3 }],
      ])
    );
    expect(ranked.map((r) => r.userId)).toEqual(['b']);
  });

  /**
   * Visibility settings (commit 2423e5b). A user who took a section down is off
   * the board that ranks on it ENTIRELY — a rank is itself a figure about them,
   * so listing "#2 —" would say more than nothing. The ranks that remain are
   * 1..n with no hole where they were.
   */
  it('drops a user who hid the section the board ranks on', () => {
    const hidden = defaultVisibility();
    hidden.value = false;
    const ranked = rankBoard(
      'value',
      'week',
      [boardUser('a'), boardUser('shy', { visibility: hidden }), boardUser('c')],
      figureMap([
        ['a', { valueUsd: 10 }],
        ['shy', { valueUsd: 99 }],
        ['c', { valueUsd: 5 }],
      ])
    );
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([
      ['a', 1],
      ['c', 2],
    ]);
  });

  it('keeps a user who hid some OTHER section', () => {
    const hidden = defaultVisibility();
    hidden.ultrathink = false;
    const ranked = rankBoard(
      'value',
      'week',
      [boardUser('shy', { visibility: hidden })],
      figureMap([['shy', { valueUsd: 99 }]])
    );
    expect(ranked.map((r) => r.userId)).toEqual(['shy']);
  });

  it('reads the streak board off the synced streak, not ClickHouse', () => {
    const ranked = rankBoard(
      'streak',
      'current',
      [boardUser('a', { streak: 4 }), boardUser('b', { streak: 31 })],
      new Map()
    );
    expect(ranked.map((r) => [r.userId, r.value])).toEqual([
      ['b', 31],
      ['a', 4],
    ]);
  });

  it('has nothing to rank with no users', () => {
    expect(rankBoard('value', 'week', [], new Map())).toEqual([]);
  });

  // Every board hides behind a section that exists, or a hidden profile would
  // silently stay on a board the owner thinks they left.
  it('names a real profile section for every board', () => {
    for (const board of BOARD_KEYS) {
      expect(defaultVisibility()[BOARDS[board].section]).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// What a row shows, and what it withholds
// ═══════════════════════════════════════════════════════════════════════════

describe('boardRowFor', () => {
  const evidence = {
    hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? 80 : h === 10 ? 40 : 0)),
    prompts: 120,
    tools: 240,
    subagentValue: 50,
    attributedValue: 100,
  };
  const entry = { userId: 'a', value: 1_284, rank: 2 };
  const figure = figures({ userId: 'a', ultrathinks: 312 });

  it('shows the clock, the class and both side figures by default', () => {
    const row = boardRowFor('value', 'week', entry, boardUser('a', { streak: 19 }), figure, evidence, 3);
    expect(row.hours).toEqual(evidence.hours);
    expect(row.classLabel).toBe('☀️ morning orchestrator');
    expect(row.ultrathinks).toBe(312);
    expect(row.streak).toBe(19);
    expect(row.change).toBe(3);
    expect(row.display).toBe('$1,284');
  });

  /**
   * Each part hangs off its own section, and a hidden one is ABSENT rather
   * than zero: a zero is a claim about the data, an absent figure is a claim
   * about the owner's choice, and only the second one is true.
   */
  const hiddenExpectations = {
    rings: 'hours',
    class: 'classLabel',
    ultrathink: 'ultrathinks',
    curve: 'streak',
  } as const;

  for (const [section, field] of Object.entries(hiddenExpectations) as [
    keyof typeof hiddenExpectations,
    (typeof hiddenExpectations)[keyof typeof hiddenExpectations],
  ][]) {
    it(`leaves out ${field} when the owner hid '${section}'`, () => {
      const visibility = defaultVisibility();
      visibility[section] = false;
      const row = boardRowFor(
        'value',
        'week',
        entry,
        boardUser('a', { streak: 19, visibility }),
        figure,
        evidence,
        3
      );
      expect(row[field]).toBeUndefined();
      // Only that one part goes: hiding the rings must not take the class too.
      const others = (['hours', 'classLabel', 'ultrathinks', 'streak'] as const).filter(
        (key) => key !== field
      );
      for (const key of others) expect(row[key]).toBeDefined();
    });
  }

  it('still prints the figure the board ranks on', () => {
    const visibility = defaultVisibility();
    visibility.rings = false;
    visibility.class = false;
    visibility.ultrathink = false;
    visibility.curve = false;
    const row = boardRowFor('value', 'week', entry, boardUser('a', { visibility }), figure, evidence, undefined);
    expect(row.display).toBe('$1,284');
    expect(row.rank).toBe(2);
    expect(row.change).toBeUndefined();
  });

  /**
   * An unreadable figure is not a zero. With ClickHouse down the streak board
   * still ranks off SQLite, and the 🌈 column beside it has to go blank rather
   * than tell everyone they have none.
   */
  it('leaves out the ultrathink figure when the figures could not be read', () => {
    const row = boardRowFor('streak', 'best', entry, boardUser('a', { streak: 19 }), undefined, evidence, undefined);
    expect(row.ultrathinks).toBeUndefined();
    expect(row.streak).toBe(19);
  });

  it('has no clock at all when the class evidence could not be read', () => {
    const row = boardRowFor('value', 'week', entry, boardUser('a'), figure, undefined, undefined);
    expect(row.hours).toBeUndefined();
    expect(row.classLabel).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The class beside a handle
// ═══════════════════════════════════════════════════════════════════════════

describe('classLabel', () => {
  it('joins the rhythm and the style', () => {
    expect(classLabel('morning', 'orchestrator')).toBe('☀️ morning orchestrator');
    expect(classLabel('night-owl', 'pair-programmer')).toBe('🌙 night pair-programmer');
  });

  it('prints whichever half is known', () => {
    expect(classLabel('early-bird', null)).toBe('🐦 early');
    expect(classLabel(null, 'autopilot')).toBe('autopilot');
  });

  // A class nobody can check is a horoscope.
  it('is absent when neither half is known', () => {
    expect(classLabel(null, null)).toBeUndefined();
  });
});

describe('classFromEvidence', () => {
  it('is absent for a user with no evidence', () => {
    expect(classFromEvidence(undefined)).toBeUndefined();
  });

  // Below MIN_PROMPTS_FOR_CLASS an hour distribution is noise.
  it('is absent below the prompt floor', () => {
    const hours = Array<number>(24).fill(0);
    hours[9] = MIN_PROMPTS_FOR_CLASS - 1;
    expect(
      classFromEvidence({
        hours,
        prompts: MIN_PROMPTS_FOR_CLASS - 1,
        tools: 0,
        subagentValue: 0,
        attributedValue: 0,
      })
    ).toBeUndefined();
  });

  it('reads a morning orchestrator off their own rows', () => {
    const hours = Array<number>(24).fill(0);
    hours[9] = 60;
    hours[10] = 40;
    expect(
      classFromEvidence({
        hours,
        prompts: 100,
        tools: 300,
        subagentValue: 40,
        attributedValue: 100,
      })
    ).toBe('☀️ morning orchestrator');
  });

  // Unattributed value is not main-thread value: rows from before query_source
  // existed carry no attribution at all, and dividing by them would read as a
  // habit nobody demonstrated.
  it('ignores unattributed value in the subagent share', () => {
    const hours = Array<number>(24).fill(0);
    hours[14] = 100;
    expect(
      classFromEvidence({
        hours,
        prompts: 100,
        tools: 100,
        subagentValue: 0,
        attributedValue: 0,
      })
    ).toBe('🌤 afternoon pair-programmer');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query parsing
// ═══════════════════════════════════════════════════════════════════════════

describe('parseBoard / parseScope', () => {
  it('keeps a known board and falls back to the first tab', () => {
    expect(parseBoard('leverage')).toBe('leverage');
    expect(parseBoard('streak')).toBe('streak');
    expect(parseBoard('nonsense')).toBe('tokens');
    expect(parseBoard(undefined)).toBe('tokens');
    // The fallback IS the first tab, so the two cannot drift apart: a bare `/`
    // has to land on the board whose tab is drawn selected.
    expect(parseBoard(undefined)).toBe(BOARD_KEYS[0]);
  });

  // 🪙 is the default board and it opens on ALL TIME, which is why the default
  // scope is a field rather than `scopes[0]` — its switch still reads
  // "this week | all time" like every other windowed board's.
  it('defaults the scope to the default board’s own default', () => {
    expect(parseScope('all')).toBe('all');
    expect(parseScope('week')).toBe('week');
    expect(parseScope('year')).toBe('all');
    expect(parseScope(undefined)).toBe('all');
  });

  it('leaves every other board’s default where it was', () => {
    expect(parseScope(undefined, 'value')).toBe('week');
    expect(parseScope(undefined, 'ultrathinks')).toBe('week');
    expect(parseScope(undefined, 'leverage')).toBe('week');
    expect(parseScope(undefined, 'streak')).toBe('current');
    expect(parseScope('year', 'value')).toBe('week');
  });
});

describe('scopes per board', () => {
  // "This week's streak" is not a number anybody has, so 🔥 switches between
  // the run you are on and the longest one you ever had instead.
  it('offers current/best on the streak board and week/all on the others', () => {
    expect(BOARDS.streak.scopes).toEqual(['current', 'best']);
    for (const board of ['tokens', 'value', 'ultrathinks', 'leverage'] as const) {
      expect(BOARDS[board].scopes).toEqual(['week', 'all']);
    }
  });

  it('opens every board on a scope it actually offers', () => {
    for (const board of BOARD_KEYS) {
      expect(BOARDS[board].scopes).toContain(BOARDS[board].defaultScope);
      expect(parseScope(undefined, board)).toBe(BOARDS[board].defaultScope);
    }
  });

  it('validates the scope against the board it belongs to', () => {
    expect(parseScope('best', 'streak')).toBe('best');
    expect(parseScope('current', 'streak')).toBe('current');
    // Switching boards carries the old scope in the form: it must land on the
    // new board's default rather than on a board that does not exist.
    expect(parseScope('best', 'value')).toBe('week');
    expect(parseScope('best', 'tokens')).toBe('all');
    expect(parseScope('week', 'streak')).toBe('current');
    expect(parseScope(undefined, 'streak')).toBe('current');
  });

  it('names every scope it can be switched to', () => {
    for (const board of BOARD_KEYS) {
      for (const scope of BOARDS[board].scopes) expect(SCOPE_LABELS[scope]).toBeTruthy();
    }
  });

  it('says a different thing under each streak scope', () => {
    expect(boardCaption('streak', 'current')).toContain('right now');
    expect(boardCaption('streak', 'best')).toContain('ever');
    expect(boardCaption('value', 'week')).toBe(BOARDS.value.caption);
  });

  it('ranks the two streak scopes off their own columns', () => {
    const field = [
      boardUser('a', { streak: 4, longestStreak: 90 }),
      boardUser('b', { streak: 31, longestStreak: 31 }),
    ];
    expect(rankBoard('streak', 'current', field, new Map()).map((r) => r.userId)).toEqual(['b', 'a']);
    expect(rankBoard('streak', 'best', field, new Map()).map((r) => r.userId)).toEqual(['a', 'b']);
  });

  // A user whose current run is 0 is off the 'current' board but still has a
  // best ever to be ranked on.
  it('leaves a lapsed streak on the best-ever board only', () => {
    const lapsed = [boardUser('a', { streak: 0, longestStreak: 40 })];
    expect(rankBoard('streak', 'current', lapsed, new Map())).toEqual([]);
    expect(rankBoard('streak', 'best', lapsed, new Map()).map((r) => r.value)).toEqual([40]);
  });

  it('still drops a hidden curve from both streak scopes', () => {
    const visibility = defaultVisibility();
    visibility.curve = false;
    const shy = [boardUser('shy', { streak: 12, longestStreak: 99, visibility })];
    expect(rankBoard('streak', 'current', shy, new Map())).toEqual([]);
    expect(rankBoard('streak', 'best', shy, new Map())).toEqual([]);
  });

  // "19 days · 🔥 19" is one number printed twice.
  it('drops the 🔥 side figure on the board that already is it', () => {
    const user = boardUser('a', { streak: 19, longestStreak: 40 });
    const current = boardRowFor(
      'streak',
      'current',
      { userId: 'a', value: 19, rank: 1 },
      user,
      undefined,
      undefined,
      undefined
    );
    const best = boardRowFor(
      'streak',
      'best',
      { userId: 'a', value: 40, rank: 1 },
      user,
      undefined,
      undefined,
      undefined
    );
    expect(current.display).toBe('19 days');
    expect(current.streak).toBeUndefined();
    expect(best.display).toBe('40 days');
    expect(best.streak).toBe(19);
  });
});

describe('boardMetricName', () => {
  // Namespaced so it cannot collide with F5's own metrics in the same table.
  it('namespaces the board and scope', () => {
    expect(boardMetricName('value', 'week')).toBe('board:value:week');
    expect(boardMetricName('leverage', 'all')).toBe('board:leverage:all');
  });

  it('is unique across every board and its own scopes', () => {
    const names = new Set<string>();
    for (const board of BOARD_KEYS) {
      for (const scope of BOARDS[board].scopes) names.add(boardMetricName(board, scope));
    }
    expect(names.size).toBe(BOARD_KEYS.length * 2);
    expect(names.has('board:streak:current')).toBe(true);
    expect(names.has('board:streak:best')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Arrows, against a real snapshot table
// ═══════════════════════════════════════════════════════════════════════════

let dir: string;
let sqlite: Database;
let database: ReturnType<typeof drizzle<typeof schema>>;

/** The real migration IS the schema under test — same idiom as rank-snapshots.test.ts. */
async function applySchema(target: Database): Promise<void> {
  target.exec(`CREATE TABLE users (
    id text PRIMARY KEY NOT NULL,
    github_id text,
    github_username text,
    total_prompts integer DEFAULT 0,
    total_tokens integer DEFAULT 0,
    total_lines_added integer DEFAULT 0,
    total_commits integer DEFAULT 0,
    total_cost_cents integer DEFAULT 0
  )`);

  const migration = await readFile(join(REPO_ROOT, 'drizzle/0011_add_rank_snapshots.sql'), 'utf-8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) target.exec(statement);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clawdgg-boards-'));
  sqlite = new Database(join(dir, 'test.db'), { create: true });
  await applySchema(sqlite);
  database = drizzle(sqlite, { schema });
  sqlite.exec(`INSERT INTO users (id, github_id, github_username) VALUES
    ('a', 'gh-a', 'a'), ('b', 'gh-b', 'b')`);
});

afterEach(async () => {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

async function snapshot(day: string, metric: string, ranks: [string, number][]): Promise<void> {
  await database.insert(rankSnapshots).values(
    ranks.map(([userId, rank]) => ({ userId, day, metric, rank, value: 0 }))
  );
}

describe('boardRankChanges', () => {
  const now = new Date('2026-10-15T12:00:00Z'); // a Thursday
  const ids = ['a', 'b'];

  it('is positive for a user who climbed since the last snapshot', async () => {
    await snapshot('2026-10-14', boardMetricName('value', 'week'), [['a', 3], ['b', 1]]);
    const { previousDay, changes } = await boardRankChanges(
      'value',
      'week',
      ids,
      new Map([['a', 1], ['b', 2]]),
      now,
      database
    );
    expect(previousDay).toBe('2026-10-14');
    expect(changes.get('a')).toBe(2);
    expect(changes.get('b')).toBe(-1);
  });

  // A user who was not in the previous snapshot has not moved, they have
  // arrived. An arrow would be invented.
  it('gives no arrow to a user with no previous rank', async () => {
    await snapshot('2026-10-14', boardMetricName('value', 'week'), [['a', 1]]);
    const { changes } = await boardRankChanges(
      'value',
      'week',
      ids,
      new Map([['a', 1], ['b', 2]]),
      now,
      database
    );
    expect(changes.has('b')).toBe(false);
  });

  /**
   * Zero is a VALUE here, not an absence: it says the user was on the board
   * yesterday and has not moved ("—"), which the page has to tell apart from a
   * user who was not there at all ("new").
   */
  it('reports a user who did not move as zero, not as missing', async () => {
    await snapshot('2026-10-14', boardMetricName('value', 'week'), [['a', 1], ['b', 2]]);
    const { changes } = await boardRankChanges(
      'value',
      'week',
      ids,
      new Map([['a', 1], ['b', 2]]),
      now,
      database
    );
    expect(changes.get('a')).toBe(0);
    expect(changes.get('b')).toBe(0);
  });

  // The most recent EARLIER day, not literally yesterday: a day the server was
  // down leaves a gap, and skipping it would hide every arrow until it aged out.
  it('compares against the most recent earlier snapshot, gap or not', async () => {
    await snapshot('2026-10-13', boardMetricName('value', 'week'), [['a', 2], ['b', 1]]);
    const { previousDay, changes } = await boardRankChanges(
      'value',
      'week',
      ids,
      new Map([['a', 1], ['b', 2]]),
      now,
      database
    );
    expect(previousDay).toBe('2026-10-13');
    expect(changes.get('a')).toBe(1);
  });

  /**
   * Monday's weekly field is a fresh one — everybody is back at zero — so an
   * arrow against last week's positions would describe a race that has been
   * restarted.
   */
  it('gives no weekly arrow across the Monday reset', async () => {
    await snapshot('2026-10-11', boardMetricName('value', 'week'), [['a', 9], ['b', 1]]);
    const { previousDay, changes } = await boardRankChanges(
      'value',
      'week',
      ids,
      new Map([['a', 1], ['b', 2]]),
      now,
      database
    );
    // Null, not merely empty: the column goes blank rather than printing "new"
    // beside everyone on the first board of a new week.
    expect(previousDay).toBeNull();
    expect(changes.size).toBe(0);
  });

  // All-time is one continuous field, so the same old snapshot IS comparable.
  it('still shows all-time arrows across a week boundary', async () => {
    await snapshot('2026-10-11', boardMetricName('value', 'all'), [['a', 9], ['b', 1]]);
    const { changes } = await boardRankChanges(
      'value',
      'all',
      ids,
      new Map([['a', 1], ['b', 2]]),
      now,
      database
    );
    expect(changes.get('a')).toBe(8);
  });

  it('never reads another board’s snapshot', async () => {
    await snapshot('2026-10-14', boardMetricName('streak', 'week'), [['a', 5], ['b', 1]]);
    const { previousDay, changes } = await boardRankChanges(
      'value',
      'week',
      ids,
      new Map([['a', 1], ['b', 2]]),
      now,
      database
    );
    expect(previousDay).toBeNull();
    expect(changes.size).toBe(0);
  });

  it('has nothing to compare with no users', async () => {
    await snapshot('2026-10-14', boardMetricName('value', 'week'), [['a', 1]]);
    expect(
      (await boardRankChanges('value', 'week', [], new Map(), now, database)).changes.size
    ).toBe(0);
  });
});

describe('the sentinel that says a day is already on record', () => {
  /**
   * It was hardcoded to `board:value:all`, so the day 🪙 shipped every day
   * already snapshotted counted as done and the new board got no row until the
   * next UTC midnight — and a board cannot show an arrow against a day it was
   * not in, so its first ▲▼ was two days out rather than one.
   */
  it('follows the first board, so a new first board is on record the same day', () => {
    expect(boardSnapshotSentinel()).toBe('board:tokens:all');
    expect(boardSnapshotSentinel()).toBe(
      boardMetricName(BOARD_KEYS[0], BOARDS[BOARD_KEYS[0]].defaultScope)
    );
  });

  /**
   * And it has to be a metric the job WRITES. A sentinel naming a scope no
   * board offers is never written, so the skip check never fires and the whole
   * fan-out runs again every five minutes, forever.
   */
  it('names a board and scope the snapshot actually covers', () => {
    const written = new Set<string>();
    for (const board of BOARD_KEYS) {
      for (const scope of BOARDS[board].scopes) written.add(boardMetricName(board, scope));
    }
    expect(written.has(boardSnapshotSentinel())).toBe(true);
  });

  /**
   * Re-running a day that is PARTLY on record — which is exactly what the new
   * sentinel makes happen once, on the deploy that adds a board — must not
   * duplicate the boards already there. The unique index on
   * (user, day, metric) plus onConflictDoNothing is what guarantees it.
   */
  it('leaves a partly-snapshotted day alone and fills in only what is missing', async () => {
    const day = '2026-10-15';
    const existing = [
      { userId: 'a', day, metric: boardMetricName('value', 'all'), rank: 1, value: 900 },
      { userId: 'b', day, metric: boardMetricName('value', 'all'), rank: 2, value: 400 },
    ];
    await database.insert(rankSnapshots).values(existing);

    // What the next pass would write: the same 💎 rows again, with different
    // ranks and figures, plus the 🪙 rows that were not there.
    await database
      .insert(rankSnapshots)
      .values([
        { userId: 'a', day, metric: boardMetricName('value', 'all'), rank: 2, value: 1 },
        { userId: 'b', day, metric: boardMetricName('value', 'all'), rank: 1, value: 2 },
        { userId: 'a', day, metric: boardSnapshotSentinel(), rank: 1, value: 37_200_000_000 },
        { userId: 'b', day, metric: boardSnapshotSentinel(), rank: 2, value: 9_800_000_000 },
      ])
      .onConflictDoNothing();

    const rows = await database
      .select({ userId: rankSnapshots.userId, metric: rankSnapshots.metric, rank: rankSnapshots.rank, value: rankSnapshots.value })
      .from(rankSnapshots)
      .where(eq(rankSnapshots.day, day));

    expect(rows.length).toBe(4);
    // The 💎 rows are the ORIGINAL ones, untouched.
    const value = rows.filter((row) => row.metric === boardMetricName('value', 'all'));
    expect(value.map((row) => [row.userId, row.rank, row.value]).sort()).toEqual([
      ['a', 1, 900],
      ['b', 2, 400],
    ]);
    // And 🪙 is now on record for the same day, which is what buys it an arrow
    // tomorrow instead of the day after.
    expect(rows.filter((row) => row.metric === boardSnapshotSentinel()).length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pagination is a slice, and its bounds are not the caller's to choose
// ═══════════════════════════════════════════════════════════════════════════

describe('clampBoardLimit', () => {
  it('keeps a sane limit', () => {
    expect(clampBoardLimit(25)).toBe(25);
    expect(clampBoardLimit(1)).toBe(1);
    expect(clampBoardLimit(MAX_BOARD_LIMIT)).toBe(MAX_BOARD_LIMIT);
  });

  it('refuses a page bigger than the maximum, however it is asked for', () => {
    expect(clampBoardLimit(101)).toBe(MAX_BOARD_LIMIT);
    expect(clampBoardLimit(1e9)).toBe(MAX_BOARD_LIMIT);
    expect(clampBoardLimit(Number.MAX_SAFE_INTEGER)).toBe(MAX_BOARD_LIMIT);
    expect(clampBoardLimit(Infinity)).toBe(DEFAULT_BOARD_LIMIT);
  });

  it('refuses a page of nothing, which would never finish paginating', () => {
    expect(clampBoardLimit(0)).toBe(1);
    expect(clampBoardLimit(-5)).toBe(1);
    expect(clampBoardLimit(0.4)).toBe(1);
    expect(clampBoardLimit(NaN)).toBe(DEFAULT_BOARD_LIMIT);
  });
});

describe('clampBoardOffset', () => {
  it('leaves an offset inside the board alone', () => {
    expect(clampBoardOffset(0, 120)).toBe(0);
    expect(clampBoardOffset(75, 120)).toBe(75);
    expect(clampBoardOffset(120, 120)).toBe(120);
  });

  /**
   * The finding: every distinct `?offset=` was a cache key of its own and
   * every miss a full fan-out, so a loop over offsets was a free way to make
   * the server re-rank the whole board thousands of times. Past the end they
   * are ONE key now, and the key space is bounded by how many users there are.
   */
  it('collapses every offset past the end onto the end', () => {
    for (const absurd of [121, 10_000, 1e21, Number.MAX_SAFE_INTEGER]) {
      expect(clampBoardOffset(absurd, 120)).toBe(120);
    }
    expect(clampBoardOffset(5, 0)).toBe(0);
  });

  it('refuses a negative or unparseable offset', () => {
    expect(clampBoardOffset(-1, 120)).toBe(0);
    expect(clampBoardOffset(NaN, 120)).toBe(0);
    expect(clampBoardOffset(-Infinity, 120)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⚡ leverage: the board and the profile count the same rows
// ═══════════════════════════════════════════════════════════════════════════

describe('the leverage ratio is read over one population', () => {
  /**
   * A legacy row records that prompts happened and nothing about their length,
   * so it contributes 0 characters to the typed side of the ratio. Counting
   * its output tokens anyway made every pre-OTEL user look like they typed a
   * word and got a novel back — and this is a board that RANKS on the ratio,
   * so it put them at the top. src/lib/fingerprint.ts has carried the
   * exclusion since the figure existed; the board did not.
   */
  it('excludes legacy rows from the output-token sum, as the fingerprint does', async () => {
    const [boards, fingerprint] = await Promise.all([
      readFile(join(REPO_ROOT, 'src/lib/boards.ts'), 'utf-8'),
      readFile(join(REPO_ROOT, 'src/lib/fingerprint.ts'), 'utf-8'),
    ]);

    const tokenSum = /sumIf\(value, metric_name = 'claude_code\.token\.usage'[\s\S]{0,160}?\)\)/g;
    for (const [name, source] of [['boards.ts', boards], ['fingerprint.ts', fingerprint]] as const) {
      const sums = source.match(tokenSum) ?? [];
      expect(sums.length).toBeGreaterThan(0);
      // 🪙 sums EVERY token type and so names none of them — it is a count of
      // what happened, not a side of a ratio, and the describe below owns it.
      const byType = sums.filter((sum) => sum.includes('token_type'));
      expect(byType.length, name).toBeGreaterThan(0);
      for (const sum of byType) {
        expect(sum).toContain("token_type = 'output'");
        expect(sum, `${name}: ${sum}`).toContain('${NO_LEGACY_SQL}');
      }
    }
  });

  it('measures the typed side over measured prompts only', async () => {
    const boards = await readFile(join(REPO_ROOT, 'src/lib/boards.ts'), 'utf-8');
    // The other half of the same decision: `prompt_chars` is summed over
    // prompts that HAVE a length, which is what makes the exclusion above the
    // matching one rather than an extra filter.
    expect(boards).toContain('const measured = `${PROMPT_EVENT_SQL} AND prompt_length > 0`');
    expect(boards).toContain('sumIf(prompt_length, ${measured})');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🪙 tokens: the board, the figure and where the figure comes from
// ═══════════════════════════════════════════════════════════════════════════

describe('the 🪙 board', () => {
  it('is the first tab, and the one a bare / opens on', () => {
    expect(BOARD_KEYS[0]).toBe('tokens');
    expect(BOARD_KEYS).toEqual(['tokens', 'value', 'streak', 'ultrathinks', 'leverage']);
    expect(parseBoard(undefined)).toBe('tokens');
    expect(parseScope(undefined, 'tokens')).toBe('all');
  });

  it('is labelled and captioned like the others', () => {
    expect(BOARDS.tokens.emoji).toBe('🪙');
    expect(BOARDS.tokens.label).toBe('tokens');
    expect(BOARDS.tokens.heading).toBe('🪙 tokens');
    // What the podium prints: `${caption} · ${SCOPE_LABELS[scope]}`.
    expect(`${boardCaption('tokens', 'all')} · ${SCOPE_LABELS.all}`).toBe(
      'tokens Claude processed · all time'
    );
  });

  /**
   * Compact, because 37,214,882,901 is not a number anybody reads and nobody
   * compares their token count to the next person's digit by digit. Through
   * src/lib/format.ts's `compact`, which is the same function the profile
   * prints its magnitudes with — so the figure this board ranks on cannot be
   * spelled one way here and another way on the page it links to.
   */
  it('prints the figure as a magnitude, the way the profile does', () => {
    expect(formatBoardValue('tokens', 37_214_882_901)).toBe(compact(37_214_882_901));
    expect(formatBoardValue('tokens', 37_214_882_901)).toBe('37.2B');
    expect(formatBoardValue('tokens', 78_100_000_000)).toBe('78.1B');
    expect(formatBoardValue('tokens', 412_000_000)).toBe('412M');
    expect(formatBoardValue('tokens', 9_800)).toBe('9.8K');
    expect(formatBoardValue('tokens', 999)).toBe('999');
    expect(formatBoardValue('tokens', 0)).toBe('0');
  });

  /**
   * EVERY token type. The figure is the sum the four per-type columns in
   * getUserTotals add up to — input, output, cacheRead and cacheCreation —
   * and not `users.total_tokens`, which is input + output only. About 95% of
   * tokens are cache reads (see src/lib/fingerprint.ts), so the two are not
   * close: one is roughly twenty times the other.
   */
  it('ranks on every token type added together', () => {
    const input = 9_000_000_000;
    const output = 400_000_000;
    const cacheRead = 27_000_000_000;
    const cacheCreation = 800_000_000;
    const user = figures({
      tokens: input + output + cacheRead + cacheCreation,
      outputTokens: output,
    });

    expect(boardValue('tokens', user, 'all')).toBe(37_200_000_000);
    expect(boardValue('tokens', user, 'week')).toBe(37_200_000_000);
    // NOT the ⚡ figure's output-only sum, which is the one token count on
    // this page that is deliberately narrower.
    expect(boardValue('tokens', user, 'all')).not.toBe(user.outputTokens);
  });

  it('has no figure for a user ClickHouse had nothing for', () => {
    expect(rankBoard('tokens', 'all', [boardUser('a')], new Map())).toEqual([]);
  });

  /**
   * 🪙 and 💎 are the same rows read two ways, so they hide behind the same
   * section: a user who took their value section down has put away the
   * metrics_raw sums this figure comes out of, and a lifetime token count
   * would hand most of it back.
   */
  it('hides behind the same section 💎 does', () => {
    expect(BOARDS.tokens.section).toBe(BOARDS.value.section);

    const visibility = defaultVisibility();
    visibility.value = false;
    const shy = [boardUser('shy', { visibility })];
    const rich = figureMap([['shy', { tokens: 37_200_000_000, valueUsd: 10_918 }]]);
    expect(rankBoard('tokens', 'all', shy, rich)).toEqual([]);
    expect(rankBoard('tokens', 'week', shy, rich)).toEqual([]);
    expect(rankBoard('value', 'all', shy, rich)).toEqual([]);
  });

  it('snapshots both of its scopes under their own metric names', () => {
    expect(boardMetricName('tokens', 'week')).toBe('board:tokens:week');
    expect(boardMetricName('tokens', 'all')).toBe('board:tokens:all');
  });

  /**
   * ONE DEFINITION, read off the source. The 🪙 sum names no token_type and no
   * provenance — which is the same sum getUserProvenanceBreakdown reports as
   * `tokens`, and the same one getUserRank sorts its token leaderboard by. A
   * provenance filter here would take a pre-OTEL user's first months off their
   * own lifetime total; NO_LEGACY_SQL is for queries that read the SHAPE of a
   * day, and a legacy row is honest about HOW MANY tokens moved.
   */
  it('is the same sum ClickHouse already answers "tokens" with', async () => {
    const SUM = "sumIf(value, metric_name = 'claude_code.token.usage')";
    const [boards, clickhouse] = await Promise.all([
      readFile(join(REPO_ROOT, 'src/lib/boards.ts'), 'utf-8'),
      readFile(join(REPO_ROOT, 'src/db/clickhouse.ts'), 'utf-8'),
    ]);

    expect(boards).toContain(`toUInt64(${SUM}) AS tokens`);
    expect(clickhouse).toContain(`${SUM} as tokens`);
    // And nothing narrows it afterwards: the 🪙 sum is one expression, with no
    // token_type and no provenance clause bolted onto its line.
    const line = boards.split('\n').find((text) => text.includes(`toUInt64(${SUM}) AS tokens`))!;
    expect(line).not.toContain('token_type');
    expect(line).not.toContain('NO_LEGACY_SQL');
  });
});
