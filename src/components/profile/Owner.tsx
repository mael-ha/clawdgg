import type { FC } from 'hono/jsx';
import { FINGERPRINT_SECTIONS, type FingerprintSection } from '../../lib/fingerprint';
import { Nothing, SectionTitle, VisibilityPill } from './parts';
import { clockAt, compact, countdown, dayLabel, group, money, pct, weekdayClockAt } from './format';
import { sawtooth } from './geometry';
import type { OwnerData, PipelineData, PlanData, TodayData, Visibility } from './types';

/**
 * The owner layer: what only you see, plus the one card you can choose to
 * share.
 *
 * `today` and `pipeline` are never public — they are an operational read on
 * your own machine, and nothing about them is anybody else's business. `plan`
 * IS public by default, because how close someone runs to their limit is the
 * most interesting number on the page and hiding it by default would mean
 * nobody ever saw it; the toggle is right next to it either way.
 */

const SAW_BOX = { width: 1000, height: 150 };

/**
 * "in 2d 4h", or an honest word when the boundary has already gone past.
 *
 * A reset time only arrives with a status-line sample, so a stale snapshot
 * leaves one in the past — and `countdown` would floor it to "in 0m", which
 * reads as "it resets this second" rather than "we have not heard since".
 */
function untilReset(resetsAt: number): string {
  const seconds = resetsAt - Math.floor(Date.now() / 1000);
  return seconds > 0 ? `in ${countdown(seconds)}` : 'reset due';
}

// ═══════════════════════════════════════════════════════════════════════════
// 💎 plan
// ═══════════════════════════════════════════════════════════════════════════

const Meter: FC<{ pctUsed: number; color: string; markerPct?: number | null; label: string }> = ({
  pctUsed,
  color,
  markerPct,
  label,
}) => (
  <div
    class="relative h-2.5 rounded-full bg-fp-line"
    role="img"
    aria-label={label}
  >
    <div
      class="h-2.5 rounded-full"
      style={`width:${Math.min(100, Math.max(0, pctUsed)).toFixed(1)}%;background:${color}`}
    />
    {markerPct !== null && markerPct !== undefined && markerPct <= 100 && (
      <div
        aria-hidden="true"
        class="absolute top-[-4px] h-[18px] w-0.5 bg-amber-400"
        style={`left:${markerPct.toFixed(1)}%`}
      />
    )}
  </div>
);

/**
 * How worried to look about a projection.
 *
 * Amber past 90% and rose past 100%, and silent below: a projection that
 * lands comfortably inside the window is not news, and colouring it anyway
 * trains the reader to ignore the colour.
 */
function paceNote(projected: number | null): { text: string; class: string } | null {
  if (projected === null) return null;
  if (projected >= 100) return { text: `on pace to run out`, class: 'text-fp-rose' };
  if (projected >= 90) return { text: `on pace for ~${pct(projected)}`, class: 'text-amber-400' };
  return { text: `on pace for ~${pct(projected)}`, class: 'text-fp-dim' };
}

/**
 * `timezone` is null for a visitor, and the reset times then read as
 * countdowns rather than wall-clock times: "resets Sun 20:00" is a statement
 * about where somebody lives, and "in 2d 4h" is the same fact without it.
 */
export const Plan: FC<{
  plan: PlanData;
  timezone: string | null;
  visibility: Visibility | null;
}> = ({ plan, timezone, visibility }) => {
  const saw = sawtooth(plan.cycles, SAW_BOX);
  const pace = paceNote(plan.projectedPct);

  return (
    <div class="flex flex-col gap-4 rounded-2xl border border-fp-border bg-fp-card px-4 py-5 sm:px-6">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="flex items-center gap-3">
          <h2 class="m-0 font-mono text-[15px] font-bold tracking-[0.04em] text-fp-text">
            💎 plan
          </h2>
          {visibility && <VisibilityPill section="plan" isPublic={visibility.plan} />}
        </div>
        <span class="font-mono text-[12px] text-fp-dim">from your status line</span>
      </div>

      <div class="grid gap-5 sm:grid-cols-2">
        {plan.weekly ? (
          <div class="flex flex-col gap-2">
            <div class="flex justify-between gap-2 font-mono text-[12px] text-fp-dim">
              <span>weekly limit</span>
              <span>
                {plan.weekly.resetsAt
                  ? (timezone
                      ? `resets ${weekdayClockAt(plan.weekly.resetsAt, timezone)} · `
                      : 'resets ') + untilReset(plan.weekly.resetsAt)
                  : 'reset time unknown'}
              </span>
            </div>
            <div class="flex items-baseline gap-2.5">
              <span class="font-mono text-[32px] font-extrabold text-fp-text sm:text-[36px]">
                {pct(plan.weekly.usedPercentage)}
              </span>
              {pace && <span class={`font-mono text-[12px] ${pace.class}`}>{pace.text}</span>}
            </div>
            <Meter
              pctUsed={plan.weekly.usedPercentage}
              color="#ff00ff"
              markerPct={plan.projectedPct}
              label={`Weekly limit ${pct(plan.weekly.usedPercentage)} used`}
            />
          </div>
        ) : (
          <Nothing>no weekly window reported yet</Nothing>
        )}

        {plan.session ? (
          <div class="flex flex-col gap-2">
            <div class="flex justify-between gap-2 font-mono text-[12px] text-fp-dim">
              <span>5-hour session</span>
              <span>
                {plan.session.resetsAt
                  ? timezone
                    ? `resets ${clockAt(plan.session.resetsAt, timezone)}`
                    : `resets ${untilReset(plan.session.resetsAt)}`
                  : 'reset time unknown'}
              </span>
            </div>
            <div class="flex items-baseline gap-2.5">
              <span class="font-mono text-[32px] font-extrabold text-fp-text sm:text-[36px]">
                {pct(plan.session.usedPercentage)}
              </span>
              <span class="font-mono text-[12px] text-fp-dim">
                {plan.session.usedPercentage < 50 ? 'plenty of room' : 'keep an eye on it'}
              </span>
            </div>
            <Meter
              pctUsed={plan.session.usedPercentage}
              color="#c084fc"
              label={`Five-hour session ${pct(plan.session.usedPercentage)} used`}
            />
          </div>
        ) : (
          <Nothing>no session window reported yet</Nothing>
        )}
      </div>

      {plan.cycles.length > 0 && (
        <>
          <svg
            viewBox={`0 0 ${SAW_BOX.width} ${SAW_BOX.height}`}
            preserveAspectRatio="none"
            class="block h-[110px] w-full sm:h-[150px]"
            role="img"
            aria-label={`Weekly plan usage over the last ${plan.cycles.length} cycles`}
          >
            <line x1="0" y1="14" x2={SAW_BOX.width} y2="14" stroke="#3a2030" stroke-width="1" />
            <line
              x1="0"
              y1={SAW_BOX.height - 1}
              x2={SAW_BOX.width}
              y2={SAW_BOX.height - 1}
              stroke="#262b38"
              stroke-width="1"
            />
            {saw.dividers.map((x) => (
              <line
                key={x}
                x1={x}
                y1="0"
                x2={x}
                y2={SAW_BOX.height}
                stroke="#262b38"
                stroke-width="1"
                stroke-dasharray="4 4"
              />
            ))}
            <path d={saw.area} fill="rgba(255,0,255,0.12)" />
            <path
              d={saw.line}
              fill="none"
              stroke="#ff00ff"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
              stroke-linejoin="round"
            />
          </svg>
          <div
            class="grid gap-1 font-mono text-[10px] text-fp-faint sm:text-[11px]"
            style={`grid-template-columns:repeat(${plan.cycles.length},minmax(0,1fr))`}
          >
            {plan.cycles.map((cycle) => (
              <span key={cycle.from}>
                {dayLabel(new Date(cycle.from * 1000).toISOString(), false)} →{' '}
                {cycle.current
                  ? 'now'
                  : dayLabel(new Date(cycle.to * 1000).toISOString(), false)}{' '}
                · {pct(cycle.peakPct)}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// ☀️ today
// ═══════════════════════════════════════════════════════════════════════════

const Figure: FC<{ figure: string; label: string }> = ({ figure, label }) => (
  <div class="flex flex-col">
    <span class="font-mono text-[22px] font-extrabold text-fp-text">{figure}</span>
    <span class="font-mono text-[11px] text-fp-dim">{label}</span>
  </div>
);

/** How recently the pipe spoke, as a word rather than a timestamp. */
function freshness(iso: string | null): { dot: string; text: string } {
  if (!iso) return { dot: '#6f7686', text: 'nothing yet' };
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 10) return { dot: '#00ff9f', text: minutes < 1 ? 'just now' : `${minutes} min ago` };
  if (minutes < 120) return { dot: '#fbbf24', text: `${minutes} min ago` };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { dot: '#fbbf24', text: `${hours}h ago` };
  return { dot: '#ff4d6d', text: `${Math.floor(hours / 24)}d ago` };
}

export const Today: FC<{ today: TodayData }> = ({ today }) => {
  const live = freshness(today.lastEventAt);
  const quiet = today.prompts === 0 && today.value === 0;

  return (
    <div class="flex flex-col gap-3 rounded-2xl border border-fp-border bg-fp-card px-5 py-4">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="m-0 font-mono text-[15px] font-bold tracking-[0.04em] text-fp-text">
          ☀️ today
        </h2>
        <span class="font-mono text-[12px]" style={`color:${live.dot}`}>
          ● {live.text}
        </span>
      </div>
      {quiet ? (
        <Nothing>nothing today yet</Nothing>
      ) : (
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Figure figure={group(today.prompts)} label="prompts" />
          <Figure figure={money(today.value)} label="value" />
          <Figure figure={compact(today.lines)} label="lines" />
          <Figure figure={group(today.ultrathinks)} label="🌈" />
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// 🩺 pipeline
// ═══════════════════════════════════════════════════════════════════════════

const Status: FC<{ color: string; children?: unknown }> = ({ color, children }) => (
  <span>
    <span aria-hidden="true" style={`color:${color}`}>
      ●
    </span>{' '}
    {children}
  </span>
);

/**
 * 🩺 pipeline — `clawdgg doctor` on the page.
 *
 * The last LIVE row is the one number here that cannot be inferred from any
 * other panel: when telemetry stops, every chart keeps its history and nothing
 * else on the page changes, so a pipe that went quiet three weeks ago is
 * invisible until someone asks this question.
 */
export const Pipeline: FC<{ pipeline: PipelineData }> = ({ pipeline }) => {
  const live = freshness(pipeline.lastLiveEventAt);

  return (
    <div class="flex flex-col gap-2 rounded-2xl border border-fp-border bg-fp-card px-5 py-4 font-mono text-[12px] text-fp-dim">
      <h2 class="m-0 mb-1 font-mono text-[15px] font-bold tracking-[0.04em] text-fp-text">
        🩺 pipeline
      </h2>
      <Status color={live.dot}>telemetry · last live event {live.text}</Status>
      <Status color={pipeline.devices > 0 ? '#00ff9f' : '#fbbf24'}>
        auth helper ·{' '}
        {pipeline.devices > 0
          ? `${pipeline.devices} device${pipeline.devices === 1 ? '' : 's'} linked`
          : 'no device linked — run clawdgg login'}
      </Status>
      <Status color={pipeline.ultrathinkHook ? '#00ff9f' : '#6f7686'}>
        ultrathink hook ·{' '}
        {pipeline.ultrathinkHook ? 'reporting' : 'not installed — run clawdgg setup'}
      </Status>
      <Status color={pipeline.cliVersion ? '#00ff9f' : '#6f7686'}>
        cli · {pipeline.cliVersion ? `v${pipeline.cliVersion}` : 'version not reported'}
      </Status>
      {pipeline.importedFrom && pipeline.importedTo && (
        <span class="text-fp-faint">
          history recovered · {dayLabel(pipeline.importedFrom)} → {dayLabel(pipeline.importedTo)}
        </span>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// 👁 what visitors see
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The names the toggle grid shows, which are the names the page shows — not the
 * payload's section keys. `curve` is "⚡ activity" everywhere a reader sees it,
 * and a settings grid that calls it something else is a settings grid nobody
 * trusts. The keys themselves still go over the wire.
 */
const SECTION_NAMES: Record<FingerprintSection, string> = {
  value: '💎 value',
  anatomy: '✍️ anatomy',
  conversation: '📏 conversation',
  rings: '🧿 rings',
  class: '🧭 class',
  milestones: '🏁 milestones',
  curve: '⚡ activity',
  year: '📅 the year',
  ultrathink: '🌈 ultrathink',
  plan: '💎 plan',
};

export const VisibilityGrid: FC<{ visibility: Visibility }> = ({ visibility }) => (
  <div class="flex flex-col gap-3.5 rounded-2xl border border-fp-border bg-fp-card px-4 py-5 sm:px-6">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="m-0 font-mono text-[15px] font-bold tracking-[0.04em] text-fp-text">
        👁 what visitors see
      </h2>
      <span class="font-mono text-[12px] text-fp-faint">
        everything is public by default · each switch also appears next to its section
      </span>
    </div>
    <div
      id="fp-visibility"
      class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5"
      data-endpoint="/api/me/profile-settings"
    >
      {FINGERPRINT_SECTIONS.map((section) => {
        const on = visibility[section];
        return (
          <button
            key={section}
            type="button"
            class="fp-visibility-toggle flex min-h-[44px] items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left font-mono text-[12px] transition-colors"
            data-section={section}
            aria-pressed={on ? 'true' : 'false'}
            style={
              on
                ? 'border-color:#1f3b2f;background:#0c1a14;color:#00ff9f'
                : 'border-color:#262b38;background:transparent;color:#8a91a0'
            }
          >
            <span>{SECTION_NAMES[section]}</span>
            <span aria-hidden="true">{on ? '●' : '○'}</span>
          </button>
        );
      })}
    </div>
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════
// The layer
// ═══════════════════════════════════════════════════════════════════════════

export const OwnerLayer: FC<{ owner: OwnerData; timezone: string | null; username: string }> = ({
  owner,
  timezone,
  username,
}) => (
  <section class="flex flex-col gap-[18px] border-t border-dashed border-fp-edge pt-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <span class="font-mono text-[11px] tracking-[0.08em] text-fp-dim sm:text-[12px]">
        🔒 OWNER LAYER · today, pipeline and settings are only ever yours · plan is public by your
        choice
      </span>
      <a
        href={`/u/${username}?as=visitor`}
        class="inline-flex min-h-[44px] items-center rounded-lg border border-fp-edge px-3 font-mono text-[12px] text-fp-text no-underline transition-colors hover:border-cyan-400"
      >
        preview as visitor
      </a>
    </div>

    <div class="grid gap-[18px] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      {owner.plan ? (
        <Plan plan={owner.plan} timezone={timezone} visibility={owner.visibility} />
      ) : (
        <div class="flex flex-col gap-2 rounded-2xl border border-fp-border bg-fp-card px-4 py-5 sm:px-6">
          <h2 class="m-0 font-mono text-[15px] font-bold tracking-[0.04em] text-fp-text">
            💎 plan
          </h2>
          <Nothing>
            no plan usage reported yet · Claude Code's status line is the only source for it, so
            run <span class="text-cyan-400">clawdgg setup</span> and it will fill in
          </Nothing>
        </div>
      )}

      <div class="flex flex-col gap-[18px]">
        {owner.today && <Today today={owner.today} />}
        {owner.pipeline && <Pipeline pipeline={owner.pipeline} />}
      </div>
    </div>

    <VisibilityGrid visibility={owner.visibility} />
  </section>
);
