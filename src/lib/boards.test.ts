import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema';
import { rankSnapshots } from '../db/schema';
import {
  BOARDS,
  BOARD_KEYS,
  boardMetricName,
  boardRankChanges,
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
    valueUsd: 0,
    ultrathinks: 0,
    outputTokens: 0,
    promptChars: 0,
    prompts: 0,
    streak: 0,
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
    expect(boardValue('value', sample)).toBe(1_284.4);
    expect(boardValue('streak', sample)).toBe(19);
    expect(boardValue('ultrathinks', sample)).toBe(312);
    expect(boardValue('leverage', sample)).toBe(20);
  });

  /**
   * The ultrathink flag is a synthetic `clawdgg.ultrathink` event, not a prompt
   * (commit 1afec9d). Counting it as one would inflate the prompt count AND the
   * leverage denominator for everyone who uses the hook.
   */
  it('never counts an ultrathink as a prompt', () => {
    const quiet = figures({ prompts: 10, ultrathinks: 7, promptChars: 100, outputTokens: 25 });
    expect(boardValue('ultrathinks', quiet)).toBe(7);
    expect(boardValue('leverage', quiet)).toBe(1);
    expect(quiet.prompts).toBe(10);
  });

  it('has a figure of zero for a user with no rows', () => {
    for (const board of BOARD_KEYS) expect(boardValue(board, figures())).toBe(0);
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
    const first = rankBoard('ultrathinks', [boardUser('zoe'), boardUser('adam'), boardUser('mia')], tied);
    const second = rankBoard('ultrathinks', [boardUser('mia'), boardUser('zoe'), boardUser('adam')], tied);
    expect(first.map((r) => r.userId)).toEqual(['adam', 'mia', 'zoe']);
    expect(second.map((r) => r.userId)).toEqual(first.map((r) => r.userId));
    expect(first.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  // A board of people who have none of the thing is a list, not a ranking.
  it('leaves out a user whose figure is zero', () => {
    const ranked = rankBoard(
      'ultrathinks',
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
      [boardUser('shy', { visibility: hidden })],
      figureMap([['shy', { valueUsd: 99 }]])
    );
    expect(ranked.map((r) => r.userId)).toEqual(['shy']);
  });

  it('reads the streak board off the synced streak, not ClickHouse', () => {
    const ranked = rankBoard(
      'streak',
      [boardUser('a', { streak: 4 }), boardUser('b', { streak: 31 })],
      new Map()
    );
    expect(ranked.map((r) => [r.userId, r.value])).toEqual([
      ['b', 31],
      ['a', 4],
    ]);
  });

  it('has nothing to rank with no users', () => {
    expect(rankBoard('value', [], new Map())).toEqual([]);
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
    const row = boardRowFor('value', entry, boardUser('a', { streak: 19 }), figure, evidence, 3);
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
    const row = boardRowFor('value', entry, boardUser('a', { visibility }), figure, evidence, undefined);
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
    const row = boardRowFor('streak', entry, boardUser('a', { streak: 19 }), undefined, evidence, undefined);
    expect(row.ultrathinks).toBeUndefined();
    expect(row.streak).toBe(19);
  });

  it('has no clock at all when the class evidence could not be read', () => {
    const row = boardRowFor('value', entry, boardUser('a'), figure, undefined, undefined);
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
  it('keeps a known board and falls back to value', () => {
    expect(parseBoard('leverage')).toBe('leverage');
    expect(parseBoard('streak')).toBe('streak');
    expect(parseBoard('nonsense')).toBe('value');
    expect(parseBoard(undefined)).toBe('value');
  });

  // The week is the default: the page is about this week, and a typo must not
  // quietly show an all-time board under a "resets Monday" countdown.
  it('defaults the scope to this week', () => {
    expect(parseScope('all')).toBe('all');
    expect(parseScope('week')).toBe('week');
    expect(parseScope('year')).toBe('week');
    expect(parseScope(undefined)).toBe('week');
  });
});

describe('boardMetricName', () => {
  // Namespaced so it cannot collide with F5's own metrics in the same table.
  it('namespaces the board and scope', () => {
    expect(boardMetricName('value', 'week')).toBe('board:value:week');
    expect(boardMetricName('leverage', 'all')).toBe('board:leverage:all');
  });

  it('is unique per board and scope', () => {
    const names = new Set<string>();
    for (const board of BOARD_KEYS) {
      names.add(boardMetricName(board, 'week'));
      names.add(boardMetricName(board, 'all'));
    }
    expect(names.size).toBe(BOARD_KEYS.length * 2);
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
