import type { FC } from 'hono/jsx';

// ═══════════════════════════════════════════════════════════════════════════
// HOURLY ACTIVITY - Bar chart showing activity distribution by hour
// ═══════════════════════════════════════════════════════════════════════════

interface HourlyActivityProps {
  hourCounts: Record<string, number>;
}

// Format hour for display
function formatHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

// Determine time period
function getTimePeriod(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

// Color by time period
const PERIOD_COLORS = {
  morning: '#f59e0b',   // amber
  afternoon: '#22c55e', // green
  evening: '#a855f7',   // purple
  night: '#3b82f6',     // blue
};

export const HourlyActivity: FC<HourlyActivityProps> = ({ hourCounts }) => {
  // Build full 24-hour array
  const hours: { hour: number; count: number; period: ReturnType<typeof getTimePeriod> }[] = [];
  for (let h = 0; h < 24; h++) {
    hours.push({
      hour: h,
      count: hourCounts[String(h)] || 0,
      period: getTimePeriod(h),
    });
  }

  const max = Math.max(...hours.map(h => h.count), 1);
  const total = hours.reduce((sum, h) => sum + h.count, 0);

  // Find peak hour
  const peakHour = hours.reduce((peak, h) => h.count > peak.count ? h : peak, hours[0]!);
  if (!peakHour) return null;

  // Calculate time period distribution
  const periodCounts = {
    morning: hours.filter(h => h.period === 'morning').reduce((sum, h) => sum + h.count, 0),
    afternoon: hours.filter(h => h.period === 'afternoon').reduce((sum, h) => sum + h.count, 0),
    evening: hours.filter(h => h.period === 'evening').reduce((sum, h) => sum + h.count, 0),
    night: hours.filter(h => h.period === 'night').reduce((sum, h) => sum + h.count, 0),
  };

  // Find dominant period
  const dominantPeriod = Object.entries(periodCounts).reduce((max, [period, count]) =>
    count > max[1] ? [period, count] : max,
    ['', 0]
  );
  const dominantPct = total > 0 ? Math.round((dominantPeriod[1] as number / total) * 100) : 0;

  return (
    <div class="space-y-4">
      {/* Bar chart */}
      <div class="flex items-end justify-between h-32 gap-[2px]">
        {hours.map(({ hour, count, period }) => {
          const height = max > 0 ? (count / max) * 100 : 0;
          const isPeak = count === peakHour?.count && count > 0;

          return (
            <div
              key={hour}
              class="flex-1 flex flex-col items-center group relative"
            >
              <div
                class={`w-full rounded-t transition-all duration-300 ${isPeak ? 'ring-1 ring-cyan-400' : ''}`}
                style={`height: ${Math.max(height, 2)}%; background-color: ${PERIOD_COLORS[period]}; opacity: ${height > 0 ? 0.7 : 0.2};`}
                title={`${formatHour(hour)}: ${count.toLocaleString()} prompts`}
              />
              {/* Hour label (show every 6 hours) */}
              {hour % 6 === 0 && (
                <span class="text-[10px] text-gray-600 mt-1">{formatHour(hour)}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div class="flex flex-wrap justify-center gap-4 text-xs">
        {Object.entries(PERIOD_COLORS).map(([period, color]) => (
          <div key={period} class="flex items-center gap-1">
            <div class="w-2 h-2 rounded-sm" style={`background-color: ${color}`} />
            <span class="text-gray-500 capitalize">{period}</span>
            <span class="text-gray-600">
              ({total > 0 ? Math.round((periodCounts[period as keyof typeof periodCounts] / total) * 100) : 0}%)
            </span>
          </div>
        ))}
      </div>

      {/* Peak hour callout */}
      {peakHour && peakHour.count > 0 && (
        <div class="text-center text-sm text-gray-500">
          Peak: <span class="text-gray-300 font-mono">{formatHour(peakHour.hour)}-{formatHour((peakHour.hour + 1) % 24)}</span>
          {' '}({Math.round((peakHour.count / total) * 100)}% of activity)
        </div>
      )}

      {/* Insight */}
      {dominantPct >= 40 && (
        <div class="p-3 bg-gray-900/50 border border-gray-800 rounded-lg">
          <p class="text-sm text-gray-400">
            <span class="text-cyan-400">Pattern:</span>{' '}
            {dominantPeriod[0] === 'night' && `You're a night owl — ${dominantPct}% of your work happens after dark.`}
            {dominantPeriod[0] === 'morning' && `Early bird — ${dominantPct}% of your work happens before noon.`}
            {dominantPeriod[0] === 'afternoon' && `Afternoon focus — ${dominantPct}% of your work happens midday.`}
            {dominantPeriod[0] === 'evening' && `Evening coder — ${dominantPct}% of your work happens in the evening.`}
          </p>
        </div>
      )}
    </div>
  );
};

export default HourlyActivity;
