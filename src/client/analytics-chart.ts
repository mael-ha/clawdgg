/**
 * Analytics chart — the metric/granularity/period explorer on your own profile.
 *
 * Was ~360 lines of untyped string inside a .tsx `dangerouslySetInnerHTML`,
 * talking to the page through three `window.select*` globals. Now it is a
 * module: the response is typed against the server's own ChartData (a type-only
 * import, erased at build), controls are read from data attributes, and nothing
 * is attached to window.
 *
 * chart.js is imported, not CDN'd, and only the pieces this chart draws are
 * registered — which is also why the bundle ships only on pages that render it.
 */

import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { ChartData } from '../db/clickhouse';
import { formatTokens } from '../lib/format';

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
);

type Metric = 'tokens' | 'cost' | 'prompts' | 'lines' | 'commits';
type Period = '1d' | '7d' | '30d' | '90d' | 'all';
type GroupBy = 'day' | 'week' | 'month';

interface NoDataResponse {
  noData: true;
  reason: 'otel_required' | 'no_data';
  message?: string;
  fallbackPeriod?: Period;
}

type ChartResponse = ChartData | NoDataResponse | { error: string };

const MONO = { family: 'JetBrains Mono' } as const;
const AXIS = { color: '#6b7280', font: { family: 'JetBrains Mono', size: 9 } } as const;
const GRID = { color: 'rgba(255,255,255,0.05)' } as const;
const TOOLTIP_BOX = {
  backgroundColor: 'rgba(0, 0, 0, 0.9)',
  titleFont: MONO,
  bodyFont: MONO,
  borderColor: '#374151',
  borderWidth: 1,
} as const;

const root = document.getElementById('analytics-chart-root');
const canvas = document.getElementById('analytics-chart') as HTMLCanvasElement | null;

if (root && canvas) {
  let metric = (root.dataset.metric || 'tokens') as Metric;
  let period = (root.dataset.period || '30d') as Period;
  let groupBy = (root.dataset.groupby || 'day') as GroupBy;
  let chart: Chart | null = null;
  let hoverData: ChartData['hover'];

  const el = (id: string) => document.getElementById(id);

  // "Today" is always hourly — groupBy is ignored server-side
  const effectiveGroupBy = () => (period === '1d' ? 'hour' : groupBy);

  async function fetchChartData(): Promise<ChartResponse> {
    try {
      const params = new URLSearchParams({ metric, period, groupBy });
      const response = await fetch(`/api/me/chart?${params}`, { credentials: 'include' });
      const data = (await response.json()) as ChartResponse & { message?: string };
      if (!response.ok) {
        throw new Error(('error' in data && data.error) || data.message || 'Failed to fetch');
      }
      return data;
    } catch (error) {
      console.error('Chart fetch error:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  function buildConfig(data: ChartData): ChartConfiguration {
    if (data.chartType === 'dualBar') {
      // Stacked bar for lines (added up, removed down)
      return {
        type: 'bar',
        data: {
          labels: data.labels,
          datasets: data.datasets.map((ds) => ({
            label: ds.label,
            data: ds.data,
            backgroundColor: `${ds.color}99`,
            borderColor: ds.color,
            borderWidth: 1,
            borderRadius: 2,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: true, position: 'top', labels: { color: '#9ca3af', font: { family: 'JetBrains Mono', size: 10 } } },
            tooltip: {
              ...TOOLTIP_BOX,
              callbacks: {
                label: (context) => {
                  const raw = context.raw as number;
                  return `${context.dataset.label}: ${raw >= 0 ? '+' : '-'}${formatTokens(Math.abs(raw))}`;
                },
              },
            },
          },
          scales: {
            x: { stacked: true, grid: GRID, ticks: AXIS },
            y: { stacked: true, grid: GRID, ticks: { ...AXIS, callback: (v) => formatTokens(Number(v)) } },
          },
        },
      };
    }

    if (data.chartType === 'bar') {
      return {
        type: 'bar',
        data: {
          labels: data.labels,
          datasets: data.datasets.map((ds) => ({
            label: ds.label,
            data: ds.data,
            backgroundColor: `${ds.color}99`,
            borderColor: ds.color,
            borderWidth: 1,
            borderRadius: 3,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { display: false }, tooltip: TOOLTIP_BOX },
          scales: {
            x: { grid: GRID, ticks: AXIS },
            y: { grid: GRID, ticks: { ...AXIS, callback: (v) => formatTokens(Number(v)) } },
          },
        },
      };
    }

    // Line chart with area fill
    return {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: data.datasets.map((ds) => ({
          label: ds.label,
          data: ds.data,
          borderColor: ds.color,
          backgroundColor: `${ds.color}20`,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: ds.color,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...TOOLTIP_BOX,
            callbacks: {
              afterBody: (context) => {
                const breakdown = hoverData?.[context[0]?.label ?? ''];
                if (!breakdown) return '';
                return [
                  '',
                  `Input: ${formatTokens(breakdown.input ?? 0)}`,
                  `Output: ${formatTokens(breakdown.output ?? 0)}`,
                  `Cache Read: ${formatTokens(breakdown.cacheRead ?? 0)}`,
                  `Cache Write: ${formatTokens(breakdown.cacheWrite ?? 0)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { grid: GRID, ticks: AXIS },
          y: { grid: GRID, ticks: { ...AXIS, callback: (v) => formatTokens(Number(v)) } },
        },
      },
    };
  }

  function renderChart(data: ChartData) {
    hoverData = data.hover;
    chart?.destroy();
    chart = new Chart(canvas!, buildConfig(data));
    updateSummary(data.summary);
  }

  function updateSummary(summary: ChartData['summary']) {
    setText('summary-total', formatTokens(summary.total));
    setText('summary-average', formatTokens(summary.average));
    setText('summary-average-label', `avg/${effectiveGroupBy()}`);
    setText('summary-peak', summary.peak ? summary.peak.date : '—');

    const trend = el('summary-trend');
    if (!trend) return;
    trend.textContent = summary.trend;
    trend.className = `text-xl font-bold font-mono ${
      summary.trend.startsWith('+') ? 'text-green-400' : summary.trend.startsWith('-') ? 'text-red-400' : 'text-white'
    }`;
  }

  function clearSummary() {
    for (const id of ['summary-total', 'summary-average', 'summary-peak', 'summary-trend']) setText(id, '—');
    const trend = el('summary-trend');
    if (trend) trend.className = 'text-xl font-bold font-mono text-white';
  }

  function setText(id: string, text: string) {
    const node = el(id);
    if (node) node.textContent = text;
  }

  function updateControls() {
    for (const btn of document.querySelectorAll<HTMLElement>('.metric-pill')) {
      const active = btn.dataset.metric === metric;
      btn.className = `metric-pill px-3 py-1.5 rounded-full font-mono text-xs transition-all border ${
        active
          ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400'
          : 'bg-gray-900/50 border-gray-800 text-gray-500 hover:text-gray-400 hover:border-gray-700'
      }`;
    }

    for (const btn of document.querySelectorAll<HTMLElement>('.period-tab')) {
      const active = btn.dataset.period === period;
      btn.className = `period-tab px-3 py-1 rounded font-mono text-xs transition-all ${
        active ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-400'
      }`;
    }

    // Granularity tabs — dimmed while "Today" forces hourly
    const groupByIgnored = period === '1d';
    for (const btn of document.querySelectorAll<HTMLElement>('.groupby-tab')) {
      const active = !groupByIgnored && btn.dataset.groupby === groupBy;
      btn.className =
        `groupby-tab px-3 py-1 rounded font-mono text-xs transition-all ${
          active ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-400'
        }` + (groupByIgnored ? ' opacity-40' : '');
    }
  }

  function showOverlay(which: 'loading' | 'otel' | 'no-data' | 'chart') {
    const loading = el('chart-loading');
    if (loading) loading.style.display = which === 'loading' ? 'flex' : 'none';
    el('chart-otel-required')?.classList.toggle('hidden', which !== 'otel');
    el('chart-no-data')?.classList.toggle('hidden', which !== 'no-data');
    canvas!.style.display = which === 'chart' ? 'block' : 'none';
  }

  async function loadChart() {
    showOverlay('loading');

    const data = await fetchChartData();

    if ('noData' in data) {
      showOverlay(data.reason === 'otel_required' ? 'otel' : 'no-data');
      clearSummary();
      return;
    }

    if ('error' in data) {
      const loading = el('chart-loading');
      if (loading) {
        loading.style.display = 'flex';
        loading.textContent = `Error: ${data.error}`;
        loading.className = 'absolute inset-0 flex items-center justify-center text-red-400 font-mono text-sm';
      }
      return;
    }

    showOverlay('chart');
    renderChart(data);
  }

  function select(next: { metric?: Metric; period?: Period; groupBy?: GroupBy }) {
    if (next.metric) metric = next.metric;
    if (next.period) period = next.period;
    if (next.groupBy) groupBy = next.groupBy;
    updateControls();
    void loadChart();
  }

  root.addEventListener('click', (event) => {
    // `button[...]` on purpose: the root div carries the same data attributes
    // as its defaults, and would otherwise match every stray click.
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      'button[data-metric], button[data-period], button[data-groupby]',
    );
    if (!button) return;
    if (button.dataset.metric) select({ metric: button.dataset.metric as Metric });
    else if (button.dataset.period) select({ period: button.dataset.period as Period });
    else if (button.dataset.groupby) select({ groupBy: button.dataset.groupby as GroupBy });
  });

  el('chart-fallback-btn')?.addEventListener('click', () => select({ period: '7d' }));

  void loadChart();
}
