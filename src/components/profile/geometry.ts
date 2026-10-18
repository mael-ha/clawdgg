/**
 * Ring geometry for the fingerprint's four dials.
 *
 * Pure arithmetic over the fingerprint payload: in, a `number[]` of hours or a
 * list of shares; out, SVG path strings and label positions. No JSX, no DOM, no
 * database — which is what lets the rings be tested at the number level and
 * rendered server-side with nothing but the payload.
 *
 * EVERY RING SHARES ONE FRAME: a 240×240 viewBox, centre (120, 120), angle 0
 * pointing at 12 o'clock and sweeping clockwise. The radii below are the only
 * place that frame is described, so a ring cannot drift half a pixel out of
 * line with its neighbours.
 */

import {
  CONTRIB_BEFORE,
  CONTRIB_RAMP,
  FAINT,
  SUN,
  WEEKEND,
  familyColor,
  languageColor,
  quadrantOf,
  shade,
  ICE,
  MONTH_NAMES,
  WEEKDAY_INITIALS,
  WEEKDAY_NAMES,
} from './palette';
import type { ModelFamilyShare, RingItem } from '../../lib/fingerprint';

export const VIEW = 240;
const CX = VIEW / 2;
const CY = VIEW / 2;
const TOP = -Math.PI / 2;
const TAU = Math.PI * 2;

/** A point on the ring, `r` from the centre at angle `a`. */
export function polar(r: number, a: number): [number, number] {
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

const f = (n: number): string => n.toFixed(2);

/** A closed annulus — the degenerate "one slice is everything" case. */
function annulus(r0: number, r1: number): string {
  return (
    `M ${f(CX - r1)} ${f(CY)} A ${r1} ${r1} 0 1 1 ${f(CX + r1)} ${f(CY)} ` +
    `A ${r1} ${r1} 0 1 1 ${f(CX - r1)} ${f(CY)} Z ` +
    `M ${f(CX - r0)} ${f(CY)} A ${r0} ${r0} 0 1 0 ${f(CX + r0)} ${f(CY)} ` +
    `A ${r0} ${r0} 0 1 0 ${f(CX - r0)} ${f(CY)} Z `
  );
}

/**
 * The wedge between two radii and two angles.
 *
 * Returns '' for a sweep too small to draw: the alternative is a path whose end
 * angle precedes its start, which renders as a stray spike across the dial.
 */
export function arcPath(r0: number, r1: number, a0: number, a1: number): string {
  const sweep = a1 - a0;
  if (sweep <= 0.001) return '';
  if (sweep >= TAU - 0.001) return annulus(r0, r1);

  const A = polar(r0, a0);
  const B = polar(r1, a0);
  const C = polar(r1, a1);
  const D = polar(r0, a1);
  const large = sweep > Math.PI ? 1 : 0;

  return (
    `M ${f(A[0])} ${f(A[1])} L ${f(B[0])} ${f(B[1])} ` +
    `A ${r1} ${r1} 0 ${large} 1 ${f(C[0])} ${f(C[1])} ` +
    `L ${f(D[0])} ${f(D[1])} ` +
    `A ${r0} ${r0} 0 ${large} 0 ${f(A[0])} ${f(A[1])} Z `
  );
}

/** A gap that can never swallow the slice it is trimming. */
function trim(span: number, gap: number): number {
  return Math.min(gap, span / 3);
}

export interface Wedge {
  d: string;
  color: string;
  /** What this wedge is, for the ring's aria description. */
  label: string;
}

export interface RingLabel {
  x: string;
  y: string;
  text: string;
  color: string;
}

export interface Ring {
  wedges: Wedge[];
  /** Hour marks, as one multi-segment path. Empty for the donuts. */
  ticks: string;
  labels: RingLabel[];
  /** The big figure in the middle, and the line under it. */
  big: string;
  small: string;
  aria: string;
  legend: { name: string; color: string }[];
  /** True when there is nothing to draw — the card shows a placeholder. */
  empty: boolean;
}

const EMPTY_RING: Omit<Ring, 'aria' | 'small'> = {
  wedges: [],
  ticks: '',
  labels: [],
  big: '—',
  legend: [],
  empty: true,
};

function labelAt(r: number, a: number, text: string, color: string): RingLabel {
  const [x, y] = polar(r, a);
  // +3.5 puts the glyph's optical centre on the ring rather than its baseline.
  return { x: f(x), y: f(y + 3.5), text, color };
}

// ═══════════════════════════════════════════════════════════════════════════
// ⏱ hours — a 24-hour clock
// ═══════════════════════════════════════════════════════════════════════════

const BAR_INNER = 52;
const BAR_LENGTH = 46;
const TICK_INNER = 100;
const HOUR_LABEL_R = 114;

/**
 * Radial bars, one per local hour, scaled against the busiest hour.
 *
 * The floor of 0.05 is deliberate: an hour with a handful of prompts in it is
 * not an hour with none, and a bar too short to see would say it was.
 */
export function hoursRing(hours: readonly number[], peakHour: number | null): Ring {
  const counts = Array.from({ length: 24 }, (_, h) => Math.max(0, hours[h] ?? 0));
  const total = counts.reduce((sum, n) => sum + n, 0);
  const legend = [
    { name: 'night', color: quadrantOf(0).color },
    { name: 'morning', color: quadrantOf(6).color },
    { name: 'afternoon', color: quadrantOf(12).color },
    { name: 'evening', color: quadrantOf(18).color },
  ];

  if (total === 0) {
    return { ...EMPTY_RING, legend, small: 'no hours yet', aria: 'Activity by hour: no data yet' };
  }

  const peak = Math.max(...counts);
  const wedges: Wedge[] = [];
  let ticks = '';

  for (let h = 0; h < 24; h++) {
    const a0 = TOP + (h / 24) * TAU;
    const a1 = TOP + ((h + 1) / 24) * TAU;
    const height = Math.max(0.05, counts[h]! / peak);
    wedges.push({
      d: arcPath(BAR_INNER, BAR_INNER + height * BAR_LENGTH, a0 + 0.025, a1 - 0.025),
      color: quadrantOf(h).color,
      label: `${String(h).padStart(2, '0')}:00`,
    });

    const [x0, y0] = polar(TICK_INNER, a0);
    const [x1, y1] = polar(h % 3 === 0 ? 106 : 103, a0);
    ticks += `M ${f(x0)} ${f(y0)} L ${f(x1)} ${f(y1)} `;
  }

  const labels = Array.from({ length: 8 }, (_, k) => {
    const hour = k * 3;
    return labelAt(
      HOUR_LABEL_R,
      TOP + (k / 8) * TAU,
      String(hour).padStart(2, '0'),
      peakHour !== null && Math.floor(peakHour / 3) === k ? SUN : FAINT
    );
  });

  return {
    wedges,
    ticks,
    labels,
    big: peakHour === null ? '—' : `${peakHour}h`,
    small: 'peak hour',
    aria:
      peakHour === null
        ? 'Activity by hour of the day'
        : `Activity by hour of the day, busiest at ${peakHour}:00 local time`,
    legend,
    empty: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 📆 week — seven sectors, Monday at the top, clockwise
// ═══════════════════════════════════════════════════════════════════════════

const WEEK_LABEL_R = 112;

export function weekRing(
  weekdays: readonly number[],
  busiestDay: { weekday: number; share: number } | null,
  weekdayShare: number
): Ring {
  const counts = Array.from({ length: 7 }, (_, d) => Math.max(0, weekdays[d] ?? 0));
  const total = counts.reduce((sum, n) => sum + n, 0);
  const weekendShare = Math.max(0, 100 - weekdayShare);
  const legend = [
    { name: `weekdays ${Math.round(weekdayShare)}%`, color: ICE },
    { name: `weekend ${Math.round(weekendShare)}%`, color: WEEKEND },
  ];

  if (total === 0) {
    return { ...EMPTY_RING, legend: [], small: 'no days yet', aria: 'Activity by weekday: no data yet' };
  }

  const peak = Math.max(...counts);
  const wedges: Wedge[] = [];
  const labels: RingLabel[] = [];

  for (let d = 0; d < 7; d++) {
    const a0 = TOP + (d / 7) * TAU;
    const a1 = TOP + ((d + 1) / 7) * TAU;
    wedges.push({
      d: arcPath(BAR_INNER, BAR_INNER + (counts[d]! / peak) * BAR_LENGTH, a0 + 0.05, a1 - 0.05),
      // Saturday and Sunday keep the hue and lose the light: the weekend is
      // the same measurement, just not the week.
      color: d >= 5 ? WEEKEND : ICE,
      label: WEEKDAY_NAMES[d]!,
    });
    labels.push(
      labelAt(
        WEEK_LABEL_R,
        (a0 + a1) / 2,
        WEEKDAY_INITIALS[d]!,
        busiestDay?.weekday === d ? ICE : FAINT
      )
    );
  }

  return {
    wedges,
    ticks: '',
    labels,
    big: busiestDay ? WEEKDAY_NAMES[busiestDay.weekday] ?? '—' : '—',
    // Short enough to fit the 104-unit hole at every size this ring is drawn
    // at. "busiest" is dropped because the big figure already IS the busiest
    // day, and the longer string ran out over the wedges on a phone.
    small: `${Math.round(weekdayShare)}% weekdays`,
    aria: busiestDay
      ? `Activity by weekday, busiest on ${WEEKDAY_NAMES[busiestDay.weekday]}, ` +
        `${Math.round(weekdayShare)} percent on weekdays`
      : 'Activity by weekday',
    legend,
    empty: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🧬 languages — a donut, biggest first
// ═══════════════════════════════════════════════════════════════════════════

const DONUT_INNER = 70;
const DONUT_OUTER = 104;
const LEGEND_MAX = 4;

export function languagesRing(items: readonly RingItem[], top: RingItem | null): Ring {
  const slices = items.filter((item) => item.share > 0);
  if (slices.length === 0) {
    return { ...EMPTY_RING, small: 'no edits yet', aria: 'Languages edited: no data yet' };
  }

  const wedges: Wedge[] = [];
  let a = TOP;
  slices.forEach((item, index) => {
    const span = (item.share / 100) * TAU;
    const gap = trim(span, 0.02);
    wedges.push({
      d: arcPath(DONUT_INNER, DONUT_OUTER, a + gap, a + span - gap),
      color: languageColor(item.name, index),
      label: `${item.name} ${Math.round(item.share)}%`,
    });
    a += span;
  });

  return {
    wedges,
    ticks: '',
    labels: [],
    big: top ? `${Math.round(top.share)}%` : '—',
    small: top?.name ?? '',
    aria: `Languages edited: ${slices
      .slice(0, LEGEND_MAX)
      .map((item) => `${item.name} ${Math.round(item.share)} percent`)
      .join(', ')}`,
    legend: slices.slice(0, LEGEND_MAX).map((item, index) => ({
      name: `${item.name} ${Math.round(item.share)}%`,
      color: languageColor(item.name, index),
    })),
    empty: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🧠 models — versions inside, families outside
// ═══════════════════════════════════════════════════════════════════════════

const MODEL_INNER = 64;
const MODEL_INNER_OUTER = 92;
const MODEL_BAND_INNER = 96;
const MODEL_BAND_OUTER = 104;

/**
 * Two concentric rings off one split: the thick inner one is a wedge per model
 * VERSION, the thin outer band a wedge per FAMILY spanning its versions.
 *
 * Both are shares of API-equivalent VALUE, not of tokens — about 95% of tokens
 * are cache reads at a twentieth of the price, so a token split answers "which
 * model reads the most context" and this one answers where the money went.
 *
 * `versions[].share` is a share OF ITS FAMILY (groupModelsByFamily says so),
 * so a version's sweep is the product of the two shares. Taking it as a share
 * of the whole would draw a ring that sums to several hundred percent.
 */
export function modelsRing(families: readonly ModelFamilyShare[], top: ModelFamilyShare | null): Ring {
  const present = families.filter((family) => family.share > 0);
  if (present.length === 0) {
    return { ...EMPTY_RING, small: 'no models yet', aria: 'Model mix: no data yet' };
  }

  const wedges: Wedge[] = [];
  const band: Wedge[] = [];
  let a = TOP;

  present.forEach((family, index) => {
    const base = familyColor(family.family, index);
    const start = a;

    family.versions
      .filter((version) => version.share > 0)
      .forEach((version, versionIndex) => {
        const span = (family.share / 100) * (version.share / 100) * TAU;
        const gap = trim(span, 0.015);
        wedges.push({
          d: arcPath(MODEL_INNER, MODEL_INNER_OUTER, a + gap, a + span - gap),
          // 0.32 per step: four versions still land above the card background,
          // so the darkest one is a shade of the family and not a hole.
          color: shade(base, Math.min(0.72, versionIndex * 0.32)),
          label: `${family.family} ${version.name} ${Math.round(version.share)}%`,
        });
        a += span;
      });

    // A family whose versions all rounded to nothing still owns its band.
    if (a === start) a = start + (family.share / 100) * TAU;

    const span = a - start;
    const gap = trim(span, 0.02);
    band.push({
      d: arcPath(MODEL_BAND_INNER, MODEL_BAND_OUTER, start + gap, a - gap),
      color: base,
      label: `${family.family} ${Math.round(family.share)}%`,
    });
  });

  const topVersion = top?.versions.find((version) => version.share > 0);
  // "Opus 5.5" under a centre that already says "Opus" is the family twice,
  // and the pair overflowed the hole. getModelDisplayName returns
  // "<family> <version>", so the prefix comes straight back off.
  const versionOnly = topVersion?.name.startsWith(`${top?.family} `)
    ? topVersion.name.slice((top?.family.length ?? 0) + 1)
    : topVersion?.name;

  return {
    wedges: [...wedges, ...band],
    ticks: '',
    labels: [],
    big: top ? `${Math.round(top.share)}%` : '—',
    small: top ? `${top.family}${versionOnly ? ` · ${versionOnly}` : ''}` : '',
    aria: `Model mix by API-equivalent value: ${present
      .map((family) => `${family.family} ${Math.round(family.share)} percent`)
      .join(', ')}`,
    legend: present.slice(0, LEGEND_MAX).map((family, index) => ({
      name:
        `${family.family} ${Math.round(family.share)}%` +
        (family.versions.length > 0
          ? ` (${family.versions.map((version) => version.name).join(' · ')})`
          : ''),
      color: familyColor(family.family, index),
    })),
    empty: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 📅 the year — the contribution grid
// ═══════════════════════════════════════════════════════════════════════════

export interface ContributionDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  prompts: number;
  value: number;
  lines: number;
  ultrathinks: number;
  /**
   * True when this day's numbers were RECOVERED rather than measured live —
   * reconstructed from session transcripts or the pre-OTEL daily summary. The
   * square is hatched so a reader can tell the two apart.
   */
  estimated: boolean;
}

export type CellKind = 'day' | 'before' | 'future';

export interface GridCell {
  date: string;
  kind: CellKind;
  /** 0–4 against the window's busiest day. */
  level: number;
  prompts: number;
  value: number;
  lines: number;
  ultrathinks: number;
  estimated: boolean;
}

export interface Grid {
  /** Columns, oldest first; each is 7 cells, Monday first. */
  weeks: GridCell[][];
  /** One entry per column — the month's name on the column it starts in. */
  monthLabels: string[];
  activeDays: number;
}

const DAY_MS = 86_400_000;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnight(date: string): number {
  return Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
}

/**
 * The grid, built backwards from `today` so the newest week is the rightmost
 * column and the last row is always today's weekday.
 *
 * `weeks` counts columns: 53 on the desktop graph, 26 on a phone. The mobile
 * graph is the same function with a smaller window rather than a second grid,
 * because two grids is two chances to be off by a day.
 */
export function contributionGrid(
  days: readonly ContributionDay[],
  options: { today: string; weeks: number; joined?: string | null }
): Grid {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const todayMs = utcMidnight(options.today);
  const joinedMs = options.joined ? utcMidnight(options.joined) : null;

  // Monday of today's week, then back `weeks - 1` more weeks.
  const weekday = (new Date(todayMs).getUTCDay() + 6) % 7;
  const startMs = todayMs - weekday * DAY_MS - (options.weeks - 1) * 7 * DAY_MS;

  const peak = Math.max(
    1,
    ...days.map((day) => Math.max(day.prompts, 0)),
  );

  const weeks: GridCell[][] = [];
  const monthLabels: string[] = [];
  let previousMonth = -1;
  let activeDays = 0;

  for (let w = 0; w < options.weeks; w++) {
    const column: GridCell[] = [];
    const columnStart = startMs + w * 7 * DAY_MS;
    const month = new Date(columnStart).getUTCMonth();
    // The label goes on the column the month STARTS in. Every fourth column
    // (what this graph used to do) drifts a label away from its month within
    // two months and reads as an off-by-one.
    monthLabels.push(month === previousMonth ? '' : MONTH_NAMES[month] ?? '');
    previousMonth = month;

    for (let d = 0; d < 7; d++) {
      const ms = columnStart + d * DAY_MS;
      const date = isoDate(ms);
      const entry = byDate.get(date);

      let kind: CellKind = 'day';
      if (ms > todayMs) kind = 'future';
      else if (joinedMs !== null && ms < joinedMs && !entry) kind = 'before';

      const prompts = entry?.prompts ?? 0;
      if (prompts > 0 || (entry?.value ?? 0) > 0) activeDays++;

      column.push({
        date,
        kind,
        level: prompts > 0 ? Math.max(1, Math.ceil((prompts / peak) * 4)) : 0,
        prompts,
        value: entry?.value ?? 0,
        lines: entry?.lines ?? 0,
        ultrathinks: entry?.ultrathinks ?? 0,
        estimated: entry?.estimated ?? false,
      });
    }
    weeks.push(column);
  }

  return { weeks, monthLabels, activeDays };
}

/** The square's fill. Hatching is a CSS class, so an estimated day returns ''. */
export function cellFill(cell: GridCell): string {
  if (cell.kind === 'future') return 'transparent';
  if (cell.kind === 'before') return CONTRIB_BEFORE;
  if (cell.estimated && cell.level > 0) return '';
  return CONTRIB_RAMP[cell.level] ?? CONTRIB_RAMP[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// 🏁 the next milestone
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The thresholds a milestone can be, DUPLICATED from MILESTONE_SPECS in
 * src/lib/fingerprint.ts.
 *
 * The payload carries the milestones already CROSSED and says nothing about
 * what comes next, so the only way to draw a progress bar is to know the
 * ladder. Kept narrow on purpose — only the three kinds whose running total
 * the payload also carries, so a bar can never be drawn against a total this
 * page had to guess. See the hand-off note in the track report: this belongs in
 * the payload.
 */
const LADDERS = {
  prompts: { emoji: '💬', thresholds: [1_000, 10_000, 25_000, 50_000, 100_000], noun: 'prompts' },
  lines: { emoji: '📝', thresholds: [100_000, 1_000_000, 10_000_000], noun: 'lines written' },
  ultrathink: { emoji: '🌈', thresholds: [100, 1_000, 5_000], noun: 'ultrathinks' },
} as const;

export type LadderKind = keyof typeof LADDERS;

export interface NextMilestone {
  kind: LadderKind;
  emoji: string;
  label: string;
  target: number;
  current: number;
  /** 0–100. */
  progressPct: number;
  /** Weeks at the last 30 days' pace, or null when the pace is zero. */
  weeksAway: number | null;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${value / 1_000}K`;
  return String(value);
}

/**
 * The nearest unreached threshold across the three ladders.
 *
 * "Nearest" is measured in PROGRESS, not in absolute distance: 48,000 of 50,000
 * prompts and 90 of 100 ultrathinks are both nearly there, and the one the page
 * should point at is whichever is nearer in proportion. An absolute comparison
 * would always pick the ultrathink ladder, whose numbers are simply smaller.
 */
export function nextMilestone(
  totals: { prompts: number; lines: number; ultrathink: number },
  ratePerWeek: Partial<Record<LadderKind, number>> = {}
): NextMilestone | null {
  let best: NextMilestone | null = null;

  for (const kind of Object.keys(LADDERS) as LadderKind[]) {
    const ladder = LADDERS[kind];
    const current = Math.max(0, Math.floor(totals[kind] ?? 0));
    const target = ladder.thresholds.find((threshold) => current < threshold);
    if (target === undefined) continue;

    const progressPct = (current / target) * 100;
    const rate = ratePerWeek[kind] ?? 0;
    const candidate: NextMilestone = {
      kind,
      emoji: ladder.emoji,
      label: `${compact(target)} ${ladder.noun}`,
      target,
      current,
      progressPct,
      weeksAway: rate > 0 ? Math.max(1, Math.ceil((target - current) / rate)) : null,
    };
    if (!best || candidate.progressPct > best.progressPct) best = candidate;
  }

  return best;
}

// ═══════════════════════════════════════════════════════════════════════════
// 💎 The plan's sawtooth
// ═══════════════════════════════════════════════════════════════════════════

export interface SawtoothCycle {
  from: number;
  to: number;
  samples: readonly { at: number; pct: number }[];
  current: boolean;
}

export interface Sawtooth {
  line: string;
  area: string;
  /** x of each cycle boundary, for the dashed separators. */
  dividers: number[];
}

const WEEK_SECONDS = 7 * 86_400;

/**
 * Four weekly cycles side by side, each climbing from nothing to its peak and
 * dropping back at the reset.
 *
 * Every cycle gets an EQUAL slot and is plotted against elapsed time inside
 * its own window, so the teeth are comparable: a cycle that ran out early and
 * one that coasted have the same width, and the difference in slope is the
 * whole point of the chart. The current cycle stops where it has got to
 * instead of being stretched to fill its slot, which is what makes "you are
 * here" legible.
 */
export function sawtooth(
  cycles: readonly SawtoothCycle[],
  box: { width: number; height: number }
): Sawtooth {
  if (cycles.length === 0) return { line: '', area: '', dividers: [] };

  const slot = box.width / cycles.length;
  const y = (pct: number) => box.height - 1 - (Math.min(100, Math.max(0, pct)) / 100) * (box.height - 15);

  let line = '';
  let lastX = 0;
  const dividers: number[] = [];

  cycles.forEach((cycle, index) => {
    const left = index * slot;
    const span = Math.max(1, cycle.to - cycle.from);
    // A cycle observed for less than a full week is plotted over the week it
    // belongs to, not over the slice we happened to see.
    const scale = cycle.current ? WEEK_SECONDS : Math.max(span, WEEK_SECONDS * 0.5);

    line += `${index === 0 ? 'M' : ' L'} ${left.toFixed(1)} ${y(0).toFixed(1)}`;
    for (const sample of cycle.samples) {
      const x = left + Math.min(1, (sample.at - cycle.from) / scale) * slot;
      line += ` L ${x.toFixed(1)} ${y(sample.pct).toFixed(1)}`;
      lastX = x;
    }

    if (!cycle.current) {
      const right = left + slot;
      line += ` L ${right.toFixed(1)} ${y(0).toFixed(1)}`;
      lastX = right;
      if (index < cycles.length - 1) dividers.push(right);
    }
  });

  return {
    line,
    area: `${line} L ${lastX.toFixed(1)} ${y(0).toFixed(1)} L 0 ${y(0).toFixed(1)} Z`,
    dividers,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Small shared shapes
// ═══════════════════════════════════════════════════════════════════════════

/** A bar chart's bars as one path, in a `width`×`height` box. */
export function barsPath(
  values: readonly number[],
  box: { width: number; height: number; max?: number },
  pick: (index: number) => boolean = () => true
): string {
  if (values.length === 0) return '';
  const max = (box.max ?? Math.max(...values, 0)) || 1;
  const slot = box.width / values.length;
  let path = '';

  values.forEach((value, index) => {
    if (!pick(index)) return;
    const height = (Math.max(0, value) / max) * box.height;
    const x0 = index * slot + 1;
    const x1 = (index + 1) * slot - 1;
    const y = box.height - height;
    path +=
      `M ${x0.toFixed(1)} ${box.height} L ${x0.toFixed(1)} ${y.toFixed(1)} ` +
      `L ${x1.toFixed(1)} ${y.toFixed(1)} L ${x1.toFixed(1)} ${box.height} Z `;
  });

  return path;
}

/** A polyline through the middle of each bar's top edge. */
export function linePath(
  values: readonly number[],
  box: { width: number; height: number; max?: number }
): string {
  if (values.length === 0) return '';
  const max = (box.max ?? Math.max(...values, 0)) || 1;
  const slot = box.width / values.length;
  return values
    .map((value, index) => {
      const y = box.height - (Math.max(0, value) / max) * box.height;
      return `${index === 0 ? 'M' : 'L'} ${((index + 0.5) * slot).toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}
