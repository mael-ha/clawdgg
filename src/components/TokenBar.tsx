import type { FC } from 'hono/jsx';
import { formatTokens } from '../lib/format';

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN BAR - Horizontal stacked bar visualization of token composition
// Bar shows total + efficiency badge centered
// Footer explains what Cache/I/O mean
// ═══════════════════════════════════════════════════════════════════════════

interface TokenBarProps {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Token segments in display order
const TOKEN_CONFIG = [
  { key: 'cacheRead', label: 'Cache Read', color: '#22d3ee' },
  { key: 'cacheWrite', label: 'Cache Write', color: '#f59e0b' },
  { key: 'input', label: 'Input', color: '#22c55e' },
  { key: 'output', label: 'Output', color: '#a855f7' },
] as const;

const MIN_WIDTH_PERCENT = 2;

export const TokenBar: FC<TokenBarProps> = ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
}) => {
  const tokens: Record<string, number> = {
    cacheRead: cacheReadTokens,
    cacheWrite: cacheCreationTokens,
    input: inputTokens,
    output: outputTokens,
  };

  const total = Object.values(tokens).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  // Calculate totals
  const cacheTotal = cacheReadTokens + cacheCreationTokens;
  const ioTotal = inputTokens + outputTokens;
  const cachePercent = Math.round((cacheTotal / total) * 100);

  // Calculate actual percentages
  const segments = TOKEN_CONFIG
    .map(config => ({
      ...config,
      value: tokens[config.key] || 0,
      actualPercent: ((tokens[config.key] || 0) / total) * 100,
    }))
    .filter(s => s.value > 0);

  // Apply minimum width while preserving relative proportions
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
      {/* Header row: Total (left) + Badge (right) */}
      <div class="flex items-center justify-between">
        <span class="text-white font-mono text-lg sm:text-xl font-bold">
          {formatTokens(total)} <span class="text-gray-500 text-sm font-normal">tokens</span>
        </span>
        <div class="flex items-center gap-1.5 px-2.5 py-1 bg-cyan-500/10 border border-cyan-500/30 rounded-full text-xs font-mono">
          <span class="text-gray-400">I/O:</span>
          <span class="text-white font-bold">{formatTokens(ioTotal)}</span>
          <span class="text-gray-600">·</span>
          <span class="text-cyan-400">{cachePercent}% cached</span>
        </div>
      </div>

      {/* The horizontal stacked bar - clean, no overlay */}
      <div class="h-4 sm:h-5 rounded-full overflow-hidden flex bg-gray-900/50 border border-gray-800/50"
           style="box-shadow: 0 0 20px rgba(34, 211, 238, 0.08);">
        {segmentsWithDisplay.map((segment, index) => (
          <div
            key={segment.key}
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
              <div class="text-white font-mono text-sm font-bold">{formatTokens(segment.value)}</div>
              <div class="text-gray-400 text-xs">{segment.label} ({segment.actualPercent.toFixed(1)}%)</div>
              <div class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-700" />
            </div>
          </div>
        ))}
      </div>

      {/* Legend - two columns */}
      <div class="grid grid-cols-2 gap-x-6 gap-y-2">
        {segmentsWithDisplay.map((segment) => (
          <div key={segment.key} class="flex items-center gap-2">
            <div
              class="w-2 h-2 rounded-full flex-shrink-0"
              style={`background-color: ${segment.color}; box-shadow: 0 0 6px ${segment.color}88;`}
            />
            <span class="text-gray-400 text-xs font-mono">{segment.label}</span>
            <span class="text-white text-xs font-mono">{formatTokens(segment.value)}</span>
            <span class="text-gray-600 text-xs">({segment.actualPercent.toFixed(segment.actualPercent < 1 ? 1 : 0)}%)</span>
          </div>
        ))}
      </div>

      {/* Footer hint - explains Cache vs I/O */}
      <div class="pt-2 border-t border-gray-800/30">
        <p class="text-gray-600 text-xs font-mono text-center">
          <span class="text-gray-500">Cache</span> = context reused across turns · <span class="text-gray-500">I/O</span> = your prompts + Claude's responses
        </p>
      </div>
    </div>
  );
};

export default TokenBar;
