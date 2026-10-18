/**
 * ⚡ activity — the three controls, and nothing else.
 *
 * The server already rendered the chart, so this module's whole job is to
 * answer a click: fetch the next view and re-draw it with the SAME function
 * that produced the markup it is replacing (curveInner, in
 * src/components/profile/curve.ts). Two renderers would eventually disagree,
 * and the reader would see the chart change shape for no reason.
 *
 * No chart library. The previous version of this panel imported chart.js — a
 * ~70KB module on a page whose chart is twelve path strings — and drew nothing
 * until it had loaded and a request had come back.
 */

import {
  CURVE_METRICS,
  METRIC_STYLE,
  axisLabels,
  curveAria,
  curveFooter,
  curveInner,
  type CurveGroupBy,
  type CurveMetric,
  type CurvePeriod,
  type CurveView,
} from '../components/profile/curve';

const root = document.getElementById('fp-curve');
const plot = document.getElementById('fp-curve-plot');
const svg = document.getElementById('fp-curve-svg');
const paths = document.getElementById('fp-curve-paths');
const empty = document.getElementById('fp-curve-empty');
const axis = document.getElementById('fp-curve-axis');
const footer = document.getElementById('fp-curve-footer');

if (root && plot && svg && paths && empty && axis && footer) {
  const endpoint = root.dataset.endpoint ?? '';
  let metric = (root.dataset.metric ?? 'value') as CurveMetric;
  let period = (root.dataset.period ?? '1y') as CurvePeriod;
  let groupBy = (root.dataset.groupby ?? 'week') as CurveGroupBy;
  /** Discards a slow response that a later click has already superseded. */
  let request = 0;

  function paint(view: CurveView): void {
    const blank = view.points.length === 0;
    // Clear whatever the last failure left behind.
    empty!.classList.remove('text-fp-rose');
    empty!.textContent = 'nothing in this range yet';
    svg!.classList.toggle('invisible', blank);
    empty!.classList.toggle('hidden', !blank);
    empty!.classList.toggle('flex', blank);

    if (blank) {
      paths!.innerHTML = '';
      axis!.innerHTML = '';
      footer!.innerHTML = '';
      return;
    }

    // Only the group's contents change: the frame, its viewBox and its role
    // stay, which is also what keeps the aria-label a single live statement
    // rather than an element being torn out from under a screen reader.
    paths!.innerHTML = curveInner(view);
    svg!.setAttribute('aria-label', curveAria(view));

    // Same every-other-one rule the server rendered — see Activity.tsx.
    axis!.innerHTML = axisLabels(view)
      .map(
        (label, index) =>
          `<span class="${index % 2 === 1 ? 'hidden sm:inline' : ''}">${escapeText(label)}</span>`
      )
      .join('');

    const style = METRIC_STYLE[view.metric];
    const rows = curveFooter(view).map(
      (row) =>
        `<span>${escapeText(row.text)} <span class="text-fp-text">${escapeText(row.figure)}</span></span>`
    );
    if (view.summary.estimatedBuckets > 0) {
      rows.push(
        '<span class="flex items-center gap-1.5">' +
          `<span aria-hidden="true" class="inline-block h-2.5 w-2.5 border border-dashed" ` +
          `style="border-color:${style.color};background:${style.color}14"></span>` +
          'estimated (recovered history)</span>'
      );
    }
    footer!.innerHTML = rows.join('');
  }

  function syncControls(): void {
    for (const button of root!.querySelectorAll<HTMLButtonElement>('button[data-fp-metric]')) {
      press(button, button.dataset.fpMetric === metric);
    }
    for (const button of root!.parentElement?.querySelectorAll<HTMLButtonElement>(
      'button[data-fp-period]'
    ) ?? []) {
      press(button, button.dataset.fpPeriod === period);
    }
    for (const button of root!.parentElement?.querySelectorAll<HTMLButtonElement>(
      'button[data-fp-groupby]'
    ) ?? []) {
      press(button, button.dataset.fpGroupby === groupBy);
    }
  }

  const ON = 'bg-fp-border text-fp-text';
  const OFF = 'bg-transparent text-fp-dim hover:text-fp-text transition-colors';

  function press(button: HTMLButtonElement, on: boolean): void {
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.className =
      `font-mono text-[12px] px-2.5 py-1.5 rounded-md border-0 min-h-[32px] ${on ? ON : OFF}`;
  }

  async function load(): Promise<void> {
    const mine = ++request;
    plot!.style.opacity = '0.5';

    try {
      const params = new URLSearchParams({ metric, period, groupBy });
      const response = await fetch(`${endpoint}?${params}`, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const view = (await response.json()) as CurveView;
      if (mine !== request) return;
      paint(view);
    } catch (error) {
      if (mine !== request) return;
      console.error('curve:', error);
      svg!.classList.add('invisible');
      empty!.classList.remove('hidden');
      empty!.classList.add('flex', 'text-fp-rose');
      empty!.textContent = "couldn't load that range — try again";
    } finally {
      if (mine === request) plot!.style.opacity = '1';
    }
  }

  // Delegated on the section, because the controls sit OUTSIDE the chart card
  // (they are part of the heading row) and the chart is what gets replaced.
  (root.parentElement ?? root).addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-fp-metric], button[data-fp-period], button[data-fp-groupby]'
    );
    if (!button) return;

    const nextMetric = button.dataset.fpMetric as CurveMetric | undefined;
    if (nextMetric && CURVE_METRICS.includes(nextMetric)) metric = nextMetric;
    if (button.dataset.fpPeriod) period = button.dataset.fpPeriod as CurvePeriod;
    if (button.dataset.fpGroupby) groupBy = button.dataset.fpGroupby as CurveGroupBy;

    syncControls();
    void load();
  });
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

