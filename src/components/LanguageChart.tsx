import type { FC } from 'hono/jsx';
import type { LanguageStats } from '../db/clickhouse';

// ═══════════════════════════════════════════════════════════════════════════
// LANGUAGE CHART - Horizontal stacked bar showing language composition
// Matches TokenBar design pattern for consistency
// ═══════════════════════════════════════════════════════════════════════════

interface LanguageChartProps {
  languages: LanguageStats[];
}

// Language color palette (matches common IDE themes)
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f7df1e',
  Python: '#3776ab',
  Rust: '#dea584',
  Go: '#00add8',
  Java: '#b07219',
  Ruby: '#cc342d',
  PHP: '#777bb4',
  Swift: '#f05138',
  Kotlin: '#a97bff',
  Markdown: '#083fa1',
  JSON: '#6b7280',
  YAML: '#cb171e',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Shell: '#89e051',
  SQL: '#e38c00',
  default: '#6b7280',
};

function getLanguageColor(language: string): string {
  return LANGUAGE_COLORS[language] ?? LANGUAGE_COLORS.default;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

const MIN_WIDTH_PERCENT = 3; // Minimum visual width for visibility

export const LanguageChart: FC<LanguageChartProps> = ({ languages }) => {
  if (!languages || languages.length === 0) {
    return (
      <div class="text-gray-500 font-mono text-sm text-center py-8">
        No language data yet — edit some code with Claude
      </div>
    );
  }

  const totalEdits = languages.reduce((sum, l) => sum + l.editCount, 0);
  const topLanguage = languages[0];

  // Take top 6 languages, group rest as "Other"
  const displayLanguages = languages.slice(0, 6);
  const otherCount = languages.slice(6).reduce((sum, l) => sum + l.editCount, 0);

  // Apply minimum width while preserving relative proportions
  const segments = displayLanguages.map(lang => ({
    name: lang.language,
    value: lang.editCount,
    color: getLanguageColor(lang.language),
    actualPercent: lang.percentage,
    acceptRate: lang.acceptRate,
  }));

  if (otherCount > 0) {
    segments.push({
      name: 'Other',
      value: otherCount,
      color: LANGUAGE_COLORS.default,
      actualPercent: (otherCount / totalEdits) * 100,
      acceptRate: 0,
    });
  }

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
      {/* Header row: Total (left) + Top language badge (right) */}
      <div class="flex items-center justify-between">
        <span class="text-white font-mono text-lg sm:text-xl font-bold">
          {formatNumber(totalEdits)} <span class="text-gray-500 text-sm font-normal">edits</span>
        </span>
        {topLanguage && (
          <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono"
               style={`background: ${getLanguageColor(topLanguage.language)}20; border: 1px solid ${getLanguageColor(topLanguage.language)}50;`}>
            <div class="w-2 h-2 rounded-full" style={`background: ${getLanguageColor(topLanguage.language)};`} />
            <span class="text-white font-bold">{topLanguage.language}</span>
            <span style={`color: ${getLanguageColor(topLanguage.language)};`}>{Math.round(topLanguage.percentage)}%</span>
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
              <div class="text-gray-400 text-xs">{formatNumber(segment.value)} edits ({segment.actualPercent.toFixed(1)}%)</div>
              {segment.acceptRate > 0 && (
                <div class="text-green-400 text-xs">{Math.round(segment.acceptRate)}% accepted</div>
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

      {/* Footer hint */}
      <div class="pt-2 border-t border-gray-800/30">
        <p class="text-gray-600 text-xs font-mono text-center">
          Languages detected from {formatNumber(totalEdits)} code edits
        </p>
      </div>
    </div>
  );
};

export default LanguageChart;
