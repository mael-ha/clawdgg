/**
 * The five boards the homepage is built around.
 *
 * 🪙 tokens      — every token Claude moved (claude_code.token.usage, all types)
 * 💎 value       — API-equivalent dollars (claude_code.cost.usage)
 * 🔥 streak      — current consecutive active days
 * 🌈 ultrathinks — synthetic `clawdgg.ultrathink` flags, never prompts
 * ⚡ leverage    — Claude output characters per character typed
 *
 * ONE FIGURE, ONE SOURCE. Tokens, value, ultrathinks and leverage are read from
 * ClickHouse (the only store that has days); the streak is read from
 * `users.current_streak`, which src/jobs/sync-clickhouse.ts computes from the
 * same ClickHouse days every five minutes. The streak is deliberately NOT
 * recomputed here: the profile and the old leaderboard already print that
 * column, and a second definition on the homepage is how two pages end up
 * disagreeing about the same person.
 *
 * SCOPE IS UTC. "This week" is Monday 00:00 UTC → now, for everyone. Every
 * other time figure in this project is in the user's own zone (see
 * src/lib/timezone.ts), and that is right for "when do YOU work" — but a
 * leaderboard is a shared field, and a per-viewer week would mean two people
 * comparing the same board saw different numbers. The countdown on the page
 * says which clock it is.
 *
 * EXCEPT the class and the clock, which ARE per-user shape questions and so go
 * through each user's timezone — matching what the profile shows, down to the
 * local-month window src/lib/fingerprint.ts classifies on.
 *
 * NO FIGURE THE OWNER TOOK DOWN. A user who hid a profile section is left off
 * the board that ranks on it entirely, rather than listed with a blank: a rank
 * is itself a figure about them, and printing "#3 —" says more than nothing.
 */

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { profileSettings, rankSnapshots, users, type ProfileSettings } from '../db/schema';
import {
  CAPPED_ULTRATHINKS_SQL,
  NO_LEGACY_SQL,
  PROMPT_EVENT_SQL,
  TOTAL_TOKENS_SQL,
  query,
} from '../db/clickhouse';
import { compact } from './format';
import {
  CHARS_PER_TOKEN,
  classifyRhythm,
  classifyStyle,
  ratioOfSums,
  type FingerprintSection,
  type RhythmClass,
  type StyleClass,
} from './fingerprint';
import { localMonth, normalizeTimezone } from './timezone';
import { rankChange, utcDay } from './rank-snapshots';
import { visibilityOf, type Visibility } from './profile-settings';
import { TtlCache } from './ttl-cache';

type AppDb = typeof db;

// ═══════════════════════════════════════════════════════════════════════════
// The boards
// ═══════════════════════════════════════════════════════════════════════════

export type BoardKey = 'tokens' | 'value' | 'streak' | 'ultrathinks' | 'leverage';

/**
 * The two ways to look at a board — which are NOT the same two on every board.
 *
 * Four of them are time windows (this UTC week, or everything). The streak is
 * not a quantity that accumulates over a window: "this week's streak" is not a
 * number anyone has, so that board offers the pair that does exist — the run
 * you are on now, and the longest one you have ever had.
 */
export type BoardScope = 'week' | 'all' | 'current' | 'best';

export interface BoardMeta {
  emoji: string;
  label: string;
  /** Column heading over the figure, without the scope. */
  heading: string;
  /** One line under the podium figure, saying what it measures. */
  caption: string;
  /** The scope switch for this board, in the order it is printed. */
  scopes: readonly [BoardScope, BoardScope];
  /**
   * The scope a board opens on, which is NOT always the leftmost switch.
   *
   * Named rather than inferred from `scopes[0]`, which is what it used to be:
   * 🪙 opens on all time because a lifetime token count is the figure that
   * makes the site's claim, while its switch still reads "this week | all
   * time" like every other windowed board's. Tying the two together meant one
   * of those had to be wrong.
   */
  defaultScope: BoardScope;
  /**
   * The profile section whose owner-hidden flag takes a user off this board.
   *
   * 'curve' carries the streak because the streak IS the daily activity series
   * the curve draws — a user who took that section down has hidden the days a
   * streak is counted from.
   */
  section: FingerprintSection;
}

/** Tab order, and the first one is the board a bare `/` opens on. */
export const BOARD_KEYS = [
  'tokens',
  'value',
  'streak',
  'ultrathinks',
  'leverage',
] as const satisfies readonly BoardKey[];

export const BOARDS: Record<BoardKey, BoardMeta> = {
  tokens: {
    emoji: '🪙',
    label: 'tokens',
    heading: '🪙 tokens',
    caption: 'tokens Claude processed',
    scopes: ['week', 'all'],
    defaultScope: 'all',
    // Same section as 💎, because it is the same rows read a second way: a
    // user who took their value section down has hidden the metrics_raw sums
    // this figure comes out of, and listing their lifetime token count would
    // hand back most of what they put away.
    section: 'value',
  },
  value: {
    emoji: '💎',
    label: 'value',
    heading: '💎 value',
    caption: 'API-equivalent of the work Claude did',
    scopes: ['week', 'all'],
    defaultScope: 'week',
    section: 'value',
  },
  streak: {
    emoji: '🔥',
    label: 'streak',
    heading: '🔥 streak',
    caption: 'consecutive days with a prompt',
    scopes: ['current', 'best'],
    defaultScope: 'current',
    section: 'curve',
  },
  ultrathinks: {
    emoji: '🌈',
    label: 'ultrathinks',
    heading: '🌈 ultrathinks',
    caption: 'prompts that asked Claude to think harder',
    scopes: ['week', 'all'],
    defaultScope: 'week',
    section: 'ultrathink',
  },
  leverage: {
    emoji: '⚡',
    label: 'leverage',
    heading: '⚡ leverage',
    caption: 'characters Claude wrote per character typed',
    scopes: ['week', 'all'],
    defaultScope: 'week',
    section: 'anatomy',
  },
};

/** What the switch says, and what the figure is "of" in a sentence. */
export const SCOPE_LABELS: Record<BoardScope, string> = {
  week: 'this week',
  all: 'all time',
  current: 'current streak',
  best: 'best ever',
};

/** The caption under a podium figure, which the streak's two scopes differ on. */
export function boardCaption(board: BoardKey, scope: BoardScope): string {
  if (board === 'streak') {
    return scope === 'best'
      ? 'the longest run of days they have ever had'
      : 'consecutive days with a prompt, right now';
  }
  return BOARDS[board].caption;
}

/** The board, or the first tab — which is the one a bare `/` has to open on. */
export function parseBoard(raw: string | undefined): BoardKey {
  return BOARD_KEYS.includes(raw as BoardKey) ? (raw as BoardKey) : BOARD_KEYS[0];
}

/**
 * The scope, validated against THIS board's pair.
 *
 * Board-aware because the pairs differ: `?board=value&scope=best` is not a
 * board that exists, and switching from 🔥 to 💎 carries the old scope in the
 * form. Falling back to the board's own default is what makes every
 * combination of the two URL parameters land on something real.
 */
export function parseScope(raw: string | undefined, board: BoardKey = BOARD_KEYS[0]): BoardScope {
  const { scopes, defaultScope } = BOARDS[board];
  return scopes.includes(raw as BoardScope) ? (raw as BoardScope) : defaultScope;
}

/** True when the scope is a time window over ClickHouse rows, not a lifetime figure. */
function isWeekWindow(scope: BoardScope): boolean {
  return scope === 'week';
}

// ═══════════════════════════════════════════════════════════════════════════
// The week
// ═══════════════════════════════════════════════════════════════════════════

const DAY_MS = 86_400_000;

/** Monday 00:00:00.000 UTC of the week containing `now`. */
export function weekStartUtc(now: Date): Date {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
  // getUTCDay: 0 is Sunday, so Sunday is 6 days into a Monday-first week.
  const mondayOffset = (start.getUTCDay() + 6) % 7;
  return new Date(start.getTime() - mondayOffset * DAY_MS);
}

/** The next Monday 00:00 UTC — when every weekly board goes back to zero. */
export function nextWeekStartUtc(now: Date): Date {
  return new Date(weekStartUtc(now).getTime() + 7 * DAY_MS);
}

/**
 * Whole days and hours until the reset, floored.
 *
 * Floored and not rounded because the label reads "in 2d 4h": a reset 2d 4h
 * 59m away is still in its third day, and rounding up to 2d 5h would show a
 * countdown that goes BACKWARDS by an hour on the next page load.
 */
export function resetCountdown(now: Date): { days: number; hours: number } {
  const ms = Math.max(0, nextWeekStartUtc(now).getTime() - now.getTime());
  return {
    days: Math.floor(ms / DAY_MS),
    hours: Math.floor((ms % DAY_MS) / 3_600_000),
  };
}

/** "2d 4h" — the countdown, without the "in". */
export function formatCountdown(now: Date): string {
  const { days, hours } = resetCountdown(now);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

/** 'YYYY-MM-DD HH:MM:SS' for a ClickHouse DateTime comparison, in UTC. */
function chTimestamp(instant: Date): string {
  return instant.toISOString().slice(0, 19).replace('T', ' ');
}

// ═══════════════════════════════════════════════════════════════════════════
// Figures
// ═══════════════════════════════════════════════════════════════════════════

/** Everything a board can rank on, per user, over one scope. */
export interface BoardFigures {
  userId: string;
  /**
   * Every token Claude moved — input, output, cache reads and cache writes
   * together. TOTAL_TOKENS_SQL, which is also what `users.total_tokens`,
   * /api/me and every rank path read, so the figure on this board is the
   * figure on that user's own page.
   */
  tokens: number;
  /** API-equivalent dollars. */
  valueUsd: number;
  /** Synthetic ultrathink flags. NOT prompts — different event name entirely. */
  ultrathinks: number;
  outputTokens: number;
  /** Characters typed, summed over prompts that recorded a length. */
  promptChars: number;
  prompts: number;
  /** Current consecutive active days, as synced. No time window applies. */
  streak: number;
  /** The longest run of days ever, as synced. */
  longestStreak: number;
}

/**
 * Claude output characters per character typed.
 *
 * A ratio of SUMS (total ÷ total), like every other ratio in this project: the
 * average of per-prompt ratios is a different number, and it cannot be checked
 * against the totals printed beside it.
 *
 * Zero when nothing was typed — not Infinity. A user whose prompt lengths were
 * never measured (pre-OTEL rows record no length) has no leverage figure to
 * show, and dividing by nothing would put them at the top of the board.
 */
export function leverageRatio(outputTokens: number, promptChars: number): number {
  return ratioOfSums(outputTokens * CHARS_PER_TOKEN, promptChars);
}

/**
 * The figure one board ranks on, for one user.
 *
 * The scope is a parameter because 🔥 reads a different COLUMN for each of its
 * two (current run vs longest ever), where the other four read the same
 * figure over a different window and so are handed figures already narrowed to
 * it by fetchFigures.
 */
export function boardValue(board: BoardKey, figures: BoardFigures, scope: BoardScope): number {
  switch (board) {
    case 'tokens':
      return figures.tokens;
    case 'value':
      return figures.valueUsd;
    case 'streak':
      return scope === 'best' ? figures.longestStreak : figures.streak;
    case 'ultrathinks':
      return figures.ultrathinks;
    case 'leverage':
      return leverageRatio(figures.outputTokens, figures.promptChars);
  }
}

/**
 * How the figure is printed. Exact, not compacted — a rank is read against it.
 *
 * 🪙 is the exception and has to be: "37,214,882,901" is not a number anybody
 * reads, and nobody is comparing their token count to the next person's digit
 * by digit. It goes through src/lib/format.ts's `compact`, which is the SAME
 * function the profile prints its magnitudes with — a figure this board ranks
 * on must not be spelled one way here and another way on the page it links to.
 */
export function formatBoardValue(board: BoardKey, value: number): string {
  switch (board) {
    case 'tokens':
      return compact(value);
    case 'value':
      return `$${Math.round(value).toLocaleString('en-US')}`;
    case 'streak':
      return `${Math.round(value)} ${Math.round(value) === 1 ? 'day' : 'days'}`;
    case 'ultrathinks':
      return Math.round(value).toLocaleString('en-US');
    case 'leverage':
      // "≈" because the character count behind it is tokens × 4, a rule of
      // thumb and not a measurement.
      return `≈${Math.round(value).toLocaleString('en-US')}×`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The class, and the clock
// ═══════════════════════════════════════════════════════════════════════════

/** Rhythm → the emoji and word the row prints. Same five buckets as the profile. */
const RHYTHM_LABELS: Record<RhythmClass, { emoji: string; word: string }> = {
  'night-owl': { emoji: '🌙', word: 'night' },
  'early-bird': { emoji: '🐦', word: 'early' },
  morning: { emoji: '☀️', word: 'morning' },
  afternoon: { emoji: '🌤', word: 'afternoon' },
  evening: { emoji: '🌆', word: 'evening' },
};

/**
 * "☀️ morning orchestrator", or as much of it as the rows support.
 *
 * Undefined when neither half is known: below MIN_PROMPTS_FOR_CLASS an hour
 * distribution is noise, and a class nobody can check is a horoscope.
 */
export function classLabel(
  rhythm: RhythmClass | null,
  style: StyleClass | null
): string | undefined {
  const label = rhythm ? RHYTHM_LABELS[rhythm] : null;
  if (label && style) return `${label.emoji} ${label.word} ${style}`;
  if (label) return `${label.emoji} ${label.word}`;
  if (style) return style;
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// A page of a board
// ═══════════════════════════════════════════════════════════════════════════

export interface BoardRow {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** The raw figure, so the API's consumer can re-format it. */
  value: number;
  display: string;
  /**
   * Positions gained since the last snapshot. 0 is "did not move"; ABSENT means
   * the user was not in that snapshot — they are new to the board, which is a
   * different thing and printed differently.
   */
  change?: number;
  /** 24 local-hour prompt counts for the mini clock. Absent when hidden. */
  hours?: number[];
  classLabel?: string;
  /** Side figures. Absent when the owner hid the section behind them. */
  ultrathinks?: number;
  streak?: number;
  isViewer?: boolean;
}

export interface BoardPage {
  board: BoardKey;
  scope: BoardScope;
  rows: BoardRow[];
  /** Users listed on this board — the pagination denominator. */
  total: number;
  offset: number;
  /** ISO instant the weekly scope starts at. */
  weekStart: string;
  /** "2d 4h" until the weekly reset. */
  resetIn: string;
  /**
   * The snapshot day the ▲▼ column compares against, or null when this board
   * has no history yet. Null means the column is BLANK rather than full of
   * "new": with no snapshot, nobody has been seen here before.
   */
  comparedTo: string | null;
  /**
   * False when a query failed and the page is missing figures. Never cached —
   * one ClickHouse hiccup must not pin an empty board for the whole TTL.
   */
  complete: boolean;
}

export interface GlobalPulse {
  /** Users with a prompt this week. */
  devs: number;
  valueUsd: number;
  ultrathinks: number;
  /** Hour of day (UTC) the world prompts most, this week. */
  busiestHourUtc: number | null;
  complete: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Who is listed
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Membership, same rule as the leaderboard: a user is listed when ClickHouse
 * has usage for them, and `users.total_*` IS that answer (synced).
 */
const LISTED = sql`(COALESCE(${users.totalPrompts}, 0) > 0 OR COALESCE(${users.totalTokens}, 0) > 0)`;

export interface BoardUser {
  userId: string;
  username: string;
  avatarUrl: string | null;
  timezone: string;
  streak: number;
  longestStreak: number;
  visibility: Visibility;
}

/**
 * Everyone who could appear on a board, with their visibility settings.
 *
 * One query with a LEFT JOIN, not a settings lookup per row: the board lists 25
 * users and the podium needs three more figures for each of them, so an N+1
 * here is 25 round trips before the page has rendered a single number.
 */
export async function loadBoardUsers(database: AppDb = db): Promise<BoardUser[]> {
  const rows = await database
    .select({
      userId: users.id,
      username: users.githubUsername,
      avatarUrl: users.avatarUrl,
      timezone: users.timezone,
      streak: users.currentStreak,
      longestStreak: users.longestStreak,
      settings: profileSettings,
    })
    .from(users)
    .leftJoin(profileSettings, eq(profileSettings.userId, users.id))
    .where(LISTED);

  return rows.map((row) => ({
    userId: row.userId,
    username: row.username,
    avatarUrl: row.avatarUrl,
    timezone: normalizeTimezone(row.timezone),
    streak: row.streak || 0,
    // Both columns come from the sync job's one pass over the active days, so
    // the two 🔥 scopes cannot disagree about the same person.
    longestStreak: row.longestStreak || 0,
    visibility: visibilityOf(row.settings as ProfileSettings | null),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Ranking
// ═══════════════════════════════════════════════════════════════════════════

export interface RankedEntry {
  userId: string;
  value: number;
  rank: number;
}

/**
 * The whole field for one board: positions 1..n, highest first, ties broken by
 * user id — the SAME ordering src/lib/rank-snapshots.ts stores, so the arrow
 * beside a rank is about the position printed next to it.
 *
 * Users who hid the section behind the board are dropped BEFORE ranking, so the
 * ranks are "position among the users who show this figure" and every number on
 * the page is one a reader can count. A zero figure is dropped too: a board of
 * people who have none of the thing is a list, not a ranking.
 */
export function rankBoard(
  board: BoardKey,
  scope: BoardScope,
  boardUsers: BoardUser[],
  figuresByUser: Map<string, BoardFigures>
): RankedEntry[] {
  const section = BOARDS[board].section;
  const eligible: { userId: string; value: number }[] = [];

  for (const user of boardUsers) {
    if (!user.visibility[section]) continue;
    const figures = figuresByUser.get(user.userId) ?? emptyFigures(user);
    const value = boardValue(board, figures, scope);
    if (value <= 0) continue;
    eligible.push({ userId: user.userId, value });
  }

  // Deliberately NOT assignRanks(): that one breaks ties with localeCompare,
  // and the snapshot side of these boards is SQL `ORDER BY value DESC, id ASC`,
  // which is a BINARY comparison. The two disagree on ids like `github_1_x` vs
  // `github_10` (locale collation ignores the underscore), and a tie ordered
  // one way in the snapshot and the other way on the page shows both users a
  // ±1 arrow that nothing happened to cause.
  return [...eligible]
    .sort((a, b) => b.value - a.value || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/** A user ClickHouse had nothing for in the window. The streaks are still theirs. */
function emptyFigures(user: Pick<BoardUser, 'userId' | 'streak' | 'longestStreak'>): BoardFigures {
  return {
    userId: user.userId,
    tokens: 0,
    valueUsd: 0,
    ultrathinks: 0,
    outputTokens: 0,
    promptChars: 0,
    prompts: 0,
    streak: user.streak,
    longestStreak: user.longestStreak,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ClickHouse: the figures, in one pass per scope
// ═══════════════════════════════════════════════════════════════════════════

interface FigureRow {
  user_id: string;
  tokens: number;
  value_usd: number;
  ultrathinks: number;
  output_tokens: number;
  prompt_chars: number;
  prompts: number;
}

/**
 * `timestamp` in each listed user's own wall clock, as a ClickHouse expression.
 *
 * ClickHouse `toTimeZone` needs a CONSTANT zone, so it cannot batch users who
 * live in different ones. Shifting by each user's current offset gives the same
 * local wall clock in one pass. The caveat is DST: a row on the far side of a
 * transition lands an hour off, which moves nothing that matters here — a bar
 * on a 30px clock, or a prompt at local midnight into the neighbouring day.
 *
 * The ids go in as parameters (`param_u0`, …), never as literals: ClickHouse
 * substitutes them before parsing, which is what makes this injection-proof.
 */
function localTsExpr(
  boardUsers: BoardUser[],
  now: Date
): { expr: string; params: Record<string, string> } {
  if (boardUsers.length === 0) return { expr: 'timestamp', params: {} };

  const params: Record<string, string> = {};
  const branches = boardUsers.map((user, index) => {
    params[`u${index}`] = user.userId;
    return `user_id = {u${index}:String}, ${offsetMinutes(user.timezone, now)}`;
  });
  return { expr: `timestamp + toIntervalMinute(multiIf(${branches.join(', ')}, 0))`, params };
}

/**
 * Tokens, value, ultrathinks, output tokens and typed characters for every
 * user, over one scope, in one query.
 *
 * Legacy rows are included in the sums (they are honest about WHAT happened)
 * but they carry no prompt_length, which is why `prompt_chars` is summed over
 * measured prompts only — see leverageRatio for why that matters.
 */
async function fetchFigures(
  scope: BoardScope,
  boardUsers: BoardUser[],
  now: Date
): Promise<Map<string, BoardFigures>> {
  const known = new Map(boardUsers.map((u) => [u.userId, u]));
  const measured = `${PROMPT_EVENT_SQL} AND prompt_length > 0`;
  // Only 'week' narrows the rows. The streak board's two scopes are lifetime
  // figures read from SQLite, so its ClickHouse figures — the 🌈 and 🔥 beside
  // each row — are all-time there, like 'all time' on the other boards.
  const window = isWeekWindow(scope)
    ? `timestamp >= toDateTime64({since:String}, 3, 'UTC')`
    : '1 = 1';
  const local = localTsExpr(boardUsers, now);

  const [events, metrics] = await Promise.all([
    // Per local day first, so the ultrathink cap can be applied where it means
    // something, then summed per user. The prompt and character totals are
    // unaffected by the grouping — a sum of days is the same sum.
    query<Pick<FigureRow, 'user_id' | 'ultrathinks' | 'prompt_chars' | 'prompts'>>(
      `SELECT
         user_id,
         toUInt64(sum(day_ultrathinks)) AS ultrathinks,
         toUInt64(sum(day_chars)) AS prompt_chars,
         toUInt64(sum(day_prompts)) AS prompts
       FROM (
         SELECT
           user_id,
           ${CAPPED_ULTRATHINKS_SQL} AS day_ultrathinks,
           sumIf(prompt_length, ${measured}) AS day_chars,
           countIf(${PROMPT_EVENT_SQL}) AS day_prompts
         FROM (
           SELECT user_id, event_name, command_source, prompt_length, ${local.expr} AS ts_local
           FROM events_raw
           WHERE ${window}
         )
         GROUP BY user_id, toDate(ts_local)
       )
       GROUP BY user_id`,
      { since: chTimestamp(weekStartUtc(now)), ...local.params }
    ),
    query<Pick<FigureRow, 'user_id' | 'tokens' | 'value_usd' | 'output_tokens'>>(
      `SELECT
         user_id,
         -- 🪙 — THE shared definition, so this board cannot drift from the
         -- figure the same user's own page and /api/me print. Every token
         -- type, no provenance filter; src/db/clickhouse.ts says why.
         -- The ⚡ sum below is the only token count on this page that is
         -- narrower, because it is one side of a RATIO whose other side a
         -- legacy row cannot contribute to.
         toUInt64(${TOTAL_TOKENS_SQL}) AS tokens,
         toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage')) AS value_usd,
         -- NO_LEGACY_SQL, to match the characters typed on the other side of
         -- the ⚡ ratio: prompt_chars above is summed over measured prompts
         -- only, and a legacy row has no prompt_length. Counting its output
         -- tokens anyway made every pre-OTEL user look like they typed a word
         -- and got a novel back — and ranked them above everyone on a board
         -- that is a RATIO. src/lib/fingerprint.ts has the same predicate on
         -- the same sum, which is why the board and the profile disagreed.
         toUInt64(sumIf(value, metric_name = 'claude_code.token.usage'
                               AND token_type = 'output' AND ${NO_LEGACY_SQL})) AS output_tokens
       FROM metrics_raw
       WHERE ${window}
       GROUP BY user_id`,
      { since: chTimestamp(weekStartUtc(now)) }
    ),
  ]);

  const byUser = new Map<string, BoardFigures>();
  const figuresFor = (userId: string) => {
    const existing = byUser.get(userId);
    if (existing) return existing;
    const user = known.get(userId);
    const fresh = emptyFigures({
      userId,
      streak: user?.streak ?? 0,
      longestStreak: user?.longestStreak ?? 0,
    });
    byUser.set(userId, fresh);
    return fresh;
  };

  for (const row of events) {
    const figures = figuresFor(row.user_id);
    figures.ultrathinks = Number(row.ultrathinks) || 0;
    figures.promptChars = Number(row.prompt_chars) || 0;
    figures.prompts = Number(row.prompts) || 0;
  }
  for (const row of metrics) {
    const figures = figuresFor(row.user_id);
    figures.tokens = Number(row.tokens) || 0;
    figures.valueUsd = Number(row.value_usd) || 0;
    figures.outputTokens = Number(row.output_tokens) || 0;
  }
  // A user with no ClickHouse rows in the window still has a streak.
  for (const user of boardUsers) figuresFor(user.userId);

  return byUser;
}

// ═══════════════════════════════════════════════════════════════════════════
// ClickHouse: the class and the clock, for the listed page only
// ═══════════════════════════════════════════════════════════════════════════

/**
 * An IN list of parameters, so a user id never reaches the SQL as a literal.
 * ClickHouse substitutes parameters before parsing, which is what makes this
 * safe — `query` sends them as `param_*` on the URL.
 */
function idParams(userIds: string[]): { list: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const names = userIds.map((id, index) => {
    params[`u${index}`] = id;
    return `{u${index}:String}`;
  });
  return { list: names.join(', '), params };
}

/**
 * Each user's offset from UTC in minutes, right now.
 *
 * The per-row alternative is ClickHouse `toTimeZone`, which needs a CONSTANT
 * zone and so cannot batch users in different zones. Shifting the timestamp by
 * the offset gives the same local wall clock, with one caveat: a row on the far
 * side of a DST transition lands an hour off. That is a bar's width on a 30px
 * clock, and the class it feeds is read from a whole month of rows.
 */
function offsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

export interface ClassEvidence {
  hours: number[];
  prompts: number;
  tools: number;
  subagentValue: number;
  attributedValue: number;
}

/**
 * Hours, tool calls and the subagent value split for the listed users, over
 * each one's CURRENT LOCAL MONTH — the same window and the same inputs
 * src/lib/fingerprint.ts classifies a profile on, so the class printed beside a
 * handle here is the class on that handle's page.
 *
 * Two queries for the whole page, grouped by user and local month. The month is
 * read back in JS rather than filtered in SQL because "the current local month"
 * is a different month for different users on the first and last day of one.
 */
async function fetchClassEvidence(
  pageUsers: BoardUser[],
  now: Date
): Promise<Map<string, ClassEvidence>> {
  const evidence = new Map<string, ClassEvidence>();
  if (pageUsers.length === 0) return evidence;

  const { list, params } = idParams(pageUsers.map((u) => u.userId));
  // Same parameter names on both sides — idParams and localTsExpr number users
  // identically, which is what lets one params object serve the IN list and
  // the offsets.
  const localTs = localTsExpr(pageUsers, now).expr;

  // 70 days is "this local month, whatever day it is" with room to spare, and
  // it keeps the row count at users × 24 × 3 instead of users × 24 × forever.
  const [eventRows, valueRows] = await Promise.all([
    query<{ user_id: string; month: string; hour: number; prompts: number; tools: number }>(
      `SELECT
         user_id,
         formatDateTime(ts_local, '%Y-%m') AS month,
         toUInt8(toHour(ts_local)) AS hour,
         toUInt64(countIf(${PROMPT_EVENT_SQL})) AS prompts,
         toUInt64(countIf(event_name = 'claude_code.tool_result')) AS tools
       FROM (
         SELECT user_id, event_name, command_source, ${localTs} AS ts_local
         FROM events_raw
         WHERE user_id IN (${list})
           AND ${NO_LEGACY_SQL}
           AND timestamp >= now() - INTERVAL 70 DAY
       )
       GROUP BY user_id, month, hour`,
      params
    ),
    query<{ user_id: string; month: string; subagent: number; attributed: number }>(
      `SELECT
         user_id,
         formatDateTime(ts_local, '%Y-%m') AS month,
         toFloat64(sumIf(value, query_source = 'subagent')) AS subagent,
         toFloat64(sumIf(value, query_source != '')) AS attributed
       FROM (
         SELECT user_id, value, query_source, ${localTs} AS ts_local
         FROM metrics_raw
         WHERE user_id IN (${list})
           AND metric_name = 'claude_code.cost.usage'
           AND ${NO_LEGACY_SQL}
           AND timestamp >= now() - INTERVAL 70 DAY
       )
       GROUP BY user_id, month`,
      params
    ),
  ]);

  const months = new Map(pageUsers.map((u) => [u.userId, localMonth(now, u.timezone)]));
  for (const user of pageUsers) {
    evidence.set(user.userId, {
      hours: Array<number>(24).fill(0),
      prompts: 0,
      tools: 0,
      subagentValue: 0,
      attributedValue: 0,
    });
  }

  for (const row of eventRows) {
    const entry = evidence.get(row.user_id);
    if (!entry || row.month !== months.get(row.user_id)) continue;
    const hour = Number(row.hour);
    const prompts = Number(row.prompts) || 0;
    if (hour >= 0 && hour < 24) entry.hours[hour]! += prompts;
    entry.prompts += prompts;
    entry.tools += Number(row.tools) || 0;
  }
  for (const row of valueRows) {
    const entry = evidence.get(row.user_id);
    if (!entry || row.month !== months.get(row.user_id)) continue;
    entry.subagentValue += Number(row.subagent) || 0;
    entry.attributedValue += Number(row.attributed) || 0;
  }

  return evidence;
}

/** The class verdict for one user, from the evidence above. */
export function classFromEvidence(evidence: ClassEvidence | undefined): string | undefined {
  if (!evidence) return undefined;
  const { rhythm } = classifyRhythm(evidence.hours);
  const style = classifyStyle({
    // Share of ATTRIBUTED value only — rows from before query_source existed
    // carry no attribution, and counting them as main-thread would read as a
    // habit nobody demonstrated. Same rule as the profile.
    subagentSharePct:
      evidence.attributedValue > 0
        ? (evidence.subagentValue * 100) / evidence.attributedValue
        : 0,
    toolCallsPerPrompt: ratioOfSums(evidence.tools, evidence.prompts),
    prompts: evidence.prompts,
  });
  return classLabel(rhythm, style);
}

// ═══════════════════════════════════════════════════════════════════════════
// Rank snapshots for the five boards
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The `rank_snapshots.metric` name for one board and scope.
 *
 * Namespaced so it cannot collide with F5's own metrics (prompts, tokens,
 * lines, commits, cost) in the same table. Reusing the table rather than adding
 * one is deliberate: `metric` is free text with a unique index on
 * (user, day, metric), which is exactly the shape this needs.
 */
export function boardMetricName(board: BoardKey, scope: BoardScope): string {
  return `board:${board}:${scope}`;
}

/**
 * The one metric name whose presence means "today is already on record".
 *
 * Derived from the FIRST board rather than named, and from its default scope,
 * which is the one scope of it a listed user is certain to be on. Two reasons,
 * and the first is what used to be wrong: it was hardcoded to `board:value:all`,
 * so the day 🪙 shipped, every day that had already been snapshotted was
 * considered done and the new board got no row until the next UTC midnight —
 * a board cannot show a ▲▼ against a day it was not in, so its arrows were two
 * days away instead of one. With the sentinel following BOARD_KEYS[0], adding a
 * board backfills the current day on the sync job's next pass.
 *
 * The second: a sentinel on a scope nobody is ranked on would never be written,
 * and the job would then redo the whole fan-out every five minutes forever.
 * 🪙 over all time is non-empty for everyone the board lists, by construction —
 * LISTED is "ClickHouse has usage for them".
 *
 * Re-running a partly-snapshotted day is safe: every insert is
 * onConflictDoNothing against the unique index on (user, day, metric), so the
 * boards already on record keep the rows they have.
 */
export function boardSnapshotSentinel(): string {
  const board = BOARD_KEYS[0];
  return boardMetricName(board, BOARDS[board].defaultScope);
}

/** The UTC day each database last had its board figures scanned for. */
const boardSnapshotAttempted = new WeakMap<AppDb, string>();

/**
 * Write today's ranks for all five boards, both scopes, unless today is already
 * on record.
 *
 * THE SYNC JOB MUST CALL THIS. One line, after it has refreshed users.total_*
 * and called snapshotRanks() (src/jobs/sync-clickhouse.ts):
 *
 *     await snapshotBoardRanks();
 *
 * Without it the ▲▼ column on these boards is permanently empty — not wrong,
 * empty: rankChange() invents nothing when there is no previous snapshot.
 *
 * Returns the number of rows written: 0 on every run but the first of the day.
 */
export async function snapshotBoardRanks(
  now: Date = new Date(),
  database: AppDb = db
): Promise<number> {
  const day = utcDay(now);
  if (boardSnapshotAttempted.get(database) === day) return 0;
  const sentinel = boardSnapshotSentinel();

  const existing = await database
    .select({ userId: rankSnapshots.userId })
    .from(rankSnapshots)
    .where(and(eq(rankSnapshots.day, day), eq(rankSnapshots.metric, sentinel)))
    .limit(1)
    .get();
  if (existing) return 0;

  const boardUsers = await loadBoardUsers(database);
  if (boardUsers.length === 0) return 0;

  const [weekFigures, allFigures] = await Promise.all([
    fetchFigures('week', boardUsers, now),
    fetchFigures('all', boardUsers, now),
  ]);
  // Once the figures are in hand, today counts as done whatever gets written.
  // The sentinel is one board's default scope, so a day on which that board
  // ranks nobody writes no sentinel, and without this the sync job would pay
  // for both full-table figure scans again every five minutes until midnight.
  boardSnapshotAttempted.set(database, day);

  const values: { userId: string; day: string; metric: string; rank: number; value: number }[] = [];
  for (const board of BOARD_KEYS) {
    // Each board's OWN pair of scopes — 🔥 snapshots current and best, the
    // others this week and all time, under their own metric names.
    for (const scope of BOARDS[board].scopes) {
      const figures = isWeekWindow(scope) ? weekFigures : allFigures;
      for (const entry of rankBoard(board, scope, boardUsers, figures)) {
        values.push({
          userId: entry.userId,
          day,
          metric: boardMetricName(board, scope),
          rank: entry.rank,
          // Stored as an integer beside the rank, for traceability. Leverage
          // and value are rounded; the rank is what the arrow is about.
          value: Math.round(entry.value),
        });
      }
    }
  }

  if (values.length === 0) return 0;

  for (let i = 0; i < values.length; i += 500) {
    await database.insert(rankSnapshots).values(values.slice(i, i + 500)).onConflictDoNothing();
  }
  return values.length;
}

export interface BoardMovement {
  /**
   * The snapshot day everything was compared against, or null when there is
   * none to compare with. Null is the difference between "this user is new" and
   * "this board has no history yet", and the page prints those differently.
   */
  previousDay: string | null;
  /**
   * Positions gained since that day, per user. ZERO IS A VALUE: it means the
   * user was there and has not moved, which is "—" on the page. A user missing
   * from the map was not in the snapshot at all, which is "new".
   */
  changes: Map<string, number>;
}

/**
 * ▲▼ per user for one board, against the most recent earlier snapshot.
 *
 * "The most recent earlier day", not "yesterday": a server that was down for a
 * day leaves a gap, and comparing against a day that was never written would
 * hide every arrow until the gap aged out.
 *
 * A weekly board gets NO arrows across a week boundary. Monday's field is a
 * fresh one — everybody is back at zero — so an arrow against last week's
 * positions would describe a race that has been restarted.
 */
export async function boardRankChanges(
  board: BoardKey,
  scope: BoardScope,
  userIds: string[],
  currentRanks: Map<string, number>,
  now: Date = new Date(),
  database: AppDb = db
): Promise<BoardMovement> {
  const changes = new Map<string, number>();
  if (userIds.length === 0) return { previousDay: null, changes };

  const metric = boardMetricName(board, scope);
  const previous = await database
    .select({ day: rankSnapshots.day })
    .from(rankSnapshots)
    .where(and(eq(rankSnapshots.metric, metric), lt(rankSnapshots.day, utcDay(now))))
    .orderBy(desc(rankSnapshots.day))
    .limit(1)
    .get();
  if (!previous) return { previousDay: null, changes };
  if (scope === 'week' && previous.day < utcDay(weekStartUtc(now))) {
    return { previousDay: null, changes };
  }

  const rows = await database
    .select({ userId: rankSnapshots.userId, rank: rankSnapshots.rank })
    .from(rankSnapshots)
    .where(
      and(
        eq(rankSnapshots.metric, metric),
        eq(rankSnapshots.day, previous.day),
        inArray(rankSnapshots.userId, userIds)
      )
    );

  for (const row of rows) {
    const current = currentRanks.get(row.userId);
    if (current === undefined) continue;
    const change = rankChange(row.rank, current);
    if (change !== undefined) changes.set(row.userId, change);
  }

  return { previousDay: previous.day, changes };
}

// ═══════════════════════════════════════════════════════════════════════════
// Assembling a page
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One row, with every part the owner took down left OUT.
 *
 * Absent and not zeroed, for the same reason the fingerprint omits a hidden
 * section: a zero is a claim about the data ("no ultrathinks"), an absent
 * figure is a claim about the owner's choice, and only one of them is true.
 * The clock, the class and both side figures each hang off their own section,
 * so hiding the rings takes away the dial and leaves the class.
 */
export function boardRowFor(
  board: BoardKey,
  scope: BoardScope,
  entry: RankedEntry,
  user: BoardUser,
  figures: BoardFigures | undefined,
  evidence: ClassEvidence | undefined,
  change: number | undefined
): BoardRow {
  const row: BoardRow = {
    rank: entry.rank,
    userId: entry.userId,
    username: user.username,
    avatarUrl: user.avatarUrl,
    value: entry.value,
    display: formatBoardValue(board, entry.value),
  };
  if (change !== undefined) row.change = change;
  if (user.visibility.rings && evidence) row.hours = evidence.hours;
  if (user.visibility.class) {
    const label = classFromEvidence(evidence);
    if (label) row.classLabel = label;
  }
  // No figures means they could not be READ, which is not the same as zero —
  // during a ClickHouse outage the streak board still ranks, and the 🌈 column
  // beside it goes blank instead of claiming everyone has none.
  if (user.visibility.ultrathink && figures) row.ultrathinks = figures.ultrathinks;
  // The 🔥 side figure is the CURRENT streak, so it is left off the board that
  // already prints it — "19 days · 🔥 19" is one number twice. Beside a best
  // ever it stays, because there the two differ and the pair is the story.
  if (user.visibility.curve && !(board === 'streak' && scope === 'current')) {
    row.streak = user.streak;
  }
  return row;
}

export interface BoardQuery {
  board: BoardKey;
  scope: BoardScope;
  limit: number;
  offset: number;
  /** The signed-in user, so their row can be marked. Never changes the figures. */
  viewerId?: string | null;
  now?: Date;
}

/** Rows per page. A caller may ask for fewer; it may not ask for more. */
export const MAX_BOARD_LIMIT = 100;
export const DEFAULT_BOARD_LIMIT = 25;

export function clampBoardLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_BOARD_LIMIT;
  return Math.min(MAX_BOARD_LIMIT, Math.max(1, Math.floor(raw)));
}

/**
 * An offset no further than the end of the board.
 *
 * `?offset=9999999` used to be a cache key of its own, and every one of them a
 * full fan-out: loadBoardUsers, both ClickHouse figure queries, the ranking.
 * Clamping to the length means the pages past the end are ONE key and the key
 * space is bounded by the number of users there are, not by what a URL can
 * hold. (The slice is then empty, which is the right answer: `remaining` goes
 * to zero and the load-more button stops.)
 */
export function clampBoardOffset(raw: number, total: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(0, total), Math.max(0, Math.floor(raw)));
}

/**
 * The ranking, which is the whole cost of a board, cached per BOARD AND SCOPE.
 *
 * Ten keys in total — five boards, two scopes each — and not one per page,
 * which is what the cache used to hold. Pagination is a SLICE of this, so a
 * request for page 400 of a board nobody has 400 pages of now costs a slice of
 * a list that is already in memory instead of the fan-out that built it.
 */
interface BoardRanking {
  ranked: RankedEntry[];
  usersById: Map<string, BoardUser>;
  figures: Map<string, BoardFigures>;
  weekStart: string;
  /** False when a figures query failed — never cached, see getRanking. */
  complete: boolean;
}

// 60s: long enough that a burst of homepage loads costs one query fan-out,
// short enough that a board feels live. Errors are never cached (see `complete`).
const rankingCache = new TtlCache<BoardRanking>(60_000, 16);
/**
 * The DECORATED page — the ranking's slice plus each row's clock, class and
 * arrow. Still per (board, scope, limit, offset), because the decoration is
 * per page, but a miss here is now two queries for 25 users rather than the
 * whole board: the expensive part is in rankingCache above.
 */
const boardCache = new TtlCache<BoardPage>(60_000, 200);
const pulseCache = new TtlCache<GlobalPulse>(60_000, 8);

/** Drop every board cache. For tests, which compare one build with another. */
export function clearBoardCaches(): void {
  rankingCache.clear();
  boardCache.clear();
  pulseCache.clear();
}

async function getRanking(
  board: BoardKey,
  scope: BoardScope,
  now: Date
): Promise<BoardRanking> {
  // The UTC DAY is in the key as well as the board and the scope. Two reasons:
  // the weekly scope's window is a function of `now`, so a request either side
  // of Monday 00:00 UTC must not be served a ranking built for the week that
  // ended (the 60-second TTL alone would serve it for a minute into the new
  // week, with the old week's figures and the old `weekStart`); and a caller
  // that passes an explicit `now` — a test — gets its own key rather than
  // whatever the last call left behind.
  return rankingCache.remember(
    `${board}|${scope}|${utcDay(now)}`,
    () => buildRanking(board, scope, now),
    (built) => built.complete
  );
}

async function buildRanking(
  board: BoardKey,
  scope: BoardScope,
  now: Date
): Promise<BoardRanking> {
  const boardUsers = await loadBoardUsers();

  // A ClickHouse outage is not a reason to show nothing: the streak board is
  // read from SQLite and stays correct, and the other four come out empty
  // rather than wrong. `complete` goes false either way, so the page says so
  // and nothing is cached.
  let figures = new Map<string, BoardFigures>();
  let complete = true;
  try {
    figures = await fetchFigures(scope, boardUsers, now);
  } catch (error) {
    console.error('[boards] figures unavailable:', error);
    complete = false;
  }

  return {
    ranked: rankBoard(board, scope, boardUsers, figures),
    usersById: new Map(boardUsers.map((u) => [u.userId, u])),
    figures,
    weekStart: weekStartUtc(now).toISOString(),
    complete,
  };
}

export async function getBoardPage(options: BoardQuery): Promise<BoardPage> {
  const { board, scope, viewerId } = options;
  const now = options.now ?? new Date();
  const limit = clampBoardLimit(options.limit);

  // The ranking first, because it is what the offset is bounded by — and it is
  // the cached part, so asking for it costs nothing the next caller repeats.
  const ranking = await getRanking(board, scope, now);
  const offset = clampBoardOffset(options.offset, ranking.ranked.length);

  const page = await boardCache.remember(
    `${board}|${scope}|${utcDay(now)}|${limit}|${offset}`,
    () => decorateBoardPage(board, scope, ranking, limit, offset, now),
    (built) => built.complete
  );
  // The viewer mark is per-request, so it is applied AFTER the cache: one
  // signed-in user must not get their highlight baked into everyone's page.
  if (!viewerId) return page;
  return {
    ...page,
    rows: page.rows.map((row) =>
      row.userId === viewerId ? { ...row, isViewer: true } : row
    ),
  };
}

async function decorateBoardPage(
  board: BoardKey,
  scope: BoardScope,
  ranking: BoardRanking,
  limit: number,
  offset: number,
  now: Date
): Promise<BoardPage> {
  const { ranked, usersById, figures } = ranking;
  const base = {
    board,
    scope,
    offset,
    weekStart: ranking.weekStart,
    resetIn: formatCountdown(now),
  };

  const slice = ranked.slice(offset, offset + limit);
  const pageUsers = slice
    .map((entry) => usersById.get(entry.userId))
    .filter((user): user is BoardUser => !!user);

  let complete = ranking.complete;
  let evidence = new Map<string, ClassEvidence>();
  try {
    evidence = await fetchClassEvidence(pageUsers, now);
  } catch (error) {
    // The class and the clock are the decoration on a row, not its figure: a
    // board with the numbers and no clocks is worth serving, but it is not
    // worth remembering, so `complete` goes false and the next load retries.
    console.error('[boards] class evidence unavailable:', error);
    complete = false;
  }

  const movement = await boardRankChanges(
    board,
    scope,
    slice.map((entry) => entry.userId),
    new Map(slice.map((entry) => [entry.userId, entry.rank])),
    now
  );

  const rows = slice.map((entry) =>
    boardRowFor(
      board,
      scope,
      entry,
      usersById.get(entry.userId)!,
      figures.get(entry.userId),
      evidence.get(entry.userId),
      movement.changes.get(entry.userId)
    )
  );

  return { ...base, rows, total: ranked.length, comparedTo: movement.previousDay, complete };
}

/**
 * The week's global figures — the strip under the board.
 *
 * Aggregates only. A user who hid a section is still in these sums: what they
 * took down is their own figure on their own page, and an anonymous total is
 * not that. Nothing here can be attributed back to one person.
 */
export async function getGlobalPulse(now: Date = new Date()): Promise<GlobalPulse> {
  return pulseCache.remember(
    utcDay(now),
    () => buildGlobalPulse(now),
    (pulse) => pulse.complete
  );
}

async function buildGlobalPulse(now: Date): Promise<GlobalPulse> {
  const since = chTimestamp(weekStartUtc(now));
  const window = `timestamp >= toDateTime64({since:String}, 3, 'UTC')`;
  // The strip's 🌈 total has to be the sum of the figures on the 🌈 board, so
  // it is read through the same per-local-day cap — which needs the same
  // per-user offsets, which is why the pulse loads the user list at all.
  const local = localTsExpr(await loadBoardUsers(), now);

  try {
    const [events, value] = await Promise.all([
      query<{ hour: number; prompts: number }>(
        `SELECT
           toUInt8(toHour(timestamp)) AS hour,
           toUInt64(countIf(${PROMPT_EVENT_SQL})) AS prompts
         FROM events_raw
         WHERE ${window}
           AND ${NO_LEGACY_SQL}
         GROUP BY hour`,
        { since }
      ),
      query<{ value_usd: number }>(
        `SELECT toFloat64(sum(value)) AS value_usd
         FROM metrics_raw
         WHERE ${window}
           AND metric_name = 'claude_code.cost.usage'`,
        { since }
      ),
    ]);

    // A count of people cannot be summed out of the hourly buckets — somebody
    // who worked at 09:00 and at 14:00 is in two of them — so it gets its own
    // pass, together with the capped ultrathink total.
    const totals = await query<{ devs: number; ultrathinks: number }>(
      `SELECT
         toUInt64(uniqExact(user_id)) AS devs,
         toUInt64(sum(day_ultrathinks)) AS ultrathinks
       FROM (
         SELECT
           user_id,
           ${CAPPED_ULTRATHINKS_SQL} AS day_ultrathinks,
           countIf(${PROMPT_EVENT_SQL}) AS day_prompts
         FROM (
           SELECT user_id, event_name, command_source, ${local.expr} AS ts_local
           FROM events_raw
           WHERE ${window}
         )
         GROUP BY user_id, toDate(ts_local)
         HAVING day_prompts > 0
       )`,
      { since, ...local.params }
    );

    let busiestHourUtc: number | null = null;
    let busiest = 0;
    for (const row of events) {
      const prompts = Number(row.prompts) || 0;
      if (prompts > busiest) {
        busiest = prompts;
        busiestHourUtc = Number(row.hour);
      }
    }

    return {
      devs: Number(totals[0]?.devs) || 0,
      valueUsd: Number(value[0]?.value_usd) || 0,
      ultrathinks: Number(totals[0]?.ultrathinks) || 0,
      busiestHourUtc,
      complete: true,
    };
  } catch (error) {
    console.error('[boards] pulse unavailable:', error);
    return { devs: 0, valueUsd: 0, ultrathinks: 0, busiestHourUtc: null, complete: false };
  }
}
