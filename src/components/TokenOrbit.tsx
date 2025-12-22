import type { FC } from 'hono/jsx';

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN ORBIT - Radial visualization of token flow
// Concentric rings show the massive disparity between cache reads and input
// Inspired by spacecraft instrumentation and radar displays
// ═══════════════════════════════════════════════════════════════════════════

interface TokenOrbitProps {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toString();
}

// Token type configuration with orbital properties
const TOKEN_CONFIG = {
  cacheRead: {
    label: 'CACHE_READ',
    color: '#22d3ee',
    glowColor: 'rgba(34, 211, 238, 0.4)',
    description: 'Context reused'
  },
  cacheCreation: {
    label: 'CACHE_WRITE',
    color: '#f59e0b',
    glowColor: 'rgba(245, 158, 11, 0.4)',
    description: 'New context'
  },
  output: {
    label: 'OUTPUT',
    color: '#a855f7',
    glowColor: 'rgba(168, 85, 247, 0.4)',
    description: 'Claude responses'
  },
  input: {
    label: 'INPUT',
    color: '#22c55e',
    glowColor: 'rgba(34, 197, 94, 0.4)',
    description: 'Your prompts'
  },
} as const;

export const TokenOrbit: FC<TokenOrbitProps> = ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
}) => {
  const tokens = {
    cacheRead: cacheReadTokens,
    cacheCreation: cacheCreationTokens,
    output: outputTokens,
    input: inputTokens,
  };

  const total = Object.values(tokens).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  // Sort by size for proper layering (largest = outermost ring)
  const sorted = Object.entries(tokens)
    .filter(([_, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]) as [keyof typeof TOKEN_CONFIG, number][];

  // Calculate ring sizes (logarithmic for extreme disparity)
  const maxValue = Math.max(...Object.values(tokens));
  const getRadius = (value: number, index: number) => {
    // Base radius + log-scaled addition
    const logScale = Math.log10(value + 1) / Math.log10(maxValue + 1);
    return 30 + (index * 25) + (logScale * 20);
  };

  // SVG dimensions
  const size = 280;
  const center = size / 2;

  // Calculate insight
  const cacheRatio = cacheReadTokens / (inputTokens + cacheCreationTokens || 1);
  const insight = cacheRatio >= 10
    ? `${Math.round(cacheRatio)}× context reuse`
    : `${Math.round((cacheReadTokens / total) * 100)}% cached`;

  return (
    <div class="relative">
      {/* Main orbital display */}
      <div class="flex items-start gap-8">
        {/* SVG Orbit visualization */}
        <div class="relative flex-shrink-0">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            class="orbit-container"
          >
            {/* Definitions for glow effects */}
            <defs>
              {sorted.map(([key]) => (
                <filter key={`glow-${key}`} id={`glow-${key}`} x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                  <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              ))}
              {/* Scanline pattern */}
              <pattern id="scanlines" patternUnits="userSpaceOnUse" width="4" height="4">
                <line x1="0" y1="0" x2="4" y2="0" stroke="rgba(255,255,255,0.03)" stroke-width="1"/>
              </pattern>
            </defs>

            {/* Background grid */}
            <circle cx={center} cy={center} r="120" fill="none" stroke="rgba(255,255,255,0.05)" stroke-dasharray="2,4"/>
            <circle cx={center} cy={center} r="80" fill="none" stroke="rgba(255,255,255,0.03)" stroke-dasharray="2,4"/>
            <circle cx={center} cy={center} r="40" fill="none" stroke="rgba(255,255,255,0.02)" stroke-dasharray="2,4"/>

            {/* Crosshairs */}
            <line x1={center} y1="20" x2={center} y2={size - 20} stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
            <line x1="20" y1={center} x2={size - 20} y2={center} stroke="rgba(255,255,255,0.05)" stroke-width="1"/>

            {/* Orbital rings - rendered from outside in for proper layering */}
            {sorted.map(([key, value], index) => {
              const config = TOKEN_CONFIG[key];
              const percentage = (value / total) * 100;
              const radius = getRadius(value, sorted.length - 1 - index);
              const circumference = 2 * Math.PI * radius;
              const dashLength = (percentage / 100) * circumference;

              return (
                <g key={key} class="orbit-ring" style={`--delay: ${index * 0.1}s`}>
                  {/* Glow layer */}
                  <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={config.glowColor}
                    stroke-width="8"
                    stroke-linecap="round"
                    stroke-dasharray={`${dashLength} ${circumference}`}
                    transform={`rotate(-90 ${center} ${center})`}
                    style="opacity: 0.6;"
                    filter={`url(#glow-${key})`}
                  />
                  {/* Main ring */}
                  <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={config.color}
                    stroke-width="3"
                    stroke-linecap="round"
                    stroke-dasharray={`${dashLength} ${circumference}`}
                    transform={`rotate(-90 ${center} ${center})`}
                    class="orbit-arc"
                  />
                  {/* Orbit dot at end */}
                  {percentage > 5 && (
                    <circle
                      cx={center + radius * Math.cos((percentage / 100 * 360 - 90) * Math.PI / 180)}
                      cy={center + radius * Math.sin((percentage / 100 * 360 - 90) * Math.PI / 180)}
                      r="4"
                      fill={config.color}
                      filter={`url(#glow-${key})`}
                      class="orbit-dot"
                    />
                  )}
                </g>
              );
            })}

            {/* Center core */}
            <circle cx={center} cy={center} r="25" fill="rgba(34, 211, 238, 0.1)" stroke="rgba(34, 211, 238, 0.3)" stroke-width="1"/>
            <text x={center} y={center - 4} text-anchor="middle" class="fill-cyan-400 text-[10px] font-mono uppercase tracking-wider">Total</text>
            <text x={center} y={center + 10} text-anchor="middle" class="fill-white text-sm font-mono font-bold">{formatTokens(total)}</text>

            {/* Scanline overlay */}
            <rect width={size} height={size} fill="url(#scanlines)" style="pointer-events: none;"/>
          </svg>

          {/* Animated pulse ring */}
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div class="w-[200px] h-[200px] rounded-full border border-cyan-500/20 animate-ping" style="animation-duration: 3s;"/>
          </div>
        </div>

        {/* Legend and stats */}
        <div class="flex-1 space-y-4 pt-2">
          {/* Token type legend */}
          <div class="space-y-3">
            {sorted.map(([key, value]) => {
              const config = TOKEN_CONFIG[key];
              const percentage = ((value / total) * 100).toFixed(1);
              return (
                <div key={key} class="group flex items-center gap-3">
                  {/* Indicator dot with glow */}
                  <div class="relative">
                    <div
                      class="w-2 h-2 rounded-full"
                      style={`background-color: ${config.color}; box-shadow: 0 0 8px ${config.glowColor};`}
                    />
                  </div>
                  {/* Label and value */}
                  <div class="flex-1 flex items-baseline justify-between">
                    <div>
                      <span class="text-gray-400 text-xs font-mono tracking-wider">{config.label}</span>
                      <span class="text-gray-600 text-xs ml-2">{config.description}</span>
                    </div>
                    <div class="text-right">
                      <span class="text-white font-mono text-sm">{formatTokens(value)}</span>
                      <span class="text-gray-500 text-xs ml-2">{percentage}%</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Divider */}
          <div class="border-t border-gray-800/50"/>

          {/* Key insight */}
          <div class="p-3 bg-cyan-500/5 border border-cyan-500/20 rounded-lg">
            <div class="flex items-center gap-2">
              <div class="w-1 h-8 bg-cyan-500 rounded-full"/>
              <div>
                <div class="text-cyan-400 text-xs font-mono uppercase tracking-wider">Efficiency</div>
                <div class="text-white font-mono text-lg">{insight}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CSS for animations */}
      <style>{`
        .orbit-container {
          filter: drop-shadow(0 0 20px rgba(34, 211, 238, 0.1));
        }
        .orbit-ring {
          animation: orbit-fade-in 0.8s ease-out forwards;
          animation-delay: var(--delay);
          opacity: 0;
        }
        .orbit-arc {
          stroke-dashoffset: 1000;
          animation: orbit-draw 1.5s ease-out forwards;
          animation-delay: var(--delay);
        }
        .orbit-dot {
          animation: pulse-glow 2s ease-in-out infinite;
        }
        @keyframes orbit-fade-in {
          from { opacity: 0; transform: scale(0.8); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes orbit-draw {
          from { stroke-dashoffset: 1000; }
          to { stroke-dashoffset: 0; }
        }
        @keyframes pulse-glow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
};

export default TokenOrbit;
