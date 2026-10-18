/**
 * The fingerprint: who a person is, in their own numbers.
 *
 * One typed payload for the profile — the headline value, the anatomy of an
 * average prompt, the conversation balance, four rings, a monthly class with
 * the evidence behind it, and dated milestones. Every figure here is computed
 * from ClickHouse rows and nothing else, and every ratio is a ratio of SUMS
 * (total ÷ total) rather than an average of per-row ratios: the two differ, and
 * only the first reconciles against the totals shown elsewhere on the page.
 *
 * TIME IS LOCAL. Hours, weekdays, months and week boundaries all go through
 * the user's `users.timezone` — see src/lib/timezone.ts for why that is not a
 * cosmetic detail. Anything that reads the SHAPE of a day also excludes
 * `provenance='legacy'`, because those rows are all stamped 12:00 UTC.
 *
 * VALUE, NOT SPEND. Every dollar figure is `claude_code.cost.usage`: what the
 * same work would have cost at API prices. Most people here are on a Max plan
 * and paid none of it. The model mix is split by this value and not by tokens
 * deliberately — ~95% of tokens are cache reads, which cost a twentieth of
 * fresh input, so a token split says "you use whatever model reads the most
 * context" instead of where the money went.
 */

import {
  LOCAL_TS_SQL,
  MODEL_ID_SQL,
  NO_LEGACY_SQL,
  PROMPT_EVENT_SQL,
  ULTRATHINK_EVENT_SQL,
  query,
} from '../db/clickhouse';
import { getModelDisplayName } from './pricing';
import {
  DEFAULT_TIMEZONE,
  localMonth,
  normalizeTimezone,
  toClickHouseTimestamp,
  weekBounds,
} from './timezone';

// ═══════════════════════════════════════════════════════════════════════════
// The payload
// ═══════════════════════════════════════════════════════════════════════════

/** Sections the owner can hide. The names are the API's contract. */
export const FINGERPRINT_SECTIONS = [
  'value',
  'anatomy',
  'conversation',
  'rings',
  'class',
  'milestones',
  'curve',
  'year',
  'ultrathink',
  'plan',
] as const;

export type FingerprintSection = (typeof FINGERPRINT_SECTIONS)[number];

export interface ValueFigures {
  /** API-equivalent value in the current local Mon–Sun week. */
  thisWeek: number;
  lastWeek: number;
  /** Percent change week on week, or null when last week was zero. */
  deltaPct: number | null;
  allTime: number;
  /** ISO instant the current week starts at, so the UI can name the week. */
  weekStart: string;
}

export interface AnatomyFigures {
  prompts: number;
  /** quantileExact(0.5), over prompts whose length was recorded. */
  medianPromptChars: number;
  toolCallsPerPrompt: number;
  linesPerPrompt: number;
  valuePerPrompt: number;
}

export interface Anatomy {
  allTime: AnatomyFigures;
  last30d: AnatomyFigures;
}

export interface Conversation {
  /** Sum of prompt_length — characters the human typed. */
  charsTyped: number;
  outputTokens: number;
  /** outputTokens × 4. An ESTIMATE, and the UI must say so. */
  approxOutputChars: number;
  /** Characters Claude wrote per character typed, or null with nothing typed. */
  ratio: number | null;
}

export interface RingItem {
  name: string;
  value: number;
  share: number;
}

export interface ModelVersionShare {
  name: string;
  value: number;
  share: number;
}

export interface ModelFamilyShare {
  family: string;
  value: number;
  share: number;
  versions: ModelVersionShare[];
}

export interface Rings {
  /** 24 buckets of prompts, index = hour in LOCAL time. */
  hours: number[];
  /** 7 buckets of prompts, index 0 = MONDAY. */
  weekdays: number[];
  /** Dominant hour bucket, for the ring's centre label. */
  peakHour: { hour: number; share: number } | null;
  /** Dominant weekday, index 0 = Monday. */
  busiestDay: { weekday: number; share: number } | null;
  /** Share of prompts falling Monday–Friday. */
  weekdayShare: number;
  languages: RingItem[];
  topLanguage: RingItem | null;
  models: ModelFamilyShare[];
  topModel: ModelFamilyShare | null;
}

export type RhythmClass = 'early-bird' | 'morning' | 'afternoon' | 'evening' | 'night-owl';
export type StyleClass = 'orchestrator' | 'autopilot' | 'pair-programmer';

export interface RhythmEvidence {
  /** Share of prompts per bucket, in the same order as RHYTHM_BUCKETS. */
  shares: Record<RhythmClass, number>;
  /**
   * Share ÷ the share of the day the bucket covers. 1.0 is "no preference".
   * This, not the raw share, is what picks the rhythm — see classifyRhythm.
   */
  density: Record<RhythmClass, number>;
  peakHour: number | null;
  prompts: number;
}

export interface StyleEvidence {
  /** Percent of API-equivalent value spent in subagents (query_source). */
  subagentSharePct: number;
  toolCallsPerPrompt: number;
  prompts: number;
}

export interface ClassVerdict {
  /** 'YYYY-MM' in local time. */
  month: string;
  rhythm: RhythmClass | null;
  style: StyleClass | null;
}

export interface UserClass extends ClassVerdict {
  rhythm_evidence: RhythmEvidence;
  style_evidence: StyleEvidence;
  /** Earlier months, newest first. The current month is NOT repeated here. */
  history: ClassVerdict[];
}

export type MilestoneKind = 'prompts' | 'lines' | 'streak' | 'ultrathink' | 'model';

export interface Milestone {
  key: string;
  label: string;
  emoji: string;
  kind: MilestoneKind;
  /** Local date (YYYY-MM-DD) the threshold was crossed. */
  date: string;
  /** The threshold itself, so the UI never has to parse the label. */
  value: number;
  /**
   * Share of active users who have also crossed it, and the tier that follows.
   * OMITTED below MIN_USERS_FOR_RARITY: with a few dozen users "top 5%" is one
   * person, and a rarity nobody can be compared against is decoration.
   */
  rarity?: { sharePct: number; tier: RarityTier };
}

export type RarityTier = 'common' | 'uncommon' | 'rare' | 'legendary';

export interface Ultrathink {
  count: number;
  /**
   * Percent of all-time prompts that carried the flag. A FLOOR for anyone
   * whose history predates it: nothing looked at those prompts, and inventing
   * a smaller denominator would inflate the number.
   */
  sharePct: number;
  /** Local date of the first flagged prompt, so the UI can caveat the share. */
  firstSeen: string | null;
}

export interface FingerprintData {
  username: string;
  /** The IANA zone every hour, weekday and week above was read in. */
  timezone: string;
  generatedAt: string;
  /** Sections present in this payload. */
  sections: FingerprintSection[];
  /** Sections the owner has hidden, so a viewer sees a gap, not a lie. */
  hidden: FingerprintSection[];
  value?: ValueFigures;
  anatomy?: Anatomy;
  conversation?: Conversation;
  rings?: Rings;
  class?: UserClass;
  milestones?: Milestone[];
  ultrathink?: Ultrathink;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure logic
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ratio of sums, with an empty denominator reading 0 rather than NaN.
 *
 * Every per-prompt figure on the profile goes through here. The alternative —
 * averaging a per-row ratio — gives a different number that cannot be checked
 * against the totals beside it, which is how a profile ends up disagreeing
 * with itself.
 */
export function ratioOfSums(total: number, count: number): number {
  return count > 0 ? total / count : 0;
}

/** Percent change, or null when there is no base to compare against. */
export function deltaPct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Shares that sum to 100 (or to 0 when nothing happened). */
export function withShares<T extends { value: number }>(items: T[]): (T & { share: number })[] {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return items.map((item) => ({
    ...item,
    share: total > 0 ? (item.value * 100) / total : 0,
  }));
}

/**
 * The hour buckets a rhythm is read from. They PARTITION the 24 hours — every
 * hour belongs to exactly one — which is what makes the shares comparable.
 */
export const RHYTHM_BUCKETS: Record<RhythmClass, number[]> = {
  'night-owl': [22, 23, 0, 1, 2, 3, 4],
  'early-bird': [5, 6, 7],
  morning: [8, 9, 10, 11],
  afternoon: [12, 13, 14, 15, 16],
  evening: [17, 18, 19, 20, 21],
};

/** Below this, an hour distribution is noise and the class stays null. */
export const MIN_PROMPTS_FOR_CLASS = 20;

/**
 * Rhythm from the 24 local-hour buckets.
 *
 * Decided on DENSITY — a bucket's share of prompts divided by its share of the
 * day — not on the raw share. The buckets are deliberately different widths
 * (night spans 7 hours, early morning 3), so the biggest share would simply be
 * the widest bucket for almost everyone, and nearly nobody would come out an
 * early bird. Density asks the question the label implies: where is this
 * person's work most concentrated relative to the time available?
 *
 * Returns the evidence alongside the verdict because the profile shows it: a
 * class a user cannot check is a horoscope.
 */
export function classifyRhythm(hours: number[]): {
  rhythm: RhythmClass | null;
  evidence: RhythmEvidence;
} {
  const buckets = Object.entries(RHYTHM_BUCKETS) as [RhythmClass, number[]][];
  const total = hours.reduce((sum, n) => sum + (n || 0), 0);

  const shares = {} as Record<RhythmClass, number>;
  const density = {} as Record<RhythmClass, number>;
  for (const [name, hoursInBucket] of buckets) {
    const inBucket = hoursInBucket.reduce((sum, h) => sum + (hours[h] || 0), 0);
    const share = total > 0 ? (inBucket * 100) / total : 0;
    shares[name] = share;
    density[name] = total > 0 ? share / ((hoursInBucket.length * 100) / 24) : 0;
  }

  let peakHour: number | null = null;
  let peakCount = 0;
  hours.forEach((count, hour) => {
    if ((count || 0) > peakCount) {
      peakCount = count;
      peakHour = hour;
    }
  });

  const evidence: RhythmEvidence = { shares, density, peakHour, prompts: total };
  if (total < MIN_PROMPTS_FOR_CLASS) return { rhythm: null, evidence };

  const rhythm = buckets
    .map(([name]) => name)
    .reduce((best, name) => (density[name] > density[best] ? name : best), buckets[0]![0]);

  return { rhythm, evidence };
}

/**
 * How much of the value ran in subagents before someone counts as delegating.
 * 15% is roughly one prompt in seven handed off — enough to be a habit rather
 * than a trial.
 */
export const ORCHESTRATOR_SUBAGENT_SHARE_PCT = 15;

/**
 * Tool calls per prompt above which a prompt is a long autonomous run rather
 * than a turn in a conversation. The all-time figure for this project's
 * heaviest user is ~9.6, so 12 marks "longer loops than that".
 */
export const AUTOPILOT_TOOL_CALLS_PER_PROMPT = 12;

/**
 * Style from how work is handed to Claude.
 *
 * Checked in this order, because they are not symmetric: delegating to
 * subagents is a deliberate structural choice and shows up in the value split,
 * while a long tool loop is what you get by asking for a big job in one go.
 * Someone who does both is an orchestrator — the subagents are the louder fact.
 */
export function classifyStyle(evidence: StyleEvidence): StyleClass | null {
  if (evidence.prompts < MIN_PROMPTS_FOR_CLASS) return null;
  if (evidence.subagentSharePct >= ORCHESTRATOR_SUBAGENT_SHARE_PCT) return 'orchestrator';
  if (evidence.toolCallsPerPrompt >= AUTOPILOT_TOOL_CALLS_PER_PROMPT) return 'autopilot';
  return 'pair-programmer';
}

export interface DailyPoint {
  /** Local date, YYYY-MM-DD. */
  date: string;
  prompts: number;
  lines: number;
  ultrathinks: number;
}

interface ThresholdSpec {
  kind: MilestoneKind;
  emoji: string;
  thresholds: number[];
  label(value: number): string;
}

const MILESTONE_SPECS: Record<'prompts' | 'lines' | 'streak' | 'ultrathink', ThresholdSpec> = {
  prompts: {
    kind: 'prompts',
    emoji: '💬',
    thresholds: [1_000, 10_000, 25_000, 50_000, 100_000],
    label: (v) => `${compact(v)} prompts`,
  },
  lines: {
    kind: 'lines',
    emoji: '📝',
    thresholds: [100_000, 1_000_000, 10_000_000],
    label: (v) => `${compact(v)} lines written`,
  },
  streak: {
    kind: 'streak',
    emoji: '🔥',
    thresholds: [7, 30, 100],
    label: (v) => `${v}-day streak`,
  },
  ultrathink: {
    kind: 'ultrathink',
    emoji: '🌈',
    thresholds: [100, 1_000, 5_000],
    label: (v) => `${compact(v)} ultrathinks`,
  },
};

function compact(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${value / 1_000}K`;
  return String(value);
}

/**
 * The date each threshold was crossed, from a cumulative walk of the daily
 * series.
 *
 * The date is the point of a milestone, so it is read off the series rather
 * than from a total: "you passed 10,000 prompts" without a day is a stat, and
 * with one it is a memory. A threshold is crossed on the first day the running
 * total reaches it — the day the 10,000th prompt was typed, not the day after.
 *
 * Days may arrive in any order and are sorted here. A gap is a gap: nothing is
 * interpolated, because a day with no rows is a day with no work.
 */
export function crossedMilestones(series: DailyPoint[]): Milestone[] {
  const days = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const milestones: Milestone[] = [];

  const totals = { prompts: 0, lines: 0, ultrathink: 0 };
  const pending = {
    prompts: [...MILESTONE_SPECS.prompts.thresholds],
    lines: [...MILESTONE_SPECS.lines.thresholds],
    ultrathink: [...MILESTONE_SPECS.ultrathink.thresholds],
  };

  // Streaks need the run length, not a cumulative total.
  let run = 0;
  let previousDay: number | null = null;
  const pendingStreaks = [...MILESTONE_SPECS.streak.thresholds];

  const take = (
    specKey: keyof typeof MILESTONE_SPECS,
    queue: number[],
    reached: number,
    date: string
  ) => {
    while (queue.length > 0 && reached >= queue[0]!) {
      const value = queue.shift()!;
      const spec = MILESTONE_SPECS[specKey];
      milestones.push({
        key: `${specKey}_${value}`,
        label: spec.label(value),
        emoji: spec.emoji,
        kind: spec.kind,
        date,
        value,
      });
    }
  };

  for (const day of days) {
    totals.prompts += day.prompts || 0;
    totals.lines += day.lines || 0;
    totals.ultrathink += day.ultrathinks || 0;

    take('prompts', pending.prompts, totals.prompts, day.date);
    take('lines', pending.lines, totals.lines, day.date);
    take('ultrathink', pending.ultrathink, totals.ultrathink, day.date);

    const dayNumber = Math.floor(Date.parse(`${day.date}T00:00:00Z`) / 86_400_000);
    if (Number.isNaN(dayNumber)) continue;
    const active = (day.prompts || 0) > 0;
    if (!active) {
      run = 0;
      previousDay = dayNumber;
      continue;
    }
    run = previousDay !== null && dayNumber === previousDay + 1 ? run + 1 : 1;
    previousDay = dayNumber;
    take('streak', pendingStreaks, run, day.date);
  }

  return milestones.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/**
 * Below this many active users, rarity is omitted rather than invented.
 *
 * With a few dozen users "top 1%" is a rounding of one person, and a rarity
 * nobody can be compared against is decoration pretending to be data.
 */
export const MIN_USERS_FOR_RARITY = 100;

/** Tiers by how many people share a milestone. */
export function rarityTier(sharePct: number): RarityTier {
  if (sharePct <= 1) return 'legendary';
  if (sharePct <= 5) return 'rare';
  if (sharePct <= 25) return 'uncommon';
  return 'common';
}

/** One row per active user: the totals a threshold milestone is read from. */
export interface PeerTotals {
  prompts: number;
  lines: number;
  ultrathinks: number;
}

/**
 * How many of the active users have also reached each threshold.
 *
 * Only the CUMULATIVE-TOTAL milestones get a rarity: those are the ones a
 * single cross-user query can answer. A streak and a first-use date would each
 * need every user's daily series, which is a different and far heavier
 * question — so they carry no rarity rather than a cheaper, wronger one.
 */
export function attachRarity(
  milestones: Milestone[],
  peers: PeerTotals[],
  activeUsers: number
): Milestone[] {
  if (activeUsers < MIN_USERS_FOR_RARITY || peers.length === 0) return milestones;

  const totalFor = (kind: MilestoneKind, peer: PeerTotals): number | null => {
    if (kind === 'prompts') return peer.prompts;
    if (kind === 'lines') return peer.lines;
    if (kind === 'ultrathink') return peer.ultrathinks;
    return null;
  };

  return milestones.map((milestone) => {
    if (totalFor(milestone.kind, peers[0]!) === null) return milestone;
    const reached = peers.filter(
      (peer) => (totalFor(milestone.kind, peer) ?? 0) >= milestone.value
    ).length;
    const sharePct = (reached * 100) / activeUsers;
    return { ...milestone, rarity: { sharePct, tier: rarityTier(sharePct) } };
  });
}

/** Model id → the family and version a human recognises ('Opus', '5.5'). */
export function splitModelName(modelId: string): { family: string; version: string } {
  const display = getModelDisplayName(modelId);
  const space = display.indexOf(' ');
  if (space === -1) return { family: display, version: '' };
  return { family: display.slice(0, space), version: display.slice(space + 1) };
}

/**
 * Per-model value → families, each with its versions.
 *
 * Split by family AND version because they answer different questions: the
 * family is which model someone reaches for, the version is whether they have
 * moved on to the current one. Opus 5.5 and Opus 4.8 are the same habit and
 * different money.
 */
export function groupModelsByFamily(
  rows: { model: string; value: number }[]
): ModelFamilyShare[] {
  const families = new Map<string, { value: number; versions: Map<string, number> }>();

  for (const row of rows) {
    const value = row.value || 0;
    if (value <= 0) continue;
    const { family } = splitModelName(row.model);
    const name = getModelDisplayName(row.model);
    const entry = families.get(family) ?? { value: 0, versions: new Map() };
    entry.value += value;
    entry.versions.set(name, (entry.versions.get(name) ?? 0) + value);
    families.set(family, entry);
  }

  const withFamilyShares = withShares(
    [...families].map(([family, entry]) => ({ family, value: entry.value, entry }))
  );

  return withFamilyShares
    .map(({ family, value, share, entry }) => ({
      family,
      value,
      share,
      // Version shares are OF THE FAMILY, so they answer "how much of your
      // Opus is 5.5" rather than repeating the family's share of the whole.
      versions: withShares([...entry.versions].map(([name, v]) => ({ name, value: v })))
        .map(({ name, value: v, share: s }) => ({ name, value: v, share: s }))
        .sort((a, b) => b.value - a.value),
    }))
    .sort((a, b) => b.value - a.value);
}

// ═══════════════════════════════════════════════════════════════════════════
// Queries
// ═══════════════════════════════════════════════════════════════════════════

/** Output tokens → characters. Four is the usual English rule of thumb. */
export const CHARS_PER_TOKEN = 4;

const LAST_30D = `timestamp >= now() - INTERVAL 30 DAY`;

interface EventTotals {
  prompts_all: number;
  prompts_30d: number;
  chars_all: number;
  chars_30d: number;
  median_all: number;
  median_30d: number;
  tools_all: number;
  tools_30d: number;
  ultrathinks: number;
  ultrathink_first: string | null;
}

/**
 * Prompt, tool-call and ultrathink counts in one pass.
 *
 * Legacy rows are INCLUDED here on purpose. They carry both a prompt count and
 * a tool-call count for their day, so a ratio over them is honest — unlike the
 * api-calls-per-prompt ratio in getUserAgenticStats, where legacy days
 * contribute prompts and no api_requests and so collapse the figure.
 *
 * The median excludes `prompt_length = 0`: a legacy row records that prompts
 * happened and nothing about their length, and counting those as zero-character
 * prompts drags the median toward nothing.
 */
async function fetchEventTotals(userId: string, tz: string): Promise<EventTotals | null> {
  const measured = `${PROMPT_EVENT_SQL} AND prompt_length > 0`;
  const rows = await query<EventTotals>(
    `SELECT
       toUInt64(countIf(${PROMPT_EVENT_SQL})) AS prompts_all,
       toUInt64(countIf(${PROMPT_EVENT_SQL} AND ${LAST_30D})) AS prompts_30d,
       toUInt64(sumIf(prompt_length, ${measured})) AS chars_all,
       toUInt64(sumIf(prompt_length, ${measured} AND ${LAST_30D})) AS chars_30d,
       toUInt64(quantileExactIf(0.5)(prompt_length, ${measured})) AS median_all,
       toUInt64(quantileExactIf(0.5)(prompt_length, ${measured} AND ${LAST_30D})) AS median_30d,
       toUInt64(countIf(event_name = 'claude_code.tool_result')) AS tools_all,
       toUInt64(countIf(event_name = 'claude_code.tool_result' AND ${LAST_30D})) AS tools_30d,
       toUInt64(countIf(${ULTRATHINK_EVENT_SQL})) AS ultrathinks,
       if(countIf(${ULTRATHINK_EVENT_SQL}) > 0,
          toString(minIf(toDate(${LOCAL_TS_SQL}), ${ULTRATHINK_EVENT_SQL})),
          NULL) AS ultrathink_first
     FROM events_raw FINAL
     WHERE user_id = {userId:String}`,
    { userId, tz }
  );
  return rows[0] ?? null;
}

interface MetricTotals {
  value_all: number;
  value_30d: number;
  value_this_week: number;
  value_last_week: number;
  lines_all: number;
  lines_30d: number;
  output_tokens: number;
  subagent_value: number;
  attributed_value: number;
}

/**
 * Value, lines and output tokens, with the two week windows measured as
 * half-open instants rather than `today() - 7`.
 *
 * A rolling seven days is not a week: the header says "this week" and compares
 * it with last week, so both have to be the user's own Monday-to-Monday or the
 * comparison is between two overlapping windows.
 */
async function fetchMetricTotals(
  userId: string,
  tz: string,
  week: { start: string; end: string; previousStart: string }
): Promise<MetricTotals | null> {
  const value = `metric_name = 'claude_code.cost.usage'`;
  const lines = `metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added'`;
  const thisWeek = `timestamp >= {weekStart:DateTime64(3)} AND timestamp < {weekEnd:DateTime64(3)}`;
  const lastWeek = `timestamp >= {prevWeekStart:DateTime64(3)} AND timestamp < {weekStart:DateTime64(3)}`;

  const rows = await query<MetricTotals>(
    `SELECT
       toFloat64(sumIf(value, ${value})) AS value_all,
       toFloat64(sumIf(value, ${value} AND ${LAST_30D})) AS value_30d,
       toFloat64(sumIf(value, ${value} AND ${thisWeek})) AS value_this_week,
       toFloat64(sumIf(value, ${value} AND ${lastWeek})) AS value_last_week,
       toUInt64(sumIf(value, ${lines})) AS lines_all,
       toUInt64(sumIf(value, ${lines} AND ${LAST_30D})) AS lines_30d,
       toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'output')) AS output_tokens,
       toFloat64(sumIf(value, ${value} AND query_source = 'subagent')) AS subagent_value,
       toFloat64(sumIf(value, ${value} AND query_source != '')) AS attributed_value
     FROM metrics_raw FINAL
     WHERE user_id = {userId:String}`,
    {
      userId,
      tz,
      weekStart: week.start,
      weekEnd: week.end,
      prevWeekStart: week.previousStart,
    }
  );
  return rows[0] ?? null;
}

/**
 * The hour × weekday grid of prompts, in local time.
 *
 * One query for both rings: the marginals of this grid ARE the two 1-D
 * distributions, so asking twice would be two scans for one answer — and two
 * chances for them to disagree.
 */
async function fetchHourWeekdayGrid(
  userId: string,
  tz: string
): Promise<{ hour: number; weekday: number; prompts: number }[]> {
  return query<{ hour: number; weekday: number; prompts: number }>(
    `SELECT
       toUInt8(toHour(${LOCAL_TS_SQL})) AS hour,
       toUInt8(toDayOfWeek(${LOCAL_TS_SQL})) AS weekday,
       toUInt64(count()) AS prompts
     FROM events_raw FINAL
     WHERE user_id = {userId:String}
       AND ${PROMPT_EVENT_SQL}
       AND ${NO_LEGACY_SQL}
     GROUP BY hour, weekday`,
    { userId, tz }
  );
}

/** Languages by edit count (code_edit_tool.decision). */
async function fetchLanguages(userId: string): Promise<{ name: string; value: number }[]> {
  const rows = await query<{ name: string; value: number }>(
    `SELECT language AS name, toUInt64(count()) AS value
     FROM metrics_raw FINAL
     WHERE user_id = {userId:String}
       AND metric_name = 'claude_code.code_edit_tool.decision'
       AND language != ''
     GROUP BY language
     ORDER BY value DESC
     LIMIT 12`,
    { userId }
  );
  return rows;
}

/** Per-model API-equivalent value, on the decoration-stripped model id. */
async function fetchModelValue(userId: string): Promise<{ model: string; value: number }[]> {
  return query<{ model: string; value: number }>(
    `SELECT ${MODEL_ID_SQL} AS model, toFloat64(sum(value)) AS value
     FROM metrics_raw FINAL
     WHERE user_id = {userId:String}
       AND metric_name = 'claude_code.cost.usage'
       AND model != ''
     GROUP BY model
     ORDER BY value DESC`,
    { userId }
  );
}

/** Prompts per local month per local hour, for the per-month rhythm. */
async function fetchMonthlyHours(
  userId: string,
  tz: string
): Promise<{ month: string; hour: number; prompts: number }[]> {
  return query<{ month: string; hour: number; prompts: number }>(
    `SELECT
       formatDateTime(${LOCAL_TS_SQL}, '%Y-%m') AS month,
       toUInt8(toHour(${LOCAL_TS_SQL})) AS hour,
       toUInt64(count()) AS prompts
     FROM events_raw FINAL
     WHERE user_id = {userId:String}
       AND ${PROMPT_EVENT_SQL}
       AND ${NO_LEGACY_SQL}
     GROUP BY month, hour`,
    { userId, tz }
  );
}

/** Prompts and tool calls per local month, for the per-month style. */
async function fetchMonthlyEvents(
  userId: string,
  tz: string
): Promise<{ month: string; prompts: number; tools: number }[]> {
  return query<{ month: string; prompts: number; tools: number }>(
    `SELECT
       formatDateTime(${LOCAL_TS_SQL}, '%Y-%m') AS month,
       toUInt64(countIf(${PROMPT_EVENT_SQL})) AS prompts,
       toUInt64(countIf(event_name = 'claude_code.tool_result')) AS tools
     FROM events_raw FINAL
     WHERE user_id = {userId:String}
       AND ${NO_LEGACY_SQL}
     GROUP BY month`,
    { userId, tz }
  );
}

/** Attributed vs subagent value per local month, for the per-month style. */
async function fetchMonthlyValue(
  userId: string,
  tz: string
): Promise<{ month: string; subagent: number; attributed: number }[]> {
  return query<{ month: string; subagent: number; attributed: number }>(
    `SELECT
       formatDateTime(${LOCAL_TS_SQL}, '%Y-%m') AS month,
       toFloat64(sumIf(value, query_source = 'subagent')) AS subagent,
       toFloat64(sumIf(value, query_source != '')) AS attributed
     FROM metrics_raw FINAL
     WHERE user_id = {userId:String}
       AND metric_name = 'claude_code.cost.usage'
       AND ${NO_LEGACY_SQL}
     GROUP BY month`,
    { userId, tz }
  );
}

/**
 * The all-history daily series the milestones are read off.
 *
 * Legacy days are included: a prompt typed in February counts toward the
 * 10,000th prompt whatever store first recorded it. The DATE is local, which
 * for a legacy row stamped 12:00 UTC still lands on the right day everywhere
 * except the two extreme zones.
 */
async function fetchDailySeries(userId: string, tz: string): Promise<DailyPoint[]> {
  const [events, metrics] = await Promise.all([
    query<{ date: string; prompts: number; ultrathinks: number }>(
      `SELECT
         toString(toDate(${LOCAL_TS_SQL})) AS date,
         toUInt64(countIf(${PROMPT_EVENT_SQL})) AS prompts,
         toUInt64(countIf(${ULTRATHINK_EVENT_SQL})) AS ultrathinks
       FROM events_raw FINAL
       WHERE user_id = {userId:String}
       GROUP BY date`,
      { userId, tz }
    ),
    query<{ date: string; lines: number }>(
      `SELECT
         toString(toDate(${LOCAL_TS_SQL})) AS date,
         toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added')) AS lines
       FROM metrics_raw FINAL
       WHERE user_id = {userId:String}
       GROUP BY date`,
      { userId, tz }
    ),
  ]);

  const byDate = new Map<string, DailyPoint>();
  for (const row of events) {
    byDate.set(row.date, {
      date: row.date,
      prompts: Number(row.prompts) || 0,
      lines: 0,
      ultrathinks: Number(row.ultrathinks) || 0,
    });
  }
  for (const row of metrics) {
    const existing = byDate.get(row.date);
    const lines = Number(row.lines) || 0;
    if (existing) existing.lines = lines;
    else byDate.set(row.date, { date: row.date, prompts: 0, lines, ultrathinks: 0 });
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** First local date each model id was used, folded to families by the caller. */
async function fetchModelFirstUse(
  userId: string,
  tz: string
): Promise<{ model: string; first_day: string }[]> {
  return query<{ model: string; first_day: string }>(
    `SELECT ${MODEL_ID_SQL} AS model, toString(min(toDate(${LOCAL_TS_SQL}))) AS first_day
     FROM metrics_raw FINAL
     WHERE user_id = {userId:String}
       AND model != ''
     GROUP BY model`,
    { userId, tz }
  );
}

/**
 * Every active user's milestone totals, and how many there are.
 *
 * Only asked for when the rarity gate is already open, because it is the one
 * query here that scans every user rather than one — and below 100 users its
 * answer would be thrown away anyway.
 */
async function fetchPeerTotals(): Promise<{ peers: PeerTotals[]; activeUsers: number }> {
  const [events, metrics] = await Promise.all([
    query<{ user_id: string; prompts: number; ultrathinks: number }>(
      `SELECT
         user_id,
         toUInt64(countIf(${PROMPT_EVENT_SQL})) AS prompts,
         toUInt64(countIf(${ULTRATHINK_EVENT_SQL})) AS ultrathinks
       FROM events_raw FINAL
       GROUP BY user_id
       HAVING prompts > 0`
    ),
    query<{ user_id: string; lines: number }>(
      `SELECT
         user_id,
         toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added')) AS lines
       FROM metrics_raw FINAL
       GROUP BY user_id`
    ),
  ]);

  const linesByUser = new Map(metrics.map((row) => [row.user_id, Number(row.lines) || 0]));
  const peers = events.map((row) => ({
    prompts: Number(row.prompts) || 0,
    lines: linesByUser.get(row.user_id) ?? 0,
    ultrathinks: Number(row.ultrathinks) || 0,
  }));

  return { peers, activeUsers: peers.length };
}

/** How many users have ever sent a prompt — the rarity gate's denominator. */
async function countActiveUsers(): Promise<number> {
  const rows = await query<{ users: number }>(
    `SELECT toUInt64(uniqExact(user_id)) AS users
     FROM events_raw FINAL
     WHERE ${PROMPT_EVENT_SQL}`
  );
  return Number(rows[0]?.users) || 0;
}

/** A milestone for the first prompt sent to each model family. */
export function modelFamilyMilestones(
  rows: { model: string; first_day: string }[]
): Milestone[] {
  const firstByFamily = new Map<string, string>();
  for (const row of rows) {
    if (!row.first_day || row.first_day.startsWith('1970')) continue;
    const { family } = splitModelName(row.model);
    const current = firstByFamily.get(family);
    if (!current || row.first_day < current) firstByFamily.set(family, row.first_day);
  }

  return [...firstByFamily]
    .map(([family, date]) => ({
      key: `model_${family.toLowerCase()}`,
      label: `First ${family}`,
      emoji: '🧠',
      kind: 'model' as const,
      date,
      value: 1,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ═══════════════════════════════════════════════════════════════════════════
// Assembly
// ═══════════════════════════════════════════════════════════════════════════

/** Marginals of the hour × weekday grid, plus the dominant of each. */
export function buildRings(
  grid: { hour: number; weekday: number; prompts: number }[],
  languages: { name: string; value: number }[],
  models: { model: string; value: number }[]
): Rings {
  const hours = Array<number>(24).fill(0);
  const weekdays = Array<number>(7).fill(0);

  for (const cell of grid) {
    const prompts = Number(cell.prompts) || 0;
    const hour = Number(cell.hour);
    // ClickHouse toDayOfWeek is 1 = Monday … 7 = Sunday; the array is 0 = Monday.
    const weekday = Number(cell.weekday) - 1;
    if (hour >= 0 && hour < 24) hours[hour]! += prompts;
    if (weekday >= 0 && weekday < 7) weekdays[weekday]! += prompts;
  }

  const total = hours.reduce((sum, n) => sum + n, 0);
  const share = (n: number) => (total > 0 ? (n * 100) / total : 0);

  let peakHour: Rings['peakHour'] = null;
  hours.forEach((count, hour) => {
    if (count > 0 && (!peakHour || count > hours[peakHour.hour]!)) {
      peakHour = { hour, share: share(count) };
    }
  });

  let busiestDay: Rings['busiestDay'] = null;
  weekdays.forEach((count, weekday) => {
    if (count > 0 && (!busiestDay || count > weekdays[busiestDay.weekday]!)) {
      busiestDay = { weekday, share: share(count) };
    }
  });

  const weekdayTotal = weekdays.slice(0, 5).reduce((sum, n) => sum + n, 0);
  const languageItems = withShares(languages.map((l) => ({ name: l.name, value: Number(l.value) || 0 })))
    .map(({ name, value, share: s }) => ({ name, value, share: s }))
    .sort((a, b) => b.value - a.value);
  const modelFamilies = groupModelsByFamily(models);

  return {
    hours,
    weekdays,
    peakHour,
    busiestDay,
    weekdayShare: share(weekdayTotal),
    languages: languageItems,
    topLanguage: languageItems[0] ?? null,
    models: modelFamilies,
    topModel: modelFamilies[0] ?? null,
  };
}

/**
 * The class for the current month, plus every earlier month we can judge.
 *
 * Recomputed from the rows every time rather than snapshotted: a stored verdict
 * is a number nobody can trace, and the series it is derived from is cheap.
 * Past months are therefore always consistent with the data behind them — and
 * a backfill that fills in an old month corrects that month's class instead of
 * leaving a stale one on the page.
 */
export function buildClassHistory(
  currentMonth: string,
  monthlyHours: { month: string; hour: number; prompts: number }[],
  monthlyEvents: { month: string; prompts: number; tools: number }[],
  monthlyValue: { month: string; subagent: number; attributed: number }[]
): UserClass {
  const hoursByMonth = new Map<string, number[]>();
  for (const row of monthlyHours) {
    const hours = hoursByMonth.get(row.month) ?? Array<number>(24).fill(0);
    const hour = Number(row.hour);
    if (hour >= 0 && hour < 24) hours[hour]! += Number(row.prompts) || 0;
    hoursByMonth.set(row.month, hours);
  }

  const eventsByMonth = new Map(monthlyEvents.map((r) => [r.month, r]));
  const valueByMonth = new Map(monthlyValue.map((r) => [r.month, r]));

  const months = [
    ...new Set([
      currentMonth,
      ...hoursByMonth.keys(),
      ...eventsByMonth.keys(),
      ...valueByMonth.keys(),
    ]),
  ].sort((a, b) => b.localeCompare(a));

  const judge = (month: string) => {
    const hours = hoursByMonth.get(month) ?? Array<number>(24).fill(0);
    const events = eventsByMonth.get(month);
    const value = valueByMonth.get(month);
    const prompts = Number(events?.prompts) || 0;
    const attributed = Number(value?.attributed) || 0;

    const { rhythm, evidence: rhythmEvidence } = classifyRhythm(hours);
    const styleEvidence: StyleEvidence = {
      // Share of ATTRIBUTED value only: rows from before query_source existed
      // carry no attribution at all, and counting them as "not subagent" would
      // read as a main-thread habit nobody demonstrated.
      subagentSharePct:
        attributed > 0 ? ((Number(value?.subagent) || 0) * 100) / attributed : 0,
      toolCallsPerPrompt: ratioOfSums(Number(events?.tools) || 0, prompts),
      prompts,
    };

    return {
      verdict: { month, rhythm, style: classifyStyle(styleEvidence) } satisfies ClassVerdict,
      rhythmEvidence,
      styleEvidence,
    };
  };

  const current = judge(currentMonth);
  const history = months
    .filter((month) => month !== currentMonth)
    .map((month) => judge(month).verdict)
    .filter((verdict) => verdict.rhythm !== null || verdict.style !== null);

  return {
    ...current.verdict,
    rhythm_evidence: current.rhythmEvidence,
    style_evidence: current.styleEvidence,
    history,
  };
}

export interface FingerprintOptions {
  username: string;
  timezone?: string;
  /** Sections to leave out, from the owner's profile_settings. */
  hidden?: FingerprintSection[];
  /** Overridable so the tests do not depend on the wall clock. */
  now?: Date;
}

/**
 * Everything the fingerprint shows, in one fan-out.
 *
 * Throws if ClickHouse is unreachable — the caller decides what a failure
 * means. It must NOT be a cached empty payload: a profile that reads "0
 * prompts" because a query timed out is worse than one that reads "try again".
 */
export async function getFingerprint(
  userId: string,
  options: FingerprintOptions
): Promise<FingerprintData> {
  const tz = normalizeTimezone(options.timezone ?? DEFAULT_TIMEZONE);
  const now = options.now ?? new Date();
  const hidden = options.hidden ?? [];

  const thisWeek = weekBounds(now, tz, 0);
  const lastWeek = weekBounds(now, tz, 1);
  const week = {
    start: toClickHouseTimestamp(thisWeek.start),
    end: toClickHouseTimestamp(thisWeek.end),
    previousStart: toClickHouseTimestamp(lastWeek.start),
  };

  const [
    eventTotals,
    metricTotals,
    grid,
    languages,
    models,
    monthlyHours,
    monthlyEvents,
    monthlyValue,
    dailySeries,
    modelFirstUse,
    activeUsers,
  ] = await Promise.all([
    fetchEventTotals(userId, tz),
    fetchMetricTotals(userId, tz, week),
    fetchHourWeekdayGrid(userId, tz),
    fetchLanguages(userId),
    fetchModelValue(userId),
    fetchMonthlyHours(userId, tz),
    fetchMonthlyEvents(userId, tz),
    fetchMonthlyValue(userId, tz),
    fetchDailySeries(userId, tz),
    fetchModelFirstUse(userId, tz),
    countActiveUsers(),
  ]);

  const promptsAll = Number(eventTotals?.prompts_all) || 0;
  const promptsL30 = Number(eventTotals?.prompts_30d) || 0;
  const valueAll = Number(metricTotals?.value_all) || 0;
  const outputTokens = Number(metricTotals?.output_tokens) || 0;
  const charsTyped = Number(eventTotals?.chars_all) || 0;
  const ultrathinks = Number(eventTotals?.ultrathinks) || 0;

  const anatomy: Anatomy = {
    allTime: {
      prompts: promptsAll,
      medianPromptChars: Number(eventTotals?.median_all) || 0,
      toolCallsPerPrompt: ratioOfSums(Number(eventTotals?.tools_all) || 0, promptsAll),
      linesPerPrompt: ratioOfSums(Number(metricTotals?.lines_all) || 0, promptsAll),
      valuePerPrompt: ratioOfSums(valueAll, promptsAll),
    },
    last30d: {
      prompts: promptsL30,
      medianPromptChars: Number(eventTotals?.median_30d) || 0,
      toolCallsPerPrompt: ratioOfSums(Number(eventTotals?.tools_30d) || 0, promptsL30),
      linesPerPrompt: ratioOfSums(Number(metricTotals?.lines_30d) || 0, promptsL30),
      valuePerPrompt: ratioOfSums(Number(metricTotals?.value_30d) || 0, promptsL30),
    },
  };

  const approxOutputChars = outputTokens * CHARS_PER_TOKEN;
  let milestones = [
    ...crossedMilestones(dailySeries),
    ...modelFamilyMilestones(modelFirstUse),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));

  // The second wave, and only when it can produce an honest answer.
  if (activeUsers >= MIN_USERS_FOR_RARITY && milestones.length > 0) {
    const { peers, activeUsers: counted } = await fetchPeerTotals();
    milestones = attachRarity(milestones, peers, counted);
  }

  const full: Required<Pick<FingerprintData,
    'value' | 'anatomy' | 'conversation' | 'rings' | 'class' | 'milestones' | 'ultrathink'>> = {
    value: {
      thisWeek: Number(metricTotals?.value_this_week) || 0,
      lastWeek: Number(metricTotals?.value_last_week) || 0,
      deltaPct: deltaPct(
        Number(metricTotals?.value_this_week) || 0,
        Number(metricTotals?.value_last_week) || 0
      ),
      allTime: valueAll,
      weekStart: thisWeek.start.toISOString(),
    },
    anatomy,
    conversation: {
      charsTyped,
      outputTokens,
      approxOutputChars,
      ratio: charsTyped > 0 ? approxOutputChars / charsTyped : null,
    },
    rings: buildRings(grid, languages, models),
    class: buildClassHistory(
      localMonth(now, tz),
      monthlyHours,
      monthlyEvents,
      monthlyValue
    ),
    milestones,
    ultrathink: {
      count: ultrathinks,
      sharePct: promptsAll > 0 ? (ultrathinks * 100) / promptsAll : 0,
      firstSeen: eventTotals?.ultrathink_first ?? null,
    },
  };

  // Hidden sections are left OUT rather than zeroed: a zero is a claim about
  // the data, and "hidden" is a claim about the owner's choice. `sections`
  // names what is present so the UI never has to tell the two apart.
  const built = ['value', 'anatomy', 'conversation', 'rings', 'class', 'milestones', 'ultrathink'] as const;
  const show = (key: FingerprintSection) => !hidden.includes(key);

  return {
    username: options.username,
    timezone: tz,
    generatedAt: now.toISOString(),
    sections: built.filter(show),
    hidden: [...hidden],
    ...(show('value') && { value: full.value }),
    ...(show('anatomy') && { anatomy: full.anatomy }),
    ...(show('conversation') && { conversation: full.conversation }),
    ...(show('rings') && { rings: full.rings }),
    ...(show('class') && { class: full.class }),
    ...(show('milestones') && { milestones: full.milestones }),
    ...(show('ultrathink') && { ultrathink: full.ultrathink }),
  };
}
