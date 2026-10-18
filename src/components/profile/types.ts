/**
 * Everything ProfilePage renders, as one plain object.
 *
 * The page is a PURE FUNCTION of this type: no component below here reaches
 * for a database, the clock or `process.env`. That is what lets the whole
 * profile be rendered from a fixture — see src/components/profile/fixture.ts —
 * so a layout change can be screenshotted without a ClickHouse, and the empty
 * states can be asserted in a unit test instead of discovered in production.
 */

import type { FingerprintData, FingerprintSection } from '../../lib/fingerprint';
import type { ContributionDay } from './geometry';

export interface ProfileIdentity {
  username: string;
  avatarUrl: string | null;
  /** Local date this person's history starts, YYYY-MM-DD. */
  joinedOn: string | null;
  /**
   * The IANA zone every hour and weekday on the page was read in — OWNER ONLY,
   * and null for everybody else.
   *
   * A zone name is location data: "Europe/Paris" on a public page tells a
   * stranger roughly where someone lives, which is not a thing they opted into
   * by having a profile. A visitor is told the figures are in this person's own
   * clock and not which clock that is; the ARITHMETIC is unaffected, because it
   * happened server-side before the payload was built.
   */
  timezone: string | null;
  /**
   * True when `users.timezone` is still the default. Every hour, weekday and
   * week on the page is then UTC, and the owner is told so — a peak hour in
   * the wrong zone is wrong by the offset and looks like someone else's day.
   */
  timezoneAssumed: boolean;
}

/**
 * Which per-day figures the contribution graph may put in the DOM.
 *
 * The year has its own toggle, but the figures ON a day belong to other
 * sections: a day's API-equivalent value is the `value` section's number and a
 * day's 🌈 count is the `ultrathink` section's. Hiding `value` and leaving the
 * year public must not publish 371 daily values in data attributes — a hidden
 * section has to be absent from the HTML, not just from the rendered text.
 */
export interface YearFields {
  value: boolean;
  lines: boolean;
  ultrathinks: boolean;
}

export interface YearData {
  /** One entry per day WITH activity. Gaps are gaps, never zero-filled rows. */
  days: ContributionDay[];
  /** Local today, YYYY-MM-DD — the grid's right-hand edge. */
  today: string;
  /** From users.current_streak / longest_streak, the site's one definition. */
  currentStreak: number;
  longestStreak: number;
}

export interface PlanWindow {
  /** 0–100. */
  usedPercentage: number;
  /** Unix epoch seconds, or null when Claude Code omitted it. */
  resetsAt: number | null;
  capturedAt: number;
}

export interface PlanCycle {
  /** The cycle's first and last sample, as unix epoch seconds. */
  from: number;
  to: number;
  peakPct: number;
  /** Every sample in the cycle, oldest first: the sawtooth's teeth. */
  samples: { at: number; pct: number }[];
  /** True for the cycle still running. */
  current: boolean;
}

export interface PlanData {
  /** The seven-day window. */
  weekly: PlanWindow | null;
  /** The five-hour window. */
  session: PlanWindow | null;
  /** Up to four cycles, oldest first. */
  cycles: PlanCycle[];
  /**
   * Where the weekly window lands if the rest of it goes like the part so far,
   * or null when the window's boundaries are unknown.
   */
  projectedPct: number | null;
}

export interface TodayData {
  prompts: number;
  value: number;
  lines: number;
  ultrathinks: number;
  /** ISO instant of the most recent event, live or not. */
  lastEventAt: string | null;
}

export interface PipelineData {
  /** ISO instant of the last `live` row — the silent-drop heartbeat. */
  lastLiveEventAt: string | null;
  /** Active CLI bearer tokens. */
  devices: number;
  /** Whether the ultrathink hook has ever reported. */
  ultrathinkHook: boolean;
  /** The newest `app_version` seen, when any row carried one. */
  cliVersion: string | null;
  /** The span recovered from transcripts and the pre-OTEL summary. */
  importedFrom: string | null;
  importedTo: string | null;
}

export type Visibility = Record<FingerprintSection, boolean>;

export interface OwnerData {
  /** What a VISITOR sees — `true` means public. */
  visibility: Visibility;
  plan: PlanData | null;
  today: TodayData | null;
  pipeline: PipelineData | null;
}

export interface ProfilePageProps {
  fingerprint: FingerprintData;
  identity: ProfileIdentity;
  /** Null when the owner has hidden the year, or there is nothing to draw. */
  year: YearData | null;
  /** Non-null only when the viewer owns this profile. */
  owner: OwnerData | null;
  /** The plan card for a visitor, when its owner has left it public. */
  publicPlan: PlanData | null;
  /** Where this profile lives, for the share button. */
  shareUrl: string;
}
