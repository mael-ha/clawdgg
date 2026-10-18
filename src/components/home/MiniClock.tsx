import type { FC } from 'hono/jsx';

/**
 * A person's day, 30 pixels wide.
 *
 * 24 radial bars, one per local hour, coloured by quarter of the day — the
 * profile's hours ring at leaderboard size, so a row and a profile read as the
 * same drawing. The bar LENGTH is the hour's share of that user's own busiest
 * hour, never an absolute count: this sits in a column next to people who
 * prompt ten times as much, and an absolute scale would make everyone but the
 * top user a flat disc.
 *
 * Pure geometry, server-rendered. No island: it is 24 paths of static SVG and
 * nothing about it changes after paint.
 */

const CENTER = 60;
const INNER_RADIUS = 14;
const MAX_BAR = 40;
/** Keeps a silent hour visible as a stub, so the ring reads as a clock. */
const MIN_SHARE = 0.06;
/** Radians trimmed off each end of a bar, so neighbours do not touch. */
const GAP = 0.04;

const TOP = -Math.PI / 2;
const TAU = Math.PI * 2;

/** Night, morning, afternoon, evening — six hours each, same four colours as the profile. */
export const QUADRANT_COLORS = ['#c084fc', '#fbbf24', '#00ff9f', '#ff00ff'] as const;

function point(radius: number, angle: number): [string, string] {
  return [
    (CENTER + radius * Math.cos(angle)).toFixed(2),
    (CENTER + radius * Math.sin(angle)).toFixed(2),
  ];
}

/** One bar: an annular segment from `r0` to `r1` between two angles. */
function bar(r0: number, r1: number, a0: number, a1: number): string {
  const [ax, ay] = point(r0, a0);
  const [bx, by] = point(r1, a0);
  const [cx, cy] = point(r1, a1);
  const [dx, dy] = point(r0, a1);
  return `M ${ax} ${ay} L ${bx} ${by} A ${r1} ${r1} 0 0 1 ${cx} ${cy} L ${dx} ${dy} A ${r0} ${r0} 0 0 0 ${ax} ${ay} Z `;
}

/**
 * The four path strings, one per quarter of the day.
 *
 * Four paths rather than 24 because the colour only changes four times: a row
 * costs four <path> elements, which is what makes 25 of these per page cheap.
 */
export function clockQuadrantPaths(hours: number[]): [string, string, string, string] {
  const paths: [string, string, string, string] = ['', '', '', ''];
  // Non-finite counts are filtered rather than coerced: one NaN in the array
  // makes Math.max NaN, and every bar after it is drawn to a NaN radius — a
  // path the browser renders as a smear with no error anywhere.
  const counts = Array.from({ length: 24 }, (_, hour) => {
    const value = Number(hours[hour]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const peak = Math.max(...counts, 0);
  if (peak <= 0) return paths;

  for (let hour = 0; hour < 24; hour++) {
    const share = Math.max(MIN_SHARE, counts[hour]! / peak);
    const a0 = TOP + (hour / 24) * TAU + GAP;
    const a1 = TOP + ((hour + 1) / 24) * TAU - GAP;
    const quadrant = Math.floor(hour / 6);
    paths[quadrant] += bar(INNER_RADIUS, INNER_RADIUS + share * MAX_BAR, a0, a1);
  }
  return paths;
}

interface MiniClockProps {
  /** 24 local-hour prompt counts, or undefined when the owner hid their rings. */
  hours?: number[];
  size: number;
  username: string;
}

export const MiniClock: FC<MiniClockProps> = ({ hours, size, username }) => {
  const paths = hours ? clockQuadrantPaths(hours) : null;
  const drawn = paths?.some((d) => d.length > 0) ?? false;

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      class="shrink-0"
      role="img"
      aria-label={
        drawn ? `${username}'s hours, by quarter of the day` : `no hours shown for ${username}`
      }
    >
      <circle cx={CENTER} cy={CENTER} r="56" fill="none" stroke="#1a1f2b" stroke-width="1" />
      {drawn ? (
        paths!.map((d, index) =>
          d ? <path key={index} d={d} fill={QUADRANT_COLORS[index]} /> : null
        )
      ) : (
        // Nothing to draw: an empty dial, not a fake one. This is what a
        // hidden rings section and a brand-new account both look like.
        <circle
          cx={CENTER}
          cy={CENTER}
          r={INNER_RADIUS + 10}
          fill="none"
          stroke="#1a1f2b"
          stroke-width="6"
          stroke-dasharray="3 7"
        />
      )}
    </svg>
  );
};
