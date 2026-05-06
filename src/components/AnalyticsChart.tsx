import type { FC } from 'hono/jsx';

// ═══════════════════════════════════════════════════════════════════════════
// ANALYTICS CHART - Flexible metric-aware chart with Chart.js
// Automatically switches between line/bar/dualBar based on selected metric
// ═══════════════════════════════════════════════════════════════════════════

interface AnalyticsChartProps {
  userId: string;
  defaultMetric?: 'tokens' | 'cost' | 'prompts' | 'lines' | 'commits';
  defaultPeriod?: '7d' | '30d' | '90d' | 'all';
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

export const AnalyticsChart: FC<AnalyticsChartProps> = ({
  defaultMetric = 'tokens',
  defaultPeriod = '30d',
}) => {
  return (
    <div class="analytics-chart-container">
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
              onclick={`selectMetric('${id}')`}
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
              onclick={`selectPeriod('${id}')`}
            >
              {label}
            </button>
          ))}
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
            Run <code class="text-cyan-500/70 bg-gray-900/50 px-1 rounded">clawd otel</code> to enable.
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
          <div class="text-gray-600 text-xs font-mono">avg/day</div>
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

      {/* Chart.js initialization script */}
      <script dangerouslySetInnerHTML={{
        __html: `
          (function() {
            // State
            let currentMetric = '${defaultMetric}';
            let currentPeriod = '${defaultPeriod}';
            let chartInstance = null;
            let hoverData = null;

            // Format numbers with K/M/B suffix
            function formatNumber(n) {
              if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
              if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
              if (n >= 1000) return Math.round(n / 1000) + 'K';
              return n.toString();
            }

            // Fetch chart data from API
            async function fetchChartData(metric, period) {
              try {
                const response = await fetch('/api/me/chart?metric=' + metric + '&period=' + period, {
                  credentials: 'include'
                });
                const data = await response.json();
                if (!response.ok) {
                  throw new Error(data.error || data.message || 'Failed to fetch');
                }
                return data;
              } catch (error) {
                console.error('Chart fetch error:', error);
                return { error: error.message };
              }
            }

            // Render the chart
            function renderChart(data) {
              const ctx = document.getElementById('analytics-chart');
              if (!ctx) return;

              // Hide loading
              const loading = document.getElementById('chart-loading');
              if (loading) loading.style.display = 'none';

              // Store hover data for tooltips
              hoverData = data.hover || null;

              // Destroy existing chart
              if (chartInstance) {
                chartInstance.destroy();
              }

              // Configure chart based on type
              let config;

              if (data.chartType === 'dualBar') {
                // Stacked bar for lines (added up, removed down)
                config = {
                  type: 'bar',
                  data: {
                    labels: data.labels,
                    datasets: data.datasets.map(ds => ({
                      label: ds.label,
                      data: ds.data,
                      backgroundColor: ds.color + '99',
                      borderColor: ds.color,
                      borderWidth: 1,
                      borderRadius: 2,
                    }))
                  },
                  options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    plugins: {
                      legend: { display: true, position: 'top', labels: { color: '#9ca3af', font: { family: 'JetBrains Mono', size: 10 } } },
                      tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        titleFont: { family: 'JetBrains Mono' },
                        bodyFont: { family: 'JetBrains Mono' },
                        borderColor: '#374151',
                        borderWidth: 1,
                        callbacks: {
                          label: function(context) {
                            const val = Math.abs(context.raw);
                            const prefix = context.raw >= 0 ? '+' : '-';
                            return context.dataset.label + ': ' + prefix + formatNumber(val);
                          }
                        }
                      }
                    },
                    scales: {
                      x: {
                        stacked: true,
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 9 } }
                      },
                      y: {
                        stacked: true,
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 9 }, callback: v => formatNumber(v) }
                      }
                    }
                  }
                };
              } else if (data.chartType === 'bar') {
                // Simple bar chart
                config = {
                  type: 'bar',
                  data: {
                    labels: data.labels,
                    datasets: data.datasets.map(ds => ({
                      label: ds.label,
                      data: ds.data,
                      backgroundColor: ds.color + '99',
                      borderColor: ds.color,
                      borderWidth: 1,
                      borderRadius: 3,
                    }))
                  },
                  options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    plugins: {
                      legend: { display: false },
                      tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        titleFont: { family: 'JetBrains Mono' },
                        bodyFont: { family: 'JetBrains Mono' },
                        borderColor: '#374151',
                        borderWidth: 1,
                      }
                    },
                    scales: {
                      x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 9 } } },
                      y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 9 }, callback: v => formatNumber(v) } }
                    }
                  }
                };
              } else {
                // Line chart with area fill
                config = {
                  type: 'line',
                  data: {
                    labels: data.labels,
                    datasets: data.datasets.map(ds => ({
                      label: ds.label,
                      data: ds.data,
                      borderColor: ds.color,
                      backgroundColor: ds.color + '20',
                      fill: true,
                      tension: 0.3,
                      pointRadius: 0,
                      pointHoverRadius: 5,
                      pointHoverBackgroundColor: ds.color,
                    }))
                  },
                  options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    plugins: {
                      legend: { display: false },
                      tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        titleFont: { family: 'JetBrains Mono' },
                        bodyFont: { family: 'JetBrains Mono' },
                        borderColor: '#374151',
                        borderWidth: 1,
                        callbacks: {
                          afterBody: function(context) {
                            if (!hoverData) return '';
                            const label = context[0].label;
                            const breakdown = hoverData[label];
                            if (!breakdown) return '';
                            return [
                              '',
                              'Input: ' + formatNumber(breakdown.input),
                              'Output: ' + formatNumber(breakdown.output),
                              'Cache Read: ' + formatNumber(breakdown.cacheRead),
                              'Cache Write: ' + formatNumber(breakdown.cacheWrite),
                            ];
                          }
                        }
                      }
                    },
                    scales: {
                      x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 9 } } },
                      y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 9 }, callback: v => formatNumber(v) } }
                    }
                  }
                };
              }

              chartInstance = new Chart(ctx, config);

              // Update summary
              updateSummary(data.summary);
            }

            // Update summary stats
            function updateSummary(summary) {
              document.getElementById('summary-total').textContent = formatNumber(summary.total);
              document.getElementById('summary-average').textContent = formatNumber(summary.average);
              document.getElementById('summary-peak').textContent = summary.peak ? summary.peak.date : '—';

              const trendEl = document.getElementById('summary-trend');
              trendEl.textContent = summary.trend;
              trendEl.className = 'text-xl font-bold font-mono ' +
                (summary.trend.startsWith('+') ? 'text-green-400' :
                 summary.trend.startsWith('-') ? 'text-red-400' : 'text-white');
            }

            // Select metric
            window.selectMetric = function(metric) {
              currentMetric = metric;
              updateControls();
              loadChart();
            };

            // Select period
            window.selectPeriod = function(period) {
              currentPeriod = period;
              updateControls();
              loadChart();
            };

            // Update control visual state
            function updateControls() {
              // Update metric pills
              document.querySelectorAll('.metric-pill').forEach(btn => {
                const isActive = btn.dataset.metric === currentMetric;
                btn.className = 'metric-pill px-3 py-1.5 rounded-full font-mono text-xs transition-all border ' +
                  (isActive
                    ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400'
                    : 'bg-gray-900/50 border-gray-800 text-gray-500 hover:text-gray-400 hover:border-gray-700');
              });

              // Update period tabs
              document.querySelectorAll('.period-tab').forEach(btn => {
                const isActive = btn.dataset.period === currentPeriod;
                btn.className = 'period-tab px-3 py-1 rounded font-mono text-xs transition-all ' +
                  (isActive ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-400');
              });
            }

            // Hide all overlays
            function hideAllOverlays() {
              const loading = document.getElementById('chart-loading');
              const otelRequired = document.getElementById('chart-otel-required');
              const noData = document.getElementById('chart-no-data');
              const canvas = document.getElementById('analytics-chart');

              if (loading) loading.style.display = 'none';
              if (otelRequired) otelRequired.classList.add('hidden');
              if (noData) noData.classList.add('hidden');
              if (canvas) canvas.style.display = 'block';
            }

            // Show OTEL required overlay
            function showOtelRequired(fallbackPeriod) {
              hideAllOverlays();
              const otelRequired = document.getElementById('chart-otel-required');
              const canvas = document.getElementById('analytics-chart');
              if (otelRequired) otelRequired.classList.remove('hidden');
              if (canvas) canvas.style.display = 'none';

              // Clear summary stats
              document.getElementById('summary-total').textContent = '—';
              document.getElementById('summary-average').textContent = '—';
              document.getElementById('summary-peak').textContent = '—';
              document.getElementById('summary-trend').textContent = '—';
              document.getElementById('summary-trend').className = 'text-xl font-bold font-mono text-white';
            }

            // Show no data overlay
            function showNoData() {
              hideAllOverlays();
              const noData = document.getElementById('chart-no-data');
              const canvas = document.getElementById('analytics-chart');
              if (noData) noData.classList.remove('hidden');
              if (canvas) canvas.style.display = 'none';

              // Clear summary stats
              document.getElementById('summary-total').textContent = '—';
              document.getElementById('summary-average').textContent = '—';
              document.getElementById('summary-peak').textContent = '—';
              document.getElementById('summary-trend').textContent = '—';
              document.getElementById('summary-trend').className = 'text-xl font-bold font-mono text-white';
            }

            // Load chart data
            async function loadChart() {
              const loading = document.getElementById('chart-loading');
              const canvas = document.getElementById('analytics-chart');

              // Show loading, hide overlays
              hideAllOverlays();
              if (loading) loading.style.display = 'flex';
              if (canvas) canvas.style.display = 'none';

              const data = await fetchChartData(currentMetric, currentPeriod);

              // Handle special responses
              if (data && data.noData) {
                if (data.reason === 'otel_required') {
                  showOtelRequired(data.fallbackPeriod || '7d');
                  return;
                }
                if (data.reason === 'no_data') {
                  showNoData();
                  return;
                }
              }

              // Handle normal chart data
              if (data && !data.error && data.labels) {
                hideAllOverlays();
                if (canvas) canvas.style.display = 'block';
                renderChart(data);
              } else {
                const errorMsg = data?.error || data?.message || 'Unknown error';
                if (loading) {
                  loading.style.display = 'flex';
                  loading.innerHTML = '<div class="text-red-400 font-mono text-sm">Error: ' + errorMsg + '</div>';
                }
              }
            }

            // Set up fallback button click handler
            document.getElementById('chart-fallback-btn')?.addEventListener('click', function() {
              selectPeriod('7d');
            });

            // Initial load
            loadChart();
          })();
        `
      }} />
    </div>
  );
};

export default AnalyticsChart;
