import type { FC } from 'hono/jsx';
import type {
  ClassVerdict,
  Milestone,
  RhythmClass,
  UserClass,
} from '../../lib/fingerprint';
import { MIN_PROMPTS_FOR_CLASS } from '../../lib/fingerprint';
import { Nothing, SectionTitle } from './parts';
import { className } from './palette';
import { dayLabel, group, monthLabel, pct } from './format';
import { nextMilestone } from './geometry';
import type { Visibility } from './types';

/**
 * 🏁 milestones and 🧭 class history — the two dated lists.
 *
 * Both are reverse-chronological, because the question a reader has is "what
 * happened recently", and both omit rather than pad: a milestone with no
 * rarity shows no rarity (below 100 active users "top 5%" is one person), and
 * a month too quiet to classify shows the evidence instead of a verdict.
 */

const ROW = 'grid items-center gap-2.5 border-b border-[#12151d] py-2 font-mono text-[13px] last:border-0';

const RARITY_WORDS = {
  common: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  legendary: 'legendary',
} as const;

function rarityNote(milestone: Milestone): string {
  if (!milestone.rarity) return '';
  return `${RARITY_WORDS[milestone.rarity.tier]} · ${pct(milestone.rarity.sharePct)} of users`;
}

interface MilestonesProps {
  milestones: Milestone[];
  /** For the progress bar on what comes next. */
  totals: { prompts: number; lines: number; ultrathink: number };
  ratePerWeek: { prompts: number; lines: number; ultrathink: number };
  visibility: Visibility | null;
}

export const Milestones: FC<MilestonesProps> = ({
  milestones,
  totals,
  ratePerWeek,
  visibility,
}) => {
  // The payload is oldest-first so the dates read as a walk forward; the list
  // is newest-first so the most recent thing is the first thing read.
  const rows = [...milestones].reverse();
  const next = nextMilestone(totals, ratePerWeek);
  const anyRarity = milestones.some((milestone) => milestone.rarity);

  return (
    <div class="flex flex-col gap-3.5">
      <SectionTitle
        title="🏁 milestones"
        section="milestones"
        isPublic={visibility?.milestones}
        aside={anyRarity ? undefined : <span class="text-fp-faint text-[12px]">rarity unlocks at 100 users</span>}
      />

      <div class="flex grow flex-col rounded-2xl border border-fp-border bg-fp-card px-4 py-3 sm:px-6">
        {rows.length === 0 ? (
          <Nothing>no milestones crossed yet</Nothing>
        ) : (
          rows.map((milestone) => (
            <div
              key={milestone.key}
              class={`${ROW} grid-cols-[22px_minmax(0,1fr)_auto] sm:grid-cols-[82px_26px_minmax(0,1fr)_auto]`}
            >
              <span class="hidden font-mono text-[12px] text-fp-faint sm:block">
                {dayLabel(milestone.date)}
              </span>
              <span aria-hidden="true">{milestone.emoji}</span>
              <span class={milestone.kind === 'ultrathink' ? 'fp-rainbow font-extrabold' : 'text-fp-text'}>
                {milestone.label}
              </span>
              <span class="font-mono text-[11px] text-fp-faint sm:text-[12px]">
                <span class="sm:hidden">{dayLabel(milestone.date, false)}</span>
                <span class="hidden sm:inline">{rarityNote(milestone)}</span>
              </span>
            </div>
          ))
        )}

        {next && (
          <div class="flex flex-wrap items-center justify-between gap-3 pt-3 font-mono text-[12px] text-fp-dim">
            <span>
              next · <span class="text-fp-text">{next.emoji} {next.label}</span>
              {next.weeksAway !== null &&
                ` — ~${next.weeksAway} week${next.weeksAway === 1 ? '' : 's'} at your pace`}
            </span>
            <div
              class="h-1.5 w-full rounded-full bg-fp-line sm:w-40"
              role="img"
              aria-label={`${pct(next.progressPct)} of the way to ${next.label}`}
            >
              <div
                class="h-1.5 rounded-full bg-cyan-300"
                style={`width:${Math.min(100, Math.max(2, next.progressPct)).toFixed(1)}%`}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// 🧭 class history
// ═══════════════════════════════════════════════════════════════════════════

/** The hours a rhythm is read from, in the words the evidence line uses. */
const RHYTHM_WINDOWS: Record<RhythmClass, string> = {
  'night-owl': 'after 22h',
  'early-bird': '05h–08h',
  morning: 'before noon',
  afternoon: '12h–17h',
  evening: '17h–22h',
};

/**
 * Why this month came out the way it did, from the evidence the payload
 * carries for the CURRENT month.
 *
 * Earlier months carry a verdict and no evidence (ClassVerdict is month,
 * rhythm and style), so their rows show the class alone. That is a gap in the
 * payload rather than a design choice — see the hand-off note in the track
 * report.
 */
function evidenceLine(userClass: UserClass): string {
  const parts: string[] = [];
  const rhythm = userClass.rhythm;

  if (rhythm) {
    parts.push(`${pct(userClass.rhythm_evidence.shares[rhythm])} ${RHYTHM_WINDOWS[rhythm]}`);
  }

  if (userClass.style === 'orchestrator') {
    parts.push(`${pct(userClass.style_evidence.subagentSharePct)} via subagents`);
  } else if (userClass.style) {
    parts.push(`${userClass.style_evidence.toolCallsPerPrompt.toFixed(1)} tool calls/prompt`);
  }

  if (parts.length === 0) {
    return `${group(userClass.style_evidence.prompts)} prompts this month · ` +
      `${MIN_PROMPTS_FOR_CLASS} needed to call it`;
  }

  return parts.join(' · ');
}

const ClassRow: FC<{ verdict: ClassVerdict; why?: string }> = ({ verdict, why }) => {
  const name = className(verdict.rhythm, verdict.style);

  return (
    <div class="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2.5 border-b border-[#12151d] py-[7px] last:border-0">
      <span class="font-mono text-[12px] text-fp-faint">{monthLabel(verdict.month)}</span>
      <div class="flex flex-col gap-0.5">
        <span class="font-mono text-[14px] font-bold text-fp-text">
          {name ? (
            <>
              {name.emoji} {name.rhythm} <span class="text-magenta-400">{name.style}</span>
            </>
          ) : (
            <span class="text-fp-dim">too quiet to call</span>
          )}
        </span>
        {why && <span class="font-mono text-[11px] text-fp-faint">{why}</span>}
      </div>
    </div>
  );
};

export const ClassHistory: FC<{ userClass: UserClass; visibility: Visibility | null }> = ({
  userClass,
  visibility,
}) => (
  <div class="flex flex-col gap-3.5">
    <SectionTitle title="🧭 class history" section="class" isPublic={visibility?.class} />
    <div class="flex grow flex-col rounded-2xl border border-fp-border bg-fp-card px-4 py-3 sm:px-6">
      <ClassRow
        verdict={{ month: userClass.month, rhythm: userClass.rhythm, style: userClass.style }}
        why={evidenceLine(userClass)}
      />
      {userClass.history.map((verdict) => (
        <ClassRow key={verdict.month} verdict={verdict} />
      ))}
      {userClass.history.length === 0 && (
        <span class="pt-2 font-mono text-[11px] text-fp-faint">
          one month so far · the class is recomputed every month from the rows behind it
        </span>
      )}
    </div>
  </div>
);
