import type { FC } from 'hono/jsx';
import { Anatomy, ConversationBlock, Header, RingsBlock } from './Fingerprint';
import { Activity } from './Activity';
import { Year } from './Year';
import { ClassHistory, Milestones } from './Milestones';
import { OwnerLayer, Plan } from './Owner';
import { Nothing } from './parts';
import { group } from './format';
import type { CurveView } from './curve';
import type { ProfilePageProps } from './types';

/**
 * The profile, top to bottom.
 *
 * A PURE FUNCTION of ProfilePageProps — nothing below here reads a database,
 * the clock or the environment — so the whole page renders from a fixture (see
 * ./fixture.ts) and every empty state is a unit test rather than a surprise.
 *
 * The order is an argument: WHO this person is, what ONE prompt of theirs
 * looks like, WHEN and with WHAT they work, how lopsided the conversation is,
 * then the history (activity, the year, milestones, the class), and last the
 * owner's own instruments. A reader who stops after the first screen has the
 * whole fingerprint.
 *
 * A section the owner has hidden is ABSENT from the payload, so it is absent
 * here: `{fingerprint.rings && …}` is the whole access-control story, and
 * there is no branch that could render a zero in place of a hidden figure.
 */

export interface ProfileViewProps extends ProfilePageProps {
  /** Null when the owner has hidden ⚡ activity, or there is nothing to plot. */
  curve: CurveView | null;
}

export const ProfilePage: FC<ProfileViewProps> = ({
  fingerprint,
  identity,
  year,
  owner,
  publicPlan,
  curve,
  shareUrl,
}) => {
  const visibility = owner?.visibility ?? null;
  const prompts = fingerprint.anatomy?.allTime.prompts ?? 0;

  const hasData =
    prompts > 0 ||
    (fingerprint.value?.allTime ?? 0) > 0 ||
    (fingerprint.conversation?.charsTyped ?? 0) > 0 ||
    (fingerprint.rings?.hours.some((count) => count > 0) ?? false);

  // Nothing is hidden and nothing is here: this is a new account, not a locked
  // one, and the page should say which.
  const everythingHidden = fingerprint.sections.length === 0;

  // The pace behind "next milestone": the last 30 days, as a week.
  const perWeek = (over30d: number) => (over30d * 7) / 30;
  const last30d = fingerprint.anatomy?.last30d;

  return (
    <div class="min-h-screen bg-fp-ground">
      <div class="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-6 sm:gap-[26px] sm:px-8 lg:px-16 lg:py-11">
        <Header
          username={identity.username}
          avatarUrl={identity.avatarUrl}
          userClass={fingerprint.class}
          ultrathink={fingerprint.ultrathink}
          value={fingerprint.value}
          visibility={visibility}
        />

        {everythingHidden ? (
          <div class="rounded-2xl border border-fp-border bg-fp-card px-6 py-10 text-center">
            <p class="m-0 font-mono text-[14px] text-fp-dim">
              🔒 @{identity.username} has taken this profile down.
            </p>
          </div>
        ) : !hasData ? (
          <div class="flex flex-col items-center gap-3 rounded-2xl border border-fp-border bg-fp-card px-6 py-10 text-center">
            <p class="m-0 font-mono text-[14px] text-fp-dim">
              🌱 nothing measured yet — this profile fills in as Claude Code runs.
            </p>
            <p class="m-0 font-mono text-[12px] text-fp-faint">
              <span class="text-cyan-400">clawdgg setup</span> turns the telemetry on;{' '}
              <span class="text-cyan-400">clawdgg import</span> recovers what has already happened.
            </p>
          </div>
        ) : (
          <>
            {fingerprint.anatomy && (
              <Anatomy
                anatomy={fingerprint.anatomy}
                // The median prompt length is built on the same characters the
                // conversation counts, so it carries the same caveat — but
                // only when `conversation` is in this payload to say so.
                historyDerivedCharsPct={fingerprint.conversation?.historyDerivedCharsPct}
                visibility={visibility}
              />
            )}

            {fingerprint.rings && (
              <RingsBlock
                rings={fingerprint.rings}
                timezone={identity.timezone}
                visibility={visibility}
              />
            )}

            {fingerprint.conversation && (
              <ConversationBlock
                conversation={fingerprint.conversation}
                prompts={prompts}
                visibility={visibility}
              />
            )}

            {curve && (
              <Activity
                view={curve}
                visibility={visibility}
                endpoint={`/u/${identity.username}/curve`}
              />
            )}

            {year && (
              <Year
                year={year}
                joinedOn={identity.joinedOn}
                visibility={visibility}
                // A day's value and 🌈 count belong to the `value` and
                // `ultrathink` sections, so the year carries them only while
                // those are visible in THIS payload.
                fields={{
                  value: fingerprint.value !== undefined,
                  lines: fingerprint.anatomy !== undefined,
                  ultrathinks: fingerprint.ultrathink !== undefined,
                }}
              />
            )}

            {(fingerprint.milestones || fingerprint.class) && (
              <section class="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                {fingerprint.milestones && (
                  <Milestones
                    milestones={fingerprint.milestones}
                    totals={{
                      prompts,
                      lines: Math.round((fingerprint.anatomy?.allTime.linesPerPrompt ?? 0) * prompts),
                      ultrathink: fingerprint.ultrathink?.count ?? 0,
                    }}
                    ratePerWeek={{
                      prompts: perWeek(last30d?.prompts ?? 0),
                      lines: perWeek((last30d?.linesPerPrompt ?? 0) * (last30d?.prompts ?? 0)),
                      // The flag is per prompt, so its pace follows the prompt
                      // pace at the all-time share. There is no 30-day
                      // ultrathink count in the payload to do better with.
                      ultrathink:
                        (perWeek(last30d?.prompts ?? 0) *
                          (fingerprint.ultrathink?.sharePct ?? 0)) /
                        100,
                    }}
                    visibility={visibility}
                  />
                )}
                {fingerprint.class && (
                  <ClassHistory userClass={fingerprint.class} visibility={visibility} />
                )}
              </section>
            )}

            {/* A visitor sees the plan card on its own, when its owner left it
                public. For the owner it lives inside the owner layer, beside
                the two panels that are never public. */}
            {!owner && publicPlan && (
              <Plan plan={publicPlan} timezone={identity.timezone} visibility={null} />
            )}
          </>
        )}

        {owner && (
          <OwnerLayer owner={owner} timezone={identity.timezone} username={identity.username} />
        )}

        <footer class="flex flex-col items-center gap-3 border-t border-fp-line pt-5 sm:flex-row sm:justify-between">
          <span class="font-mono text-[11px] text-fp-ghost">
            {identity.timezoneAssumed && owner ? (
              <>
                every hour and weekday above is read in <span class="text-fp-dim">UTC</span> — run{' '}
                <span class="text-cyan-400">clawdgg setup</span> to use your own clock
              </>
            ) : (
              <>
                times in {identity.timezone ?? "this person's own clock"}
                {prompts > 0 ? ` · ${group(prompts)} prompts measured` : ''}
              </>
            )}
          </span>
          <div class="flex w-full items-center gap-2.5 sm:w-auto">
            <button
              type="button"
              data-share-text={shareUrl}
              class="min-h-[44px] grow rounded-xl border border-fp-edge bg-transparent px-4 font-mono text-[13px] text-fp-text transition-colors hover:border-cyan-400 sm:grow-0"
            >
              copy link
            </button>
            <a
              href={`/u/${identity.username}/card.svg`}
              class="flex min-h-[44px] grow items-center justify-center rounded-xl bg-cyan-400 px-4 font-mono text-[13px] font-extrabold text-fp-ground no-underline sm:grow-0"
            >
              share my card
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
};

export const ProfileNotFound: FC<{ username: string }> = ({ username }) => (
  <div class="flex min-h-screen items-center justify-center bg-fp-ground px-4">
    <div class="flex flex-col items-center gap-4 text-center">
      <div class="text-5xl">🤔</div>
      <h1 class="m-0 font-mono text-[21px] font-bold text-fp-text">no such profile</h1>
      <Nothing>@{username} hasn't joined clawd.gg yet</Nothing>
      <a href="/" class="font-mono text-[13px] text-cyan-400 no-underline hover:underline">
        ← back to the leaderboard
      </a>
    </div>
  </div>
);
