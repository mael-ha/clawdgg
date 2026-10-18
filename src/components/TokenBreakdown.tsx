import type { FC } from 'hono/jsx';
import { formatTokens } from '../lib/format';

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN BREAKDOWN - SVG visualization of 4 token types
// Uses log scale when there's extreme disparity (e.g., 2B cache vs 150K input)
// ═══════════════════════════════════════════════════════════════════════════

interface TokenBreakdownProps {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Get log-scale width (handles extreme disparities)
function getLogWidth(value: number, max: number): number {
  if (value === 0 || max === 0) return 0;
  // Log scale: log(value+1) / log(max+1) * 100
  return (Math.log10(value + 1) / Math.log10(max + 1)) * 100;
}

// Get linear width
function getLinearWidth(value: number, max: number): number {
  if (value === 0 || max === 0) return 0;
  return (value / max) * 100;
}

// Token type configuration
const TOKEN_TYPES = [
  { key: 'cacheRead', label: 'Cache Reads', color: '#22d3ee', description: '(reused context)' },
  { key: 'output', label: 'Output', color: '#a855f7', description: '(Claude\'s responses)' },
  { key: 'cacheCreation', label: 'Cache Write', color: '#f59e0b', description: '(new context)' },
  { key: 'input', label: 'Input', color: '#22c55e', description: '(your prompts)' },
] as const;

export const TokenBreakdown: FC<TokenBreakdownProps> = ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
}) => {
  const tokens = {
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheCreation: cacheCreationTokens,
  };

  const values = Object.values(tokens).filter(v => v > 0);
  if (values.length === 0) return null;

  const max = Math.max(...values);
  const min = Math.min(...values);

  // Use log scale if disparity > 50x
  const useLogScale = max / min > 50;
  const getWidth = useLogScale ? getLogWidth : getLinearWidth;

  // Calculate total
  const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  // Generate insight based on token composition
  let insight = '';
  if (cacheReadTokens > 0) {
    const cacheRatio = cacheReadTokens / (inputTokens + cacheCreationTokens);
    if (cacheRatio >= 100) {
      insight = `Your cache reads (${formatTokens(cacheReadTokens)}) are ${Math.round(cacheRatio)}x your fresh input — extremely efficient context reuse.`;
    } else if (cacheRatio >= 10) {
      insight = `Cache reads are ${Math.round(cacheRatio)}x your input — you're efficiently reusing context.`;
    }
  }
  if (!insight && outputTokens > inputTokens * 10) {
    insight = `Claude writes ${Math.round(outputTokens / inputTokens)}x more than you type — high output leverage.`;
  }

  return (
    <div class="space-y-4">
      {/* Bar chart */}
      <div class="space-y-3">
        {TOKEN_TYPES.map(({ key, label, color, description }) => {
          const value = tokens[key];
          if (value === 0) return null;
          const width = getWidth(value, max);
          const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0';

          return (
            <div key={key} class="group">
              <div class="flex items-center justify-between text-sm mb-1">
                <div class="flex items-center gap-2">
                  <div class="w-3 h-3 rounded-xs" style={`background-color: ${color}`} />
                  <span class="text-gray-400">{label}</span>
                  <span class="text-gray-600 text-xs">{description}</span>
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-gray-500 text-xs">{percentage}%</span>
                  <span class="text-gray-100 font-mono">{formatTokens(value)}</span>
                </div>
              </div>
              <div class="h-4 bg-gray-900 rounded overflow-hidden">
                <div
                  class="h-full rounded transition-all duration-500"
                  style={`width: ${Math.max(width, 2)}%; background-color: ${color}; opacity: 0.8;`}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Scale indicator */}
      {useLogScale && (
        <div class="text-xs text-gray-600 text-right">
          * logarithmic scale (values span multiple orders of magnitude)
        </div>
      )}

      {/* Insight */}
      {insight && (
        <div class="mt-4 p-3 bg-gray-900/50 border border-gray-800 rounded-lg">
          <p class="text-sm text-gray-400">
            <span class="text-cyan-400">Insight:</span> {insight}
          </p>
        </div>
      )}

      {/* Summary stats */}
      <div class="grid grid-cols-3 gap-4 pt-4 border-t border-gray-800">
        <div class="text-center">
          <div class="text-lg font-mono text-gray-100">{formatTokens(total)}</div>
          <div class="text-xs text-gray-500">total tokens</div>
        </div>
        <div class="text-center">
          <div class="text-lg font-mono text-gray-100">
            {inputTokens > 0 ? `${Math.round(outputTokens / inputTokens)}x` : '—'}
          </div>
          <div class="text-xs text-gray-500">output leverage</div>
        </div>
        <div class="text-center">
          <div class="text-lg font-mono text-gray-100">
            {(inputTokens + cacheCreationTokens) > 0
              ? `${Math.round((cacheReadTokens / (inputTokens + cacheCreationTokens)) * 100)}%`
              : '—'}
          </div>
          <div class="text-xs text-gray-500">cache efficiency</div>
        </div>
      </div>
    </div>
  );
};

export default TokenBreakdown;
