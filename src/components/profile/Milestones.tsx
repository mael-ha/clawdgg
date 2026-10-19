import type { FC } from 'hono/jsx';
import type {
  Milestone,
  MilestoneKind,
  NextMilestone,
  PastVerdict,
  RhythmClass,
  UserClass,
} from '../../lib/fingerprint';
import { MIN_PROMPTS_FOR_CLASS } from '../../lib/fingerprint';
import { Nothing, SectionTitle } from './parts';
import { className } from './palette';
import { dayLabel, group, monthLabel, pct } from './format';
import { pickNextMilestone } from './geometry';
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
  /** The unfinished ladders, one entry each — hidden with `milestones`. */
  nextMilestones: NextMilestone[];
  /** The pace behind the forecast, for the kinds the page has one for. */
  ratePerWeek: Partial<Record<MilestoneKind, number>>;
  visibility: Visibility | null;
}

export const Milestones: FC<MilestonesProps> = ({
  milestones,
  nextMilestones,
  ratePerWeek,
  visibility,
}) => {
  // The payload is oldest-first so the dates read as a walk forward; the list
  // is newest-first so the most recent thing is the first thing read.
  const rows = [...milestones].reverse();
  const next = pickNextMilestone(nextMilestones, ratePerWeek);
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
 * Why a month came out the way it did, from the evidence beside its verdict.
 *
 * EVERY row gets one, this month's and August's alike: a class a reader cannot
 * check is a horoscope. The evidence is optional on PastVerdict only because
 * older payloads were built without it (see the type), and absence returns
 * undefined so the row shows the class alone rather than an invented reason.
 */
function evidenceLine(verdict: PastVerdict): string | undefined {
  const rhythmEvidence = verdict.rhythm_evidence;
  const styleEvidence = verdict.style_evidence;
  if (!rhythmEvidence || !styleEvidence) return undefined;

  const parts: string[] = [];
  const rhythm = verdict.rhythm;

  if (rhythm) {
    parts.push(`${pct(rhythmEvidence.shares[rhythm])} ${RHYTHM_WINDOWS[rhythm]}`);
  }

  if (verdict.style === 'orchestrator') {
    parts.push(`${pct(styleEvidence.subagentSharePct)} via subagents`);
  } else if (verdict.style) {
    parts.push(`${styleEvidence.toolCallsPerPrompt.toFixed(1)} tool calls/prompt`);
  }

  if (parts.length === 0) {
    return `${group(styleEvidence.prompts)} prompts this month · ` +
      `${MIN_PROMPTS_FOR_CLASS} needed to call it`;
  }

  return parts.join(' · ');
}

const ClassRow: FC<{ verdict: PastVerdict }> = ({ verdict }) => {
  const name = className(verdict.rhythm, verdict.style);
  const why = evidenceLine(verdict);

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
      <ClassRow verdict={userClass} />
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
