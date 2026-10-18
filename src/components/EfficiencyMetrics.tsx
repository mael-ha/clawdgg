import type { FC } from 'hono/jsx';
import type { AgenticStats, CacheStats } from '../db/clickhouse';

// ═══════════════════════════════════════════════════════════════════════════
// EFFICIENCY METRICS - Consolidated efficiency insights
// Shows agentic intensity, cache efficiency, output leverage, cost per line
// ═══════════════════════════════════════════════════════════════════════════

interface EfficiencyMetricsProps {
  agenticStats: AgenticStats | null;
  cacheStats: CacheStats | null;
  totalOutputTokens: number;
  totalInputTokens: number;
  totalLinesAdded: number;
  totalCostUsd: number;
}

// Generate insight based on metrics
function generateInsight(
  agenticStats: AgenticStats | null,
  cacheStats: CacheStats | null
): string | null {
  if (agenticStats && agenticStats.agenticRatio > 15) {
    return `Each prompt triggers ${Math.round(agenticStats.agenticRatio)} API calls — you're highly agentic`;
  }
  if (cacheStats && cacheStats.cacheHitRate > 80) {
    return `${Math.round(cacheStats.cacheHitRate)}% cache hit rate — excellent context reuse`;
  }
  if (agenticStats && agenticStats.agenticRatio > 5) {
    return `${Math.round(agenticStats.agenticRatio)}× API calls per prompt — Claude works hard for you`;
  }
  return null;
}

export const EfficiencyMetrics: FC<EfficiencyMetricsProps> = ({
  agenticStats,
  cacheStats,
  totalOutputTokens,
  totalInputTokens,
  totalLinesAdded,
  totalCostUsd,
}) => {
  // Calculate metrics
  const agenticRatio = agenticStats?.agenticRatio || 0;
  const cacheHitRate = cacheStats?.cacheHitRate || 0;
  const outputLeverage = totalInputTokens > 0
    ? totalOutputTokens / totalInputTokens
    : 0;
  const costPerLine = totalLinesAdded > 0
    ? totalCostUsd / totalLinesAdded
    : 0;

  const insight = generateInsight(agenticStats, cacheStats);

  const metrics = [
    {
      value: agenticRatio > 0 ? `${Math.round(agenticRatio)}×` : '—',
      label: 'agentic',
      sublabel: 'API/prompt',
      color: 'text-purple-400',
    },
    {
      value: cacheHitRate > 0 ? `${Math.round(cacheHitRate)}%` : '—',
      label: 'cache',
      sublabel: 'hit rate',
      color: 'text-cyan-400',
    },
    {
      value: outputLeverage > 0 ? `${Math.round(outputLeverage)}×` : '—',
      label: 'output',
      sublabel: 'leverage',
      color: 'text-green-400',
    },
    {
      value: costPerLine > 0 ? `$${costPerLine.toFixed(2)}` : '—',
      label: 'per line',
      sublabel: '',
      color: 'text-yellow-400',
    },
  ];

  return (
    <div class="p-5 bg-gray-900/50 border border-gray-800 rounded-xl">
      {/* Header */}
      <div class="mb-4">
        <h3 class="text-gray-400 font-mono text-xs uppercase tracking-wider">
          Efficiency
        </h3>
      </div>

      {/* Metrics grid */}
      <div class="grid grid-cols-2 gap-4">
        {metrics.map((metric, index) => (
          <div key={index} class="text-center p-3 bg-gray-950/50 rounded-lg border border-gray-800/50">
            <div class={`font-mono text-xl font-bold ${metric.color}`}>
              {metric.value}
            </div>
            <div class="text-gray-500 font-mono text-xs mt-1">
              {metric.label}
            </div>
            {metric.sublabel && (
              <div class="text-gray-600 font-mono text-[10px]">
                {metric.sublabel}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Insight */}
      {insight && (
        <div class="mt-4 pt-4 border-t border-gray-800">
          <div class="flex items-start gap-2">
            <span class="text-cyan-500 text-sm">💡</span>
            <span class="text-gray-400 text-sm">{insight}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default EfficiencyMetrics;
