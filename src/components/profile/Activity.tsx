import type { FC } from 'hono/jsx';
import { SectionTitle } from './parts';
import {
  CURVE_GROUP_BYS,
  CURVE_METRICS,
  CURVE_PERIODS,
  METRIC_STYLE,
  PERIOD_LABELS,
  axisLabels,
  curveAria,
  curveFooter,
  curveInner,
  type CurveView,
} from './curve';
import type { Visibility } from './types';

/**
 * ⚡ activity — the curve, and the three controls that choose what it shows.
 *
 * SERVER-RENDERED, and the island only exists to answer a click. The old
 * version of this panel shipped chart.js, drew nothing until the bundle had
 * loaded and a fetch had come back, and was owner-only; this one is in the
 * HTML, is public (subject to the owner's toggle), and costs the reader who
 * never touches a control exactly nothing.
 *
 * The island (src/client/profile-curve.ts) re-renders with the same function
 * that produced this markup — see src/components/profile/curve.ts.
 */

const SEGMENT =
  'font-mono text-[12px] px-2.5 py-1.5 rounded-md border-0 bg-transparent text-fp-dim ' +
  'hover:text-fp-text transition-colors min-h-[32px]';
const SEGMENT_ON = 'font-mono text-[12px] px-2.5 py-1.5 rounded-md border-0 bg-fp-border text-fp-text min-h-[32px]';

const Segmented: FC<{ children?: unknown; label: string }> = ({ children, label }) => (
  <div
    role="group"
    aria-label={label}
    class="flex rounded-lg border border-fp-border bg-fp-card p-[3px]"
  >
    {children}
  </div>
);

export interface ActivityProps {
  view: CurveView;
  visibility: Visibility | null;
  /** The route the island re-fetches from. */
  endpoint: string;
}

export const Activity: FC<ActivityProps> = ({ view, visibility, endpoint }) => {
  const style = METRIC_STYLE[view.metric];
  const labels = axisLabels(view);
  const footer = curveFooter(view);
  const hasData = view.points.length > 0;

  return (
    <section class="flex flex-col gap-3.5">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SectionTitle
          title="⚡ activity"
          section="curve"
          isPublic={visibility?.curve}
        />
        <div class="flex flex-wrap gap-2.5">
          <Segmented label="metric">
            {CURVE_METRICS.map((metric) => (
              <button
                key={metric}
                type="button"
                data-fp-metric={metric}
                aria-pressed={metric === view.metric ? 'true' : 'false'}
                aria-label={METRIC_STYLE[metric].noun}
                class={metric === view.metric ? SEGMENT_ON : SEGMENT}
              >
                {METRIC_STYLE[metric].label}
              </button>
            ))}
          </Segmented>
          <Segmented label="range">
            {CURVE_PERIODS.map((period) => (
              <button
                key={period}
                type="button"
                data-fp-period={period}
                aria-pressed={period === view.period ? 'true' : 'false'}
                class={period === view.period ? SEGMENT_ON : SEGMENT}
              >
                {PERIOD_LABELS[period]}
              </button>
            ))}
          </Segmented>
          <Segmented label="granularity">
            {CURVE_GROUP_BYS.map((groupBy) => (
              <button
                key={groupBy}
                type="button"
                data-fp-groupby={groupBy}
                aria-pressed={groupBy === view.groupBy ? 'true' : 'false'}
                class={groupBy === view.groupBy ? SEGMENT_ON : SEGMENT}
              >
                {groupBy}
              </button>
            ))}
          </Segmented>
        </div>
      </div>

      <div
        id="fp-curve"
        class="flex flex-col gap-2.5 rounded-2xl border border-fp-border bg-fp-card px-4 pb-4 pt-5 sm:px-6"
        data-endpoint={endpoint}
        data-metric={view.metric}
        data-period={view.period}
        data-groupby={view.groupBy}
      >
        {/* The paths live inside a <g>, not straight on the <svg>: hono/jsx
            wraps every <svg> in a namespace node of its own, so the element
            already has a child and cannot also take dangerouslySetInnerHTML.
            The island replaces this one group's contents and leaves the frame
            and its aria-label in place. */}
        <div id="fp-curve-plot" class="relative h-[160px] w-full sm:h-[260px]" aria-live="polite">
          <svg
            id="fp-curve-svg"
            viewBox="0 0 1000 240"
            preserveAspectRatio="none"
            class={`block h-full w-full ${hasData ? '' : 'invisible'}`}
            role="img"
            aria-label={curveAria(view)}
          >
            <g id="fp-curve-paths" dangerouslySetInnerHTML={{ __html: curveInner(view) }} />
          </svg>
          <div
            id="fp-curve-empty"
            class={`absolute inset-0 items-center justify-center font-mono text-[12px] text-fp-faint ${
              hasData ? 'hidden' : 'flex'
            }`}
          >
            nothing in this range yet
          </div>
        </div>

        {/* Five labels is right at 1440px and two too many at 390px, where
            they run into each other — so the in-between ones drop out on a
            phone rather than the axis being rebuilt at a second length. */}
        <div
          id="fp-curve-axis"
          class="flex justify-between font-mono text-[10px] text-fp-faint sm:text-[11px]"
        >
          {labels.map((label, index) => (
            <span key={index} class={index % 2 === 1 ? 'hidden sm:inline' : ''}>
              {label}
            </span>
          ))}
        </div>

        <div
          id="fp-curve-footer"
          class="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-fp-line pt-3 font-mono text-[12px] text-fp-dim sm:text-[13px]"
        >
          {footer.map((row) => (
            <span key={row.text}>
              {row.text} <span class="text-fp-text">{row.figure}</span>
            </span>
          ))}
          {view.summary.estimatedBuckets > 0 && (
            <span class="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                class="inline-block h-2.5 w-2.5 border border-dashed"
                style={`border-color:${style.color};background:${style.color}14`}
              />
              estimated (recovered history)
            </span>
          )}
        </div>
      </div>
    </section>
  );
};
