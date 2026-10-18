/**
 * The activity curve, drawn as SVG by one function that both sides run.
 *
 * The server renders the default view into the page, and the island
 * (src/client/profile-curve.ts) calls the SAME function with the next
 * response and swaps the markup. One renderer, so a reader who clicks "90d"
 * cannot get a chart drawn by different code than the one they were looking
 * at — the mistake the old chart made by formatting on the server and
 * re-formatting on the client.
 *
 * It returns a string rather than JSX because the island has no JSX runtime:
 * everything in it is generated from numbers and from fixed labels, so there
 * is nothing here a user could have typed.
 */

import { ACCENT, ICE, LINE, PRIMARY, SUN, VIOLET } from './palette';
import { barsPath, linePath } from './geometry';
import { compact, group, money } from './format';

export const CURVE_METRICS = ['prompts', 'value', 'toolCalls', 'lines', 'ultrathinks'] as const;
export type CurveMetric = (typeof CURVE_METRICS)[number];

export const CURVE_PERIODS = ['30d', '90d', '1y', 'all'] as const;
export type CurvePeriod = (typeof CURVE_PERIODS)[number];

export const CURVE_GROUP_BYS = ['day', 'week', 'month'] as const;
export type CurveGroupBy = (typeof CURVE_GROUP_BYS)[number];

export interface CurvePointView {
  key: string;
  label: string;
  value: number;
  /** 0–1 — how much of this bucket was recovered rather than measured. */
  estimatedShare: number;
}

export interface CurveView {
  metric: CurveMetric;
  period: CurvePeriod;
  groupBy: CurveGroupBy;
  points: CurvePointView[];
  summary: {
    total: number;
    average: number;
    best: CurvePointView | null;
    estimatedBuckets: number;
  };
}

interface MetricStyle {
  /** What the control says. The 🌈 one is an emoji on purpose. */
  label: string;
  /** What the chart says, in prose, for the aria label and the footer. */
  noun: string;
  color: string;
  /** The rainbow metric paints its bars with a gradient instead. */
  gradient?: boolean;
  format: (value: number) => string;
}

export const METRIC_STYLE: Record<CurveMetric, MetricStyle> = {
  prompts: { label: 'prompts', noun: 'prompts', color: VIOLET, format: group },
  value: { label: 'value', noun: 'API-equivalent value', color: ACCENT, format: money },
  toolCalls: { label: 'tool calls', noun: 'tool calls', color: SUN, format: compact },
  lines: { label: 'lines', noun: 'lines added', color: PRIMARY, format: compact },
  ultrathinks: { label: '🌈', noun: 'ultrathinks', color: ICE, gradient: true, format: group },
};

export const PERIOD_LABELS: Record<CurvePeriod, string> = {
  '30d': '30d',
  '90d': '90d',
  '1y': '1y',
  all: 'all',
};

/** The box the curve is drawn in. Width is arbitrary — the SVG scales to fit. */
const BOX = { width: 1000, height: 240 };
/** Room at the top so the tallest bar does not touch the frame. */
const TOP_INSET = 20;
const PLOT_HEIGHT = BOX.height - TOP_INSET;

function rgba(hex: string, alpha: number): string {
  const read = (offset: number) => Number.parseInt(hex.slice(1 + offset, 3 + offset), 16);
  return `rgba(${read(0)},${read(2)},${read(4)},${alpha})`;
}

/**
 * A bucket counts as recovered when MORE THAN HALF of it was.
 *
 * A threshold rather than a gradient of opacities: the question a reader asks
 * of a faint bar is "can I trust this number", and that is a yes or a no.
 */
export function isEstimated(point: CurvePointView): boolean {
  return point.estimatedShare > 0.5;
}

/** The whole chart's innards: gridlines, bars, the recovered bars, the line. */
export function curveInner(view: CurveView): string {
  const style = METRIC_STYLE[view.metric];
  const values = view.points.map((point) => point.value);
  const max = Math.max(...values, 0) * 1.0 || 1;
  const box = { width: BOX.width, height: PLOT_HEIGHT, max };

  const measured = barsPath(values, box, (index) => !isEstimated(view.points[index]!));
  const recovered = barsPath(values, box, (index) => isEstimated(view.points[index]!));
  const line = linePath(values, box);

  const grid = [20, 100, 180]
    .map(
      (y) =>
        `<line x1="0" y1="${y}" x2="${BOX.width}" y2="${y}" stroke="${LINE}" stroke-width="1"></line>`
    )
    .join('');

  const gradient = style.gradient
    ? `<defs><linearGradient id="fp-curve-rainbow" x1="0" y1="0" x2="1" y2="0">` +
      ['#ff00ff', '#ff4d8d', '#fbbf24', '#00ff9f', '#67e8f9', '#c084fc']
        .map((stop, index, all) => `<stop offset="${(index / (all.length - 1)) * 100}%" stop-color="${stop}"/>`)
        .join('') +
      `</linearGradient></defs>`
    : '';

  const fill = style.gradient ? 'url(#fp-curve-rainbow)' : rgba(style.color, 0.22);
  const faint = style.gradient ? rgba(VIOLET, 0.1) : rgba(style.color, 0.07);

  return (
    gradient +
    grid +
    `<line x1="0" y1="${BOX.height - 1}" x2="${BOX.width}" y2="${BOX.height - 1}" stroke="#262b38" stroke-width="1"></line>` +
    `<g transform="translate(0,${TOP_INSET})">` +
    (recovered ? `<path d="${recovered}" fill="${faint}"></path>` : '') +
    (measured ? `<path d="${measured}" fill="${fill}" opacity="${style.gradient ? 0.5 : 1}"></path>` : '') +
    (line
      ? `<path d="${line}" fill="none" stroke="${style.gradient ? '#67e8f9' : style.color}" ` +
        `stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"></path>`
      : '') +
    '</g>'
  );
}

/**
 * Up to five x labels, evenly spaced over the buckets actually plotted.
 *
 * Read off the data rather than generated from the range: a user with three
 * weeks of history asked for "1y" gets three labels over three weeks, not
 * twelve months of empty axis.
 */
export function axisLabels(view: CurveView): string[] {
  const { points } = view;
  if (points.length === 0) return [];
  if (points.length <= 5) return points.map((point) => point.label);

  const step = (points.length - 1) / 4;
  return Array.from({ length: 5 }, (_, index) => points[Math.round(index * step)]!.label);
}

/** "1y $38.3K · avg $736/week · best $1,912 · wk of Jan 12" */
export function curveFooter(view: CurveView): { text: string; figure: string }[] {
  const style = METRIC_STYLE[view.metric];
  const unit = view.groupBy === 'day' ? 'day' : view.groupBy === 'week' ? 'week' : 'month';
  const rows = [
    { text: PERIOD_LABELS[view.period], figure: style.format(view.summary.total) },
    { text: 'avg', figure: `${style.format(view.summary.average)}/${unit}` },
  ];
  if (view.summary.best) {
    rows.push({
      text: `best ${unit}`,
      figure: `${style.format(view.summary.best.value)} · ${view.summary.best.label}`,
    });
  }
  return rows;
}

export function curveAria(view: CurveView): string {
  const style = METRIC_STYLE[view.metric];
  return `${style.noun} per ${view.groupBy}, ${PERIOD_LABELS[view.period]} — ${style.format(
    view.summary.total
  )} in total`;
}

