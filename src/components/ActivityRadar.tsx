import type { FC } from 'hono/jsx';

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVITY RADAR - 24-hour radial clock visualization
// Shows coding patterns as a radar sweep with intensity pulses
// Follows consistent design pattern: Header + Viz + Legend + Footer
// ═══════════════════════════════════════════════════════════════════════════

interface ActivityRadarProps {
  hourCounts: Record<string, number>;
}

// Time period colors with gradients
const TIME_COLORS = {
  night: { primary: '#3b82f6', glow: 'rgba(59, 130, 246, 0.4)', label: 'Night', time: '12a–6a', emoji: '🌙' },
  morning: { primary: '#f59e0b', glow: 'rgba(245, 158, 11, 0.4)', label: 'Morning', time: '6a–12p', emoji: '🌅' },
  afternoon: { primary: '#22c55e', glow: 'rgba(34, 197, 94, 0.4)', label: 'Afternoon', time: '12p–6p', emoji: '☀️' },
  evening: { primary: '#a855f7', glow: 'rgba(168, 85, 247, 0.4)', label: 'Evening', time: '6p–12a', emoji: '🌆' },
};

function getTimePeriod(hour: number): keyof typeof TIME_COLORS {
  if (hour >= 0 && hour < 6) return 'night';
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

function formatHour(hour: number): string {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

function formatHourRange(hour: number): string {
  const nextHour = (hour + 1) % 24;
  return `${formatHour(hour)} – ${formatHour(nextHour)}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export const ActivityRadar: FC<ActivityRadarProps> = ({ hourCounts }) => {
  // Build 24-hour data
  const hours: { hour: number; count: number; period: keyof typeof TIME_COLORS }[] = [];
  for (let h = 0; h < 24; h++) {
    hours.push({
      hour: h,
      count: hourCounts[String(h)] || 0,
      period: getTimePeriod(h),
    });
  }

  const maxCount = Math.max(...hours.map(h => h.count), 1);
  const total = hours.reduce((sum, h) => sum + h.count, 0);

  // Find peak hour
  const firstHour = hours[0];
  if (!firstHour) return null;
  const peakHour = hours.reduce((peak, h) => h.count > peak.count ? h : peak, firstHour);
  const peakPeriod = peakHour ? TIME_COLORS[peakHour.period] : null;

  // Calculate period distribution
  const periods = {
    night: hours.filter(h => h.period === 'night').reduce((s, h) => s + h.count, 0),
    morning: hours.filter(h => h.period === 'morning').reduce((s, h) => s + h.count, 0),
    afternoon: hours.filter(h => h.period === 'afternoon').reduce((s, h) => s + h.count, 0),
    evening: hours.filter(h => h.period === 'evening').reduce((s, h) => s + h.count, 0),
  };

  // SVG dimensions - sized to fit labels outside radar
  const size = 220;
  const center = size / 2;
  const innerRadius = 25;
  const outerRadius = 80;

  return (
    <div class="space-y-3">
      {/* Header row: Total (left) + Peak hour badge (right) */}
      <div class="flex items-center justify-between">
        <span class="text-white font-mono text-lg sm:text-xl font-bold">
          {formatNumber(total)} <span class="text-gray-500 text-sm font-normal">prompts</span>
        </span>
        {peakHour && peakHour.count > 0 && peakPeriod && (
          <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono"
               style={`background: ${peakPeriod.primary}20; border: 1px solid ${peakPeriod.primary}50;`}>
            <span>{peakPeriod.emoji}</span>
            <span class="text-gray-300">Peak:</span>
            <span class="text-white font-bold">{formatHourRange(peakHour.hour)}</span>
          </div>
        )}
      </div>

      {/* Main layout - stacked on mobile, side-by-side on desktop */}
      <div class="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
        {/* Radar visualization */}
        <div class="relative flex-shrink-0">
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} class="radar-container">
            <defs>
              {Object.entries(TIME_COLORS).map(([period, colors]) => (
                <filter key={period} id={`radar-glow-${period}`} x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                  <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              ))}
              <radialGradient id="radar-bg-gradient">
                <stop offset="0%" stop-color="rgba(34, 211, 238, 0.03)"/>
                <stop offset="100%" stop-color="transparent"/>
              </radialGradient>
            </defs>

            {/* Background circles */}
            <circle cx={center} cy={center} r={outerRadius} fill="url(#radar-bg-gradient)"/>
            <circle cx={center} cy={center} r={outerRadius} fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
            <circle cx={center} cy={center} r={(innerRadius + outerRadius) / 2} fill="none" stroke="rgba(255,255,255,0.04)" stroke-dasharray="3,3"/>
            <circle cx={center} cy={center} r={innerRadius} fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>

            {/* Hour markers */}
            {[0, 6, 12, 18].map(hour => {
              const angle = (hour / 24) * 360 - 90;
              const rad = angle * Math.PI / 180;
              const x1 = center + innerRadius * Math.cos(rad);
              const y1 = center + innerRadius * Math.sin(rad);
              const x2 = center + outerRadius * Math.cos(rad);
              const y2 = center + outerRadius * Math.sin(rad);
              const labelX = center + (outerRadius + 12) * Math.cos(rad);
              const labelY = center + (outerRadius + 12) * Math.sin(rad);
              return (
                <g key={hour}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
                  <text x={labelX} y={labelY} text-anchor="middle" dominant-baseline="middle" class="fill-gray-600 text-[9px] font-mono">
                    {formatHour(hour)}
                  </text>
                </g>
              );
            })}

            {/* Activity bars as radial segments */}
            {hours.map((h, i) => {
              const startAngle = (h.hour / 24) * 360 - 90;
              const endAngle = ((h.hour + 1) / 24) * 360 - 90;
              const intensity = h.count / maxCount;
              const barRadius = innerRadius + (outerRadius - innerRadius) * Math.max(intensity, 0.05);
              const colors = TIME_COLORS[h.period];
              const isPeak = h.hour === peakHour?.hour && h.count > 0;

              const startRad = startAngle * Math.PI / 180;
              const endRad = endAngle * Math.PI / 180;
              const x1 = center + innerRadius * Math.cos(startRad);
              const y1 = center + innerRadius * Math.sin(startRad);
              const x2 = center + barRadius * Math.cos(startRad);
              const y2 = center + barRadius * Math.sin(startRad);
              const x3 = center + barRadius * Math.cos(endRad);
              const y3 = center + barRadius * Math.sin(endRad);
              const x4 = center + innerRadius * Math.cos(endRad);
              const y4 = center + innerRadius * Math.sin(endRad);

              const path = `M ${x1} ${y1} L ${x2} ${y2} A ${barRadius} ${barRadius} 0 0 1 ${x3} ${y3} L ${x4} ${y4} A ${innerRadius} ${innerRadius} 0 0 0 ${x1} ${y1}`;

              return (
                <g key={h.hour} class="radar-segment" style={`--delay: ${i * 0.02}s`}>
                  {intensity > 0.1 && (
                    <path
                      d={path}
                      fill={colors.glow}
                      filter={`url(#radar-glow-${h.period})`}
                      style={`opacity: ${intensity * 0.7};`}
                    />
                  )}
                  <path
                    d={path}
                    fill={intensity > 0 ? colors.primary : 'rgba(255,255,255,0.02)'}
                    style={`opacity: ${Math.max(intensity * 0.85, 0.08)};`}
                    class={isPeak ? 'peak-segment' : ''}
                  />
                </g>
              );
            })}

            {/* Center core */}
            <circle cx={center} cy={center} r={innerRadius - 4} fill="rgba(0,0,0,0.9)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
            <text x={center} y={center + 3} text-anchor="middle" class="fill-gray-500 text-[8px] font-mono uppercase tracking-wider">24h</text>
          </svg>
        </div>

        {/* Legend - period breakdown */}
        <div class="w-full sm:w-auto sm:flex-1 grid grid-cols-2 gap-x-4 gap-y-2">
          {(Object.entries(periods) as [keyof typeof TIME_COLORS, number][])
            .filter(([_, count]) => count > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([period, count]) => {
              const colors = TIME_COLORS[period];
              const percentage = total > 0 ? Math.round((count / total) * 100) : 0;

              return (
                <div key={period} class="flex items-center gap-2">
                  <div
                    class="w-2 h-2 rounded-full flex-shrink-0"
                    style={`background-color: ${colors.primary}; box-shadow: 0 0 6px ${colors.glow};`}
                  />
                  <span class="text-gray-400 text-xs font-mono">{colors.label}</span>
                  <span class="text-white text-xs font-mono">{formatNumber(count)}</span>
                  <span class="text-gray-600 text-xs">({percentage}%)</span>
                </div>
              );
            })}
        </div>
      </div>

      {/* Footer hint */}
      <div class="pt-2 border-t border-gray-800/30">
        <p class="text-gray-600 text-xs font-mono text-center">
          Activity distribution across 24 hours
        </p>
      </div>

      {/* CSS for animations */}
      <style>{`
        .radar-container {
          filter: drop-shadow(0 0 15px rgba(34, 211, 238, 0.08));
        }
        .radar-segment {
          animation: segment-fade-in 0.5s ease-out forwards;
          animation-delay: var(--delay);
          opacity: 0;
        }
        .peak-segment {
          animation: peak-pulse 2s ease-in-out infinite;
        }
        @keyframes segment-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes peak-pulse {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.2); }
        }
      `}</style>
    </div>
  );
};

export default ActivityRadar;
