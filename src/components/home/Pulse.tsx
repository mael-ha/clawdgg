import type { FC } from 'hono/jsx';
import type { GlobalPulse } from '../../lib/boards';
import { formatCost, formatNumber } from '../../lib/format';

/**
 * The week, everywhere at once.
 *
 * Four aggregates, no names: how many people were here, what Claude's work
 * would have cost at API prices, how often someone asked it to think harder,
 * and the hour of the day the world is loudest — the world's Claude o'clock.
 *
 * COMPACTED on purpose, unlike a board figure. "$18.6K together" is a
 * magnitude and nobody counts a rank against it; the per-user column stays
 * exact because a reader does compare those.
 */

const CARD = 'flex flex-col gap-1 rounded-xl border border-[#1a1f2b] bg-[#0b0d12] px-4 py-3.5';

const Stat: FC<{ label: string; color: string; value: string; sub: string }> = ({
  label,
  color,
  value,
  sub,
}) => (
  <div class={CARD}>
    <span class={`text-[11px] tracking-[0.06em] ${color}`}>{label}</span>
    <span class="text-2xl font-extrabold text-gray-100">{value}</span>
    <span class="text-[11px] text-[#6f7686]">{sub}</span>
  </div>
);

export const Pulse: FC<{ pulse: GlobalPulse }> = ({ pulse }) => {
  if (!pulse.complete) {
    return (
      <p class="rounded-xl border border-[#1a1f2b] bg-[#0b0d12] px-4 py-3.5 font-mono text-[11px] text-[#6f7686]">
        this week's global figures are unavailable right now — the boards above are live
      </p>
    );
  }

  return (
    <section
      aria-label="This week across clawd.gg"
      class="grid grid-cols-2 gap-3.5 lg:grid-cols-4"
    >
      <Stat
        label="THIS WEEK"
        color="text-cyan-400"
        value={`${formatNumber(pulse.devs)} ${pulse.devs === 1 ? 'dev' : 'devs'}`}
        sub="active on clawd.gg"
      />
      <Stat
        label="💎 TOGETHER"
        color="text-magenta-400"
        value={formatCost(Math.round(pulse.valueUsd * 100))}
        sub="API-equivalent of Claude"
      />
      <Stat
        label="🌈 ULTRATHINKS"
        color="text-amber-400"
        value={formatNumber(pulse.ultrathinks)}
        sub="across everyone"
      />
      <Stat
        label="⏱ BUSIEST HOUR"
        color="text-cyan-300"
        // No hour at all until someone has prompted this week — a default of
        // "00h" would be a claim about a world that has not woken up yet.
        value={pulse.busiestHourUtc === null ? '—' : `${pulse.busiestHourUtc}h UTC`}
        sub="the world's Claude o'clock"
      />
    </section>
  );
};
