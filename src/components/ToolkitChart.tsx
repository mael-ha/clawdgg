import type { FC } from 'hono/jsx';
import type { ToolStats } from '../db/clickhouse';

// ═══════════════════════════════════════════════════════════════════════════
// TOOLKIT CHART - Horizontal stacked bar showing tool usage composition
// Matches TokenBar design pattern for consistency
// ═══════════════════════════════════════════════════════════════════════════

interface ToolkitChartProps {
  tools: ToolStats[];
}

// Tool color palette
const TOOL_COLORS: Record<string, string> = {
  Read: '#22d3ee',      // cyan
  Edit: '#22c55e',      // green
  Write: '#a855f7',     // purple
  Bash: '#f59e0b',      // amber
  Grep: '#ef4444',      // red
  Glob: '#ec4899',      // pink
  Task: '#3b82f6',      // blue
  WebFetch: '#14b8a6',  // teal
  WebSearch: '#8b5cf6', // violet
  default: '#6b7280',   // gray
};

function getToolColor(tool: string): string {
  return TOOL_COLORS[tool] ?? TOOL_COLORS.default;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

const MIN_WIDTH_PERCENT = 3;

export const ToolkitChart: FC<ToolkitChartProps> = ({ tools }) => {
  if (!tools || tools.length === 0) {
    return (
      <div class="text-gray-500 font-mono text-sm text-center py-8">
        No tool data yet — use Claude Code to see your toolkit
      </div>
    );
  }

  const totalCalls = tools.reduce((sum, t) => sum + t.totalCalls, 0);
  const topTool = tools[0];
  const overallSuccessRate = tools.reduce((sum, t) => sum + t.successCount, 0) / totalCalls * 100;

  // Take top 6 tools, group rest as "Other"
  const displayTools = tools.slice(0, 6);
  const otherCount = tools.slice(6).reduce((sum, t) => sum + t.totalCalls, 0);

  // Build segments
  const segments = displayTools.map(tool => ({
    name: tool.toolName,
    value: tool.totalCalls,
    color: getToolColor(tool.toolName),
    actualPercent: (tool.totalCalls / totalCalls) * 100,
    successRate: (tool.successCount / tool.totalCalls) * 100,
  }));

  if (otherCount > 0) {
    segments.push({
      name: 'Other',
      value: otherCount,
      color: TOOL_COLORS.default,
      actualPercent: (otherCount / totalCalls) * 100,
      successRate: 0,
    });
  }

  // Apply minimum width
  const smallSegments = segments.filter(s => s.actualPercent < MIN_WIDTH_PERCENT);
  const largeSegments = segments.filter(s => s.actualPercent >= MIN_WIDTH_PERCENT);
  const boostNeeded = smallSegments.reduce((sum, s) => sum + (MIN_WIDTH_PERCENT - s.actualPercent), 0);
  const largeTotal = largeSegments.reduce((sum, s) => sum + s.actualPercent, 0);
  const shrinkFactor = largeTotal > 0 ? (largeTotal - boostNeeded) / largeTotal : 1;

  const segmentsWithDisplay = segments.map(s => ({
    ...s,
    displayPercent: s.actualPercent < MIN_WIDTH_PERCENT
      ? MIN_WIDTH_PERCENT
      : s.actualPercent * shrinkFactor,
  }));

  return (
    <div class="space-y-3">
      {/* Header row: Total (left) + Top tool badge (right) */}
      <div class="flex items-center justify-between">
        <span class="text-white font-mono text-lg sm:text-xl font-bold">
          {formatNumber(totalCalls)} <span class="text-gray-500 text-sm font-normal">calls</span>
        </span>
        {topTool && (
          <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono"
               style={`background: ${getToolColor(topTool.toolName)}20; border: 1px solid ${getToolColor(topTool.toolName)}50;`}>
            <div class="w-2 h-2 rounded-full" style={`background: ${getToolColor(topTool.toolName)};`} />
            <span class="text-white font-bold">{topTool.toolName}</span>
            <span style={`color: ${getToolColor(topTool.toolName)};`}>{Math.round((topTool.totalCalls / totalCalls) * 100)}%</span>
          </div>
        )}
      </div>

      {/* The horizontal stacked bar */}
      <div class="h-4 sm:h-5 rounded-full overflow-hidden flex bg-gray-900/50 border border-gray-800/50">
        {segmentsWithDisplay.map((segment, index) => (
          <div
            key={segment.name}
            class="relative h-full transition-all duration-300 hover:brightness-125 group cursor-default"
            style={`
              width: ${segment.displayPercent}%;
              background: linear-gradient(180deg, ${segment.color}dd 0%, ${segment.color}99 100%);
              ${index === 0 ? 'border-radius: 9999px 0 0 9999px;' : ''}
              ${index === segmentsWithDisplay.length - 1 ? 'border-radius: 0 9999px 9999px 0;' : ''}
            `}
          >
            {/* Hover tooltip */}
            <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-20">
              <div class="text-white font-mono text-sm font-bold">{segment.name}</div>
              <div class="text-gray-400 text-xs">{formatNumber(segment.value)} calls ({segment.actualPercent.toFixed(1)}%)</div>
              {segment.successRate > 0 && (
                <div class="text-green-400 text-xs">{Math.round(segment.successRate)}% success</div>
              )}
              <div class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-700" />
            </div>
          </div>
        ))}
      </div>

      {/* Legend - grid layout */}
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
        {segmentsWithDisplay.map((segment) => (
          <div key={segment.name} class="flex items-center gap-2">
            <div
              class="w-2 h-2 rounded-full flex-shrink-0"
              style={`background-color: ${segment.color}; box-shadow: 0 0 6px ${segment.color}66;`}
            />
            <span class="text-gray-400 text-xs font-mono truncate">{segment.name}</span>
            <span class="text-white text-xs font-mono">{formatNumber(segment.value)}</span>
            <span class="text-gray-600 text-xs">({Math.round(segment.actualPercent)}%)</span>
          </div>
        ))}
      </div>

      {/* Footer with success rate */}
      <div class="pt-2 border-t border-gray-800/30 flex items-center justify-between">
        <p class="text-gray-600 text-xs font-mono">
          Claude's interactions with your codebase
        </p>
        <div class="flex items-center gap-1.5">
          <span class="text-gray-500 text-xs font-mono">Success:</span>
          <span class="text-green-400 text-xs font-mono font-bold">{overallSuccessRate.toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
};

export default ToolkitChart;
