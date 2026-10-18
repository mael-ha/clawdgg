import type { FC } from 'hono/jsx';

// ═══════════════════════════════════════════════════════════════════════════
// ANALYTICS CHART - Flexible metric-aware chart with Chart.js
// Automatically switches between line/bar/dualBar based on selected metric
//
// Markup only. The behaviour lives in src/client/analytics-chart.ts, which the
// page loads as a module; this component's job is to hand it the defaults via
// data attributes and the ids it binds to.
// ═══════════════════════════════════════════════════════════════════════════

interface AnalyticsChartProps {
  userId: string;
  defaultMetric?: 'tokens' | 'cost' | 'prompts' | 'lines' | 'commits';
  defaultPeriod?: '7d' | '30d' | '90d' | 'all';
  defaultGroupBy?: 'day' | 'week' | 'month';
}

// Metric configuration
const METRICS = [
  { id: 'tokens', label: 'Tokens', icon: '🔤' },
  { id: 'cost', label: 'Cost', icon: '💰' },
  { id: 'prompts', label: 'Prompts', icon: '💬' },
  { id: 'lines', label: 'Lines', icon: '📝' },
  { id: 'commits', label: 'Commits', icon: '📦' },
] as const;

const PERIODS = [
  { id: '1d', label: 'Today' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'all', label: '∞' },
] as const;

// Bucket granularity — ignored for "Today", which is always hourly
const GROUP_BYS = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
] as const;

export const AnalyticsChart: FC<AnalyticsChartProps> = ({
  defaultMetric = 'tokens',
  defaultPeriod = '30d',
  defaultGroupBy = 'day',
}) => {
  return (
    <div
      id="analytics-chart-root"
      class="analytics-chart-container"
      data-metric={defaultMetric}
      data-period={defaultPeriod}
      data-groupby={defaultGroupBy}
    >
      {/* Controls */}
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        {/* Metric selector pills */}
        <div class="flex flex-wrap gap-2" id="metric-selector">
          {METRICS.map(({ id, label }) => (
            <button
              key={id}
              data-metric={id}
              class={`metric-pill px-3 py-1.5 rounded-full font-mono text-xs transition-all border ${
                id === defaultMetric
                  ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400'
                  : 'bg-gray-900/50 border-gray-800 text-gray-500 hover:text-gray-400 hover:border-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div class="flex flex-wrap items-center gap-2">
          {/* Granularity tabs */}
          <div class="flex gap-1 bg-gray-900/50 p-1 rounded-lg border border-gray-800" id="groupby-selector">
            {GROUP_BYS.map(({ id, label }) => (
              <button
                key={id}
                data-groupby={id}
                class={`groupby-tab px-3 py-1 rounded font-mono text-xs transition-all ${
                  id === defaultGroupBy
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-500 hover:text-gray-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Period selector tabs */}
          <div class="flex gap-1 bg-gray-900/50 p-1 rounded-lg border border-gray-800" id="period-selector">
            {PERIODS.map(({ id, label }) => (
              <button
                key={id}
                data-period={id}
                class={`period-tab px-3 py-1 rounded font-mono text-xs transition-all ${
                  id === defaultPeriod
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-500 hover:text-gray-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart container */}
      <div class="relative h-64 bg-gray-950/50 border border-gray-800/50 rounded-xl p-4">
        {/* Loading indicator */}
        <div id="chart-loading" class="absolute inset-0 flex items-center justify-center">
          <div class="flex items-center gap-2 text-gray-500">
            <span class="animate-spin">⟳</span>
            <span class="font-mono text-sm">Loading chart...</span>
          </div>
        </div>

        {/* OTEL Required overlay (hidden by default) */}
        <div id="chart-otel-required" class="absolute inset-0 flex flex-col items-center justify-center text-center p-6 hidden">
          <div class="text-cyan-500/50 text-2xl mb-2">◇</div>
          <div class="text-gray-400 font-mono text-sm mb-1">OTEL Required</div>
          <div class="text-gray-600 font-mono text-xs max-w-xs mb-4">
            Hourly breakdown needs real-time telemetry.<br/>
            Run <code class="text-cyan-500/70 bg-gray-900/50 px-1 rounded">clawdgg otel</code> to enable.
          </div>
          <button
            id="chart-fallback-btn"
            class="text-cyan-500 hover:text-cyan-400 font-mono text-xs border border-cyan-500/30 hover:border-cyan-500/50 px-3 py-1.5 rounded transition-all"
          >
            View 7d instead →
          </button>
        </div>

        {/* No data overlay (hidden by default) */}
        <div id="chart-no-data" class="absolute inset-0 flex flex-col items-center justify-center text-center p-6 hidden">
          <div class="text-gray-600 text-2xl mb-2">○</div>
          <div class="text-gray-500 font-mono text-sm">No data available</div>
          <div class="text-gray-600 font-mono text-xs mt-1">Try a different time period</div>
        </div>

        {/* Canvas for Chart.js */}
        <canvas id="analytics-chart" class="w-full h-full"></canvas>
      </div>

      {/* Summary stats */}
      <div id="chart-summary" class="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t border-gray-800/50">
        <div class="text-center">
          <div id="summary-total" class="text-xl font-bold text-white font-mono">—</div>
          <div class="text-gray-600 text-xs font-mono">total</div>
        </div>
        <div class="text-center">
          <div id="summary-average" class="text-xl font-bold text-white font-mono">—</div>
          <div id="summary-average-label" class="text-gray-600 text-xs font-mono">avg/{defaultGroupBy}</div>
        </div>
        <div class="text-center">
          <div id="summary-peak" class="text-xl font-bold text-white font-mono">—</div>
          <div class="text-gray-600 text-xs font-mono">peak</div>
        </div>
        <div class="text-center">
          <div id="summary-trend" class="text-xl font-bold text-white font-mono">—</div>
          <div class="text-gray-600 text-xs font-mono">trend</div>
        </div>
      </div>
    </div>
  );
};

export default AnalyticsChart;
