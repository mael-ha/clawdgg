import type { FC } from 'hono/jsx';

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVITY RADAR - 24-hour radial clock visualization
// Shows coding patterns as a radar sweep with intensity pulses
// Peak hours glow brightest, creating a visual fingerprint of work habits
// ═══════════════════════════════════════════════════════════════════════════

interface ActivityRadarProps {
  hourCounts: Record<string, number>;
}

// Time period colors with gradients
const TIME_COLORS = {
  night: { primary: '#3b82f6', glow: 'rgba(59, 130, 246, 0.4)' },    // 0-5: blue
  morning: { primary: '#f59e0b', glow: 'rgba(245, 158, 11, 0.4)' },  // 6-11: amber
  afternoon: { primary: '#22c55e', glow: 'rgba(34, 197, 94, 0.4)' }, // 12-17: green
  evening: { primary: '#a855f7', glow: 'rgba(168, 85, 247, 0.4)' },  // 18-23: purple
};

function getTimePeriod(hour: number): keyof typeof TIME_COLORS {
  if (hour >= 0 && hour < 6) return 'night';
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

function formatHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
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

  // Calculate period distribution
  const periods = {
    night: hours.filter(h => h.period === 'night').reduce((s, h) => s + h.count, 0),
    morning: hours.filter(h => h.period === 'morning').reduce((s, h) => s + h.count, 0),
    afternoon: hours.filter(h => h.period === 'afternoon').reduce((s, h) => s + h.count, 0),
    evening: hours.filter(h => h.period === 'evening').reduce((s, h) => s + h.count, 0),
  };
  const dominantPeriod = Object.entries(periods).reduce((max, [p, c]) => c > max[1] ? [p, c] : max, ['', 0]);

  // SVG dimensions
  const size = 260;
  const center = size / 2;
  const innerRadius = 40;
  const outerRadius = 110;

  return (
    <div class="relative">
      <div class="flex items-start gap-8">
        {/* Radar visualization */}
        <div class="relative flex-shrink-0">
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} class="radar-container">
            <defs>
              {/* Glow filters for each period */}
              {Object.entries(TIME_COLORS).map(([period, colors]) => (
                <filter key={period} id={`radar-glow-${period}`} x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
                  <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              ))}
              {/* Radial gradient for background */}
              <radialGradient id="radar-bg-gradient">
                <stop offset="0%" stop-color="rgba(34, 211, 238, 0.05)"/>
                <stop offset="100%" stop-color="transparent"/>
              </radialGradient>
            </defs>

            {/* Background circles */}
            <circle cx={center} cy={center} r={outerRadius} fill="url(#radar-bg-gradient)"/>
            <circle cx={center} cy={center} r={outerRadius} fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
            <circle cx={center} cy={center} r={(innerRadius + outerRadius) / 2} fill="none" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4,4"/>
            <circle cx={center} cy={center} r={innerRadius} fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>

            {/* Hour markers */}
            {[0, 6, 12, 18].map(hour => {
              const angle = (hour / 24) * 360 - 90;
              const rad = angle * Math.PI / 180;
              const x1 = center + innerRadius * Math.cos(rad);
              const y1 = center + innerRadius * Math.sin(rad);
              const x2 = center + outerRadius * Math.cos(rad);
              const y2 = center + outerRadius * Math.sin(rad);
              const labelX = center + (outerRadius + 15) * Math.cos(rad);
              const labelY = center + (outerRadius + 15) * Math.sin(rad);
              return (
                <g key={hour}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                  <text x={labelX} y={labelY} text-anchor="middle" dominant-baseline="middle" class="fill-gray-500 text-[10px] font-mono">
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

              // Create arc path
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
                  {/* Glow layer for active segments */}
                  {intensity > 0.1 && (
                    <path
                      d={path}
                      fill={colors.glow}
                      filter={`url(#radar-glow-${h.period})`}
                      style={`opacity: ${intensity * 0.8};`}
                    />
                  )}
                  {/* Main segment */}
                  <path
                    d={path}
                    fill={intensity > 0 ? colors.primary : 'rgba(255,255,255,0.02)'}
                    style={`opacity: ${Math.max(intensity * 0.9, 0.1)};`}
                    class={isPeak ? 'peak-segment' : ''}
                  />
                  {/* Peak indicator */}
                  {isPeak && (
                    <circle
                      cx={center + (barRadius + 8) * Math.cos((startRad + endRad) / 2)}
                      cy={center + (barRadius + 8) * Math.sin((startRad + endRad) / 2)}
                      r="3"
                      fill={colors.primary}
                      filter={`url(#radar-glow-${h.period})`}
                      class="peak-dot"
                    />
                  )}
                </g>
              );
            })}

            {/* Center core */}
            <circle cx={center} cy={center} r={innerRadius - 5} fill="rgba(0,0,0,0.8)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
            <text x={center} y={center - 8} text-anchor="middle" class="fill-gray-400 text-[8px] font-mono uppercase tracking-wider">Peak</text>
            <text x={center} y={center + 6} text-anchor="middle" class="fill-white text-sm font-mono font-bold">
              {peakHour ? formatHour(peakHour.hour) : '—'}
            </text>
            <text x={center} y={center + 18} text-anchor="middle" class="fill-gray-500 text-[9px] font-mono">
              {peakHour && total > 0 ? `${Math.round((peakHour.count / total) * 100)}%` : ''}
            </text>

            {/* Animated sweep line */}
            <line
              x1={center}
              y1={center}
              x2={center}
              y2={center - outerRadius + 5}
              stroke="rgba(34, 211, 238, 0.6)"
              stroke-width="1"
              class="radar-sweep"
            />
          </svg>
        </div>

        {/* Legend and stats */}
        <div class="flex-1 space-y-4 pt-2">
          {/* Period breakdown */}
          <div class="space-y-3">
            {Object.entries(periods)
              .filter(([_, count]) => count > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([period, count]) => {
                const colors = TIME_COLORS[period as keyof typeof TIME_COLORS];
                const percentage = total > 0 ? ((count / total) * 100).toFixed(0) : '0';
                const label = period.charAt(0).toUpperCase() + period.slice(1);
                const times = {
                  night: '12a–6a',
                  morning: '6a–12p',
                  afternoon: '12p–6p',
                  evening: '6p–12a',
                }[period];

                return (
                  <div key={period} class="flex items-center gap-3">
                    <div
                      class="w-2 h-2 rounded-full"
                      style={`background-color: ${colors.primary}; box-shadow: 0 0 8px ${colors.glow};`}
                    />
                    <div class="flex-1 flex items-baseline justify-between">
                      <div>
                        <span class="text-gray-300 text-sm">{label}</span>
                        <span class="text-gray-600 text-xs ml-2">{times}</span>
                      </div>
                      <span class="text-white font-mono text-sm">{percentage}%</span>
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Divider */}
          <div class="border-t border-gray-800/50"/>

          {/* Pattern insight */}
          {dominantPeriod[1] as number > 0 && (
            <div class="p-3 bg-gray-900/50 border border-gray-800 rounded-lg">
              <div class="flex items-center gap-2">
                <span class="text-xl">
                  {dominantPeriod[0] === 'night' ? '🌙' : dominantPeriod[0] === 'morning' ? '🌅' : dominantPeriod[0] === 'afternoon' ? '☀️' : '🌆'}
                </span>
                <div>
                  <div class="text-gray-400 text-xs font-mono uppercase tracking-wider">Pattern</div>
                  <div class="text-white text-sm">
                    {dominantPeriod[0] === 'night' && 'Night Owl'}
                    {dominantPeriod[0] === 'morning' && 'Early Bird'}
                    {dominantPeriod[0] === 'afternoon' && 'Afternoon Focus'}
                    {dominantPeriod[0] === 'evening' && 'Evening Coder'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CSS for animations */}
      <style>{`
        .radar-container {
          filter: drop-shadow(0 0 20px rgba(34, 211, 238, 0.1));
        }
        .radar-segment {
          animation: segment-fade-in 0.5s ease-out forwards;
          animation-delay: var(--delay);
          opacity: 0;
        }
        .peak-segment {
          animation: peak-pulse 2s ease-in-out infinite;
        }
        .peak-dot {
          animation: dot-pulse 1.5s ease-in-out infinite;
        }
        .radar-sweep {
          transform-origin: center center;
          animation: sweep 8s linear infinite;
        }
        @keyframes segment-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes peak-pulse {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.3); }
        }
        @keyframes dot-pulse {
          0%, 100% { opacity: 1; r: 3; }
          50% { opacity: 0.6; r: 4; }
        }
        @keyframes sweep {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default ActivityRadar;
