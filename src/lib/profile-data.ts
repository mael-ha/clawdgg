/**
 * The profile's own reads — the parts of the page the fingerprint payload does
 * not carry.
 *
 * src/lib/fingerprint.ts answers "who is this person" in one fan-out. Three
 * things on the page are deliberately NOT in it, each for its own reason:
 *
 *   the year    — 371 days × four figures is a bigger payload than everything
 *                 else on the page put together, and it is only ever rendered
 *                 as a grid.
 *   the curve   — the reader chooses its metric, range and granularity, so it
 *                 is fetched per interaction and cannot be part of a snapshot.
 *   today, the  — these move while you watch them (or describe the pipe they
 *   pipeline      arrive through), and must never be served from a cache.
 *
 * TIME IS LOCAL for anything daily, by the same argument as fingerprint.ts: a
 * day boundary in the wrong zone puts work on the wrong square.
 *
 * ESTIMATED vs MEASURED is a first-class distinction here. A row is estimated
 * when it was RECOVERED — reconstructed from session transcripts, imported
 * from the pre-OTEL daily summary — rather than measured live. `repair` is not
 * estimated: it is the same measurement recovered from the other table that
 * recorded it (see RowProvenance in src/db/clickhouse.ts), and it counts
 * wherever `live` counts.
 */

import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceTokens, planUsageSnapshots, users } from '../db/schema';
import {
  LOCAL_TS_SQL,
  PROMPT_EVENT_SQL,
  ULTRATHINK_EVENT_SQL,
  query,
} from '../db/clickhouse';
import { bucketLabel, bucketSql, type ChartGroupBy } from './chart-buckets';
import { DEFAULT_TIMEZONE, normalizeTimezone } from './timezone';
import {
  CURVE_GROUP_BYS,
  CURVE_METRICS,
  CURVE_PERIODS,
  type CurveMetric,
  type CurvePeriod,
  type CurvePointView,
  type CurveView,
} from '../components/profile/curve';
import type {
  PipelineData,
  PlanCycle,
  PlanData,
  PlanWindow,
  TodayData,
} from '../components/profile/types';
import type { ContributionDay } from '../components/profile/geometry';

/** Provenances that mean "recovered", for the hatched squares and faint bars. */
const ESTIMATED_SQL = `provenance IN ('backfill', 'backfill-history', 'legacy', 'import')`;

// ═══════════════════════════════════════════════════════════════════════════
// 📅 The year
// ═══════════════════════════════════════════════════════════════════════════

/** 53 columns of 7 days, plus the days before this week's Monday. */
export const YEAR_DAYS = 371;

/**
 * One row per local day with anything on it, for the contribution grid and its
 * tooltip. Days with nothing are ABSENT, not zero: the grid fills its own gaps,
 * and a zero row would make an empty day indistinguishable from a day whose
 * numbers we failed to fetch.
 */
export async function fetchYearSeries(userId: string, tz: string): Promise<ContributionDay[]> {
  const params = { userId, tz: normalizeTimezone(tz), days: YEAR_DAYS };

  const [events, metrics] = await Promise.all([
    query<{ date: string; prompts: number; ultrathinks: number; estimated: number }>(
      `SELECT
         toString(toDate(${LOCAL_TS_SQL})) AS date,
         toUInt64(countIf(${PROMPT_EVENT_SQL})) AS prompts,
         toUInt64(countIf(${ULTRATHINK_EVENT_SQL})) AS ultrathinks,
         toUInt64(countIf(${PROMPT_EVENT_SQL} AND ${ESTIMATED_SQL})) AS estimated
       FROM events_raw FINAL
       WHERE user_id = {userId:String}
         AND toDate(timestamp) >= today() - {days:UInt32}
       GROUP BY date`,
      params
    ),
    query<{ date: string; value: number; lines: number; estimated: number }>(
      `SELECT
         toString(toDate(${LOCAL_TS_SQL})) AS date,
         toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage')) AS value,
         toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added')) AS lines,
         toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage' AND ${ESTIMATED_SQL})) AS estimated
       FROM metrics_raw FINAL
       WHERE user_id = {userId:String}
         AND toDate(timestamp) >= today() - {days:UInt32}
       GROUP BY date`,
      params
    ),
  ]);

  const byDate = new Map<string, ContributionDay>();
  const day = (date: string): ContributionDay => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const fresh: ContributionDay = {
      date,
      prompts: 0,
      value: 0,
      lines: 0,
      ultrathinks: 0,
      estimated: false,
    };
    byDate.set(date, fresh);
    return fresh;
  };

  for (const row of events) {
    const entry = day(row.date);
    entry.prompts = Number(row.prompts) || 0;
    entry.ultrathinks = Number(row.ultrathinks) || 0;
    // A day counts as recovered when MOST of it was. A single live prompt on a
    // backfilled day should not relabel the day as measured, and one recovered
    // prompt on a live day should not relabel it as an estimate.
    if (entry.prompts > 0 && (Number(row.estimated) || 0) * 2 > entry.prompts) {
      entry.estimated = true;
    }
  }

  for (const row of metrics) {
    const entry = day(row.date);
    entry.value = Number(row.value) || 0;
    entry.lines = Number(row.lines) || 0;
    if (entry.prompts === 0 && entry.value > 0 && (Number(row.estimated) || 0) * 2 > entry.value) {
      entry.estimated = true;
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ═══════════════════════════════════════════════════════════════════════════
// ⚡ The activity curve
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The curve's vocabulary — which metrics, ranges and granularities exist — is
 * defined ONCE, in src/components/profile/curve.ts, because the renderer that
 * both the server and the island run has to agree with the endpoint about what
 * a metric is called. A query string is the only thing between them.
 */
export function parseCurveMetric(value: string | undefined): CurveMetric {
  return CURVE_METRICS.includes(value as CurveMetric) ? (value as CurveMetric) : 'value';
}

export function parseCurvePeriod(value: string | undefined): CurvePeriod {
  return CURVE_PERIODS.includes(value as CurvePeriod) ? (value as CurvePeriod) : '1y';
}

export function parseCurveGroupBy(value: string | undefined): ChartGroupBy {
  return CURVE_GROUP_BYS.includes(value as ChartGroupBy) ? (value as ChartGroupBy) : 'week';
}

const PERIOD_DAYS: Record<CurvePeriod, number | null> = {
  '30d': 30,
  '90d': 90,
  '1y': 365,
  all: null,
};

/**
 * Which rows each metric is counted over, and from which table.
 *
 * One predicate per metric rather than one query per metric: every bucket then
 * carries both its total and the part of that total that was recovered, from
 * the same scan, so the two can never disagree about a bucket.
 */
const CURVE_SOURCES: Record<
  CurveMetric,
  { table: 'events_raw' | 'metrics_raw'; expr: (predicate: string) => string; match: string }
> = {
  prompts: {
    table: 'events_raw',
    match: PROMPT_EVENT_SQL,
    expr: (p) => `toFloat64(countIf(${p}))`,
  },
  toolCalls: {
    table: 'events_raw',
    match: `event_name = 'claude_code.tool_result' AND tool_name != ''`,
    expr: (p) => `toFloat64(countIf(${p}))`,
  },
  ultrathinks: {
    table: 'events_raw',
    match: ULTRATHINK_EVENT_SQL,
    expr: (p) => `toFloat64(countIf(${p}))`,
  },
  value: {
    table: 'metrics_raw',
    match: `metric_name = 'claude_code.cost.usage'`,
    expr: (p) => `toFloat64(sumIf(value, ${p}))`,
  },
  lines: {
    table: 'metrics_raw',
    match: `metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added'`,
    expr: (p) => `toFloat64(sumIf(value, ${p}))`,
  },
};

export async function fetchCurve(
  userId: string,
  metric: CurveMetric,
  period: CurvePeriod,
  groupBy: ChartGroupBy
): Promise<CurveView> {
  const source = CURVE_SOURCES[metric];
  const days = PERIOD_DAYS[period];
  // UTC day boundaries, matching /api/me/chart: a week/month bucket is then an
  // exact partition of the days the daily view shows, and the two reconcile.
  const dateFilter = days === null ? '' : `AND toDate(timestamp) >= today() - ${days}`;

  const rows = await query<{ date: string; total: number; estimated: number }>(
    `SELECT
       ${bucketSql(groupBy)},
       ${source.expr(source.match)} AS total,
       ${source.expr(`${source.match} AND ${ESTIMATED_SQL}`)} AS estimated
     FROM ${source.table} FINAL
     WHERE user_id = {userId:String} ${dateFilter}
     GROUP BY date
     HAVING total > 0
     ORDER BY date`,
    { userId }
  );

  const points: CurvePointView[] = rows.map((row) => {
    const value = Number(row.total) || 0;
    const estimated = Number(row.estimated) || 0;
    return {
      key: row.date,
      label: bucketLabel(row.date, groupBy),
      value,
      estimatedShare: value > 0 ? Math.min(1, estimated / value) : 0,
    };
  });

  const total = points.reduce((sum, point) => sum + point.value, 0);
  const best = points.reduce<CurvePointView | null>(
    (top, point) => (!top || point.value > top.value ? point : top),
    null
  );

  return {
    metric,
    period,
    groupBy,
    points,
    summary: {
      total,
      average: points.length > 0 ? total / points.length : 0,
      best,
      estimatedBuckets: points.filter((point) => point.estimatedShare > 0.5).length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ☀️ Today, and 🩺 the pipeline behind it
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Today, in the owner's own day. NEVER cached: the whole point of this panel is
 * that the owner runs Claude Code, reloads, and watches it move. Behind even a
 * 60-second cache it reads as broken.
 */
export async function fetchToday(userId: string, tz: string): Promise<TodayData> {
  const params = { userId, tz: normalizeTimezone(tz) };
  const today = `toDate(${LOCAL_TS_SQL}) = toDate(toTimeZone(now(), {tz:String}))`;

  const [events, metrics] = await Promise.all([
    query<{ prompts: number; ultrathinks: number; last_event: string | null }>(
      `SELECT
         toUInt64(countIf(${PROMPT_EVENT_SQL} AND ${today})) AS prompts,
         toUInt64(countIf(${ULTRATHINK_EVENT_SQL} AND ${today})) AS ultrathinks,
         toString(max(timestamp)) AS last_event
       FROM events_raw FINAL
       WHERE user_id = {userId:String}
         AND toDate(timestamp) >= today() - 2`,
      params
    ),
    query<{ value: number; lines: number }>(
      `SELECT
         toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage' AND ${today})) AS value,
         toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added' AND ${today})) AS lines
       FROM metrics_raw FINAL
       WHERE user_id = {userId:String}
         AND toDate(timestamp) >= today() - 2`,
      params
    ),
  ]);

  const event = events[0];
  return {
    prompts: Number(event?.prompts) || 0,
    ultrathinks: Number(event?.ultrathinks) || 0,
    value: Number(metrics[0]?.value) || 0,
    lines: Number(metrics[0]?.lines) || 0,
    lastEventAt: isoOrNull(event?.last_event),
  };
}

/**
 * Is the data still arriving, and through what.
 *
 * This is `clawdgg doctor` on the page: the last LIVE row is the silent-drop
 * heartbeat (a telemetry pipe that stops is invisible on every other panel,
 * because the history stays), and the rest names each hop so a reader can tell
 * which one went quiet.
 */
export async function fetchPipeline(userId: string): Promise<PipelineData> {
  const [rows, devices] = await Promise.all([
    query<{
      last_live: string | null;
      hook_events: number;
      cli_version: string;
      imported_from: string | null;
      imported_to: string | null;
    }>(
      `SELECT
         toString(maxOrNull(if(provenance IN ('live', 'repair'), timestamp, NULL))) AS last_live,
         toUInt64(countIf(provenance = 'hook')) AS hook_events,
         argMax(app_version, if(app_version != '', timestamp, toDateTime(0))) AS cli_version,
         toString(minOrNull(if(${ESTIMATED_SQL}, toDate(timestamp), NULL))) AS imported_from,
         toString(maxOrNull(if(${ESTIMATED_SQL}, toDate(timestamp), NULL))) AS imported_to
       FROM events_raw FINAL
       WHERE user_id = {userId:String}`,
      { userId }
    ),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(deviceTokens)
      .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)))
      .get(),
  ]);

  const row = rows[0];
  return {
    lastLiveEventAt: isoOrNull(row?.last_live),
    devices: Number(devices?.count) || 0,
    ultrathinkHook: (Number(row?.hook_events) || 0) > 0,
    cliVersion: row?.cli_version ? row.cli_version : null,
    importedFrom: dateOrNull(row?.imported_from),
    importedTo: dateOrNull(row?.imported_to),
  };
}

/** ClickHouse hands back bare timestamps; the UI wants an instant or nothing. */
function isoOrNull(value: string | null | undefined): string | null {
  if (!value || value.startsWith('1970-01-01') || value.startsWith('0000')) return null;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function dateOrNull(value: string | null | undefined): string | null {
  if (!value || value.startsWith('1970-01-01') || value.startsWith('0000')) return null;
  return value.slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// 💎 The plan
// ═══════════════════════════════════════════════════════════════════════════

/** How far back the sawtooth looks: four seven-day cycles and a little slack. */
const PLAN_LOOKBACK_SECONDS = 30 * 86_400;

/** Below this many samples a cycle is a dot, not a curve, and is left out. */
const MIN_SAMPLES_PER_CYCLE = 2;

/**
 * The plan panel, from the statusLine snapshots in SQLite.
 *
 * There is no API for this — Claude Code's status line is the only channel it
 * arrives through (see src/lib/plan-usage.ts) — so a user who has never run
 * the CLI with a status line has no plan data at all, and the panel is simply
 * absent rather than drawn at zero.
 */
export async function fetchPlan(userId: string): Promise<PlanData | null> {
  const since = Math.floor(Date.now() / 1000) - PLAN_LOOKBACK_SECONDS;

  const rows = await db
    .select({
      windowType: planUsageSnapshots.windowType,
      usedPercentage: planUsageSnapshots.usedPercentage,
      resetsAt: planUsageSnapshots.resetsAt,
      capturedAt: planUsageSnapshots.capturedAt,
    })
    .from(planUsageSnapshots)
    .where(and(eq(planUsageSnapshots.userId, userId), gte(planUsageSnapshots.capturedAt, since)))
    .orderBy(desc(planUsageSnapshots.capturedAt))
    .limit(4000);

  if (rows.length === 0) return null;

  const latestOf = (windowType: string): PlanWindow | null => {
    const row = rows.find((candidate) => candidate.windowType === windowType);
    return row
      ? {
          usedPercentage: row.usedPercentage,
          resetsAt: row.resetsAt ?? null,
          capturedAt: row.capturedAt,
        }
      : null;
  };

  const weekly = latestOf('seven_day');
  const session = latestOf('five_hour');

  const sevenDay = rows
    .filter((row) => row.windowType === 'seven_day')
    .map((row) => ({ at: row.capturedAt, pct: row.usedPercentage, resetsAt: row.resetsAt ?? null }))
    .sort((a, b) => a.at - b.at);

  return {
    weekly,
    session,
    cycles: splitCycles(sevenDay),
    projectedPct: projectWeekly(weekly),
  };
}

/**
 * Samples → cycles, split where the window RESET.
 *
 * The boundary is a drop in the percentage or a change of `resets_at`, not a
 * calendar week: the seven-day window is anchored to whenever the account's
 * own cycle started, and slicing it by Monday would cut every tooth in half.
 */
export function splitCycles(
  samples: readonly { at: number; pct: number; resetsAt: number | null }[]
): PlanCycle[] {
  const cycles: { samples: { at: number; pct: number }[] }[] = [];
  let previous: { pct: number; resetsAt: number | null } | null = null;

  for (const sample of samples) {
    const reset =
      previous !== null &&
      (sample.pct + 1 < previous.pct || sample.resetsAt !== previous.resetsAt);
    if (reset || cycles.length === 0) cycles.push({ samples: [] });
    cycles[cycles.length - 1]!.samples.push({ at: sample.at, pct: sample.pct });
    previous = { pct: sample.pct, resetsAt: sample.resetsAt };
  }

  const usable = cycles.filter((cycle) => cycle.samples.length >= MIN_SAMPLES_PER_CYCLE);

  return usable.slice(-4).map((cycle, index, all) => ({
    from: cycle.samples[0]!.at,
    to: cycle.samples[cycle.samples.length - 1]!.at,
    peakPct: Math.max(...cycle.samples.map((sample) => sample.pct)),
    samples: cycle.samples,
    current: index === all.length - 1,
  }));
}

/**
 * Where the weekly window lands if the rest of it goes like the part so far.
 *
 * Straight-line from the window's start, which is what "on pace" means: used
 * ÷ elapsed × the full window. Null without a reset boundary, because then the
 * elapsed fraction is unknown and a projection would be invented.
 */
export function projectWeekly(weekly: PlanWindow | null): number | null {
  if (!weekly?.resetsAt) return null;

  const windowSeconds = 7 * 86_400;
  const startedAt = weekly.resetsAt - windowSeconds;
  const elapsed = weekly.capturedAt - startedAt;
  if (elapsed <= 0 || elapsed >= windowSeconds) return null;
  // Below a few hours in, the extrapolation is noise multiplied by 40.
  if (elapsed < 6 * 3_600) return null;

  return Math.min(400, (weekly.usedPercentage / elapsed) * windowSeconds);
}

// ═══════════════════════════════════════════════════════════════════════════
// Identity
// ═══════════════════════════════════════════════════════════════════════════

export interface ProfileUser {
  id: string;
  githubUsername: string;
  avatarUrl: string | null;
  firstSessionDate: string | null;
  timezone: string;
  currentStreak: number;
  longestStreak: number;
}

export async function fetchProfileUser(username: string): Promise<ProfileUser | null> {
  const row = await db
    .select({
      id: users.id,
      githubUsername: users.githubUsername,
      avatarUrl: users.avatarUrl,
      firstSessionDate: users.firstSessionDate,
      timezone: users.timezone,
      currentStreak: users.currentStreak,
      longestStreak: users.longestStreak,
    })
    .from(users)
    .where(eq(users.githubUsername, username))
    .get();

  if (!row) return null;

  return {
    id: row.id,
    githubUsername: row.githubUsername,
    avatarUrl: row.avatarUrl,
    firstSessionDate: row.firstSessionDate,
    timezone: row.timezone || DEFAULT_TIMEZONE,
    currentStreak: row.currentStreak ?? 0,
    longestStreak: row.longestStreak ?? 0,
  };
}

/** Today, in the user's own zone — the contribution grid's right-hand edge. */
export function localToday(tz: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: normalizeTimezone(tz) }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
