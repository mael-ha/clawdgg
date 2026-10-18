/**
 * A profile's worth of plausible numbers, with no ClickHouse behind it.
 *
 * Two jobs. The tests use it to assert the empty states and the geometry
 * against something shaped like a real payload, and `bun src/scripts/render-profile.ts`
 * renders it to a file so a layout change can be screenshotted at 1440 and 390
 * without a database, an account or a login.
 *
 * The numbers are INVENTED and the file says so loudly, so nobody is ever
 * tempted to quote one. What matters is the shape: every optional section
 * present, a language mix with a long tail, four model families with versions,
 * an hour curve with a real peak, and a year with a gap in it.
 */

import type { FingerprintData, FingerprintSection } from '../../lib/fingerprint';
import type { ContributionDay } from './geometry';
import { bucketLabel } from '../../lib/chart-buckets';
import type { CurveView } from './curve';
import type { OwnerData, PlanData, ProfilePageProps } from './types';

/** A deterministic 0–1, so a screenshot diff is a real diff. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const HOUR_SHAPE = [
  0.08, 0.04, 0.02, 0.02, 0.02, 0.03, 0.08, 0.2, 0.45, 0.75, 0.95, 1,
  0.8, 0.55, 0.7, 0.85, 0.8, 0.65, 0.45, 0.35, 0.42, 0.5, 0.4, 0.2,
];
const WEEKDAY_SHAPE = [1, 1.06, 1.1, 1.04, 0.86, 0.36, 0.3];

export const FIXTURE_TODAY = '2026-10-18';

export function fixtureFingerprint(): FingerprintData {
  const prompts = 9_975;
  const hours = HOUR_SHAPE.map((factor) => Math.round((factor * prompts) / 12.1));
  const weekdays = WEEKDAY_SHAPE.map((factor) => Math.round((factor * prompts) / 5.72));

  const languages = [
    { name: 'TypeScript', value: 46_200, share: 46 },
    { name: 'Ruby', value: 22_100, share: 22 },
    { name: 'Markdown', value: 14_050, share: 14 },
    { name: 'Python', value: 9_040, share: 9 },
    { name: 'Shell', value: 5_020, share: 5 },
    { name: 'SQL', value: 4_010, share: 4 },
  ];

  const models = [
    {
      family: 'Opus',
      value: 20_682,
      share: 54,
      versions: [
        { name: 'Opus 5.5', value: 14_554, share: 70.4 },
        { name: 'Opus 5', value: 4_596, share: 22.2 },
        { name: 'Opus 4.8', value: 1_532, share: 7.4 },
      ],
    },
    {
      family: 'Fable',
      value: 8_043,
      share: 21,
      versions: [
        { name: 'Fable 5.1', value: 5_745, share: 71.4 },
        { name: 'Fable 5', value: 2_298, share: 28.6 },
      ],
    },
    {
      family: 'Sonnet',
      value: 7_277,
      share: 19,
      versions: [{ name: 'Sonnet 5.5', value: 7_277, share: 100 }],
    },
    {
      family: 'Haiku',
      value: 2_298,
      share: 6,
      versions: [{ name: 'Haiku 5.5', value: 2_298, share: 100 }],
    },
  ];

  return {
    username: 'fixture-user',
    timezone: 'Europe/Paris',
    generatedAt: `${FIXTURE_TODAY}T09:14:00.000Z`,
    sections: [
      'value',
      'anatomy',
      'conversation',
      'rings',
      'class',
      'milestones',
      'ultrathink',
    ],
    hidden: [],
    value: {
      thisWeek: 1_284.4,
      lastWeek: 1_146.8,
      deltaPct: 12,
      allTime: 38_300,
      weekStart: '2026-10-12T22:00:00.000Z',
    },
    anatomy: {
      allTime: {
        prompts,
        medianPromptChars: 170,
        toolCallsPerPrompt: 9.6,
        linesPerPrompt: 36,
        valuePerPrompt: 1.13,
      },
      last30d: {
        prompts: 1_480,
        medianPromptChars: 184,
        toolCallsPerPrompt: 11.2,
        linesPerPrompt: 41,
        valuePerPrompt: 1.31,
      },
    },
    conversation: {
      charsTyped: 3_700_000,
      outputTokens: 139_500_000,
      approxOutputChars: 558_000_000,
      ratio: 150.8,
      // Above the caveat threshold on purpose: a profile with a recovered
      // stretch in it is the interesting case to look at, not the clean one.
      historyDerivedCharsPct: 31.4,
    },
    rings: {
      hours,
      weekdays,
      peakHour: { hour: 11, share: 12.4 },
      busiestDay: { weekday: 2, share: 19.2 },
      weekdayShare: 86.4,
      languages,
      topLanguage: languages[0]!,
      models,
      topModel: models[0]!,
    },
    class: {
      month: '2026-10',
      rhythm: 'morning',
      style: 'orchestrator',
      rhythm_evidence: {
        shares: {
          'night-owl': 6.2,
          'early-bird': 4.1,
          morning: 38.4,
          afternoon: 30.1,
          evening: 21.2,
        },
        density: {
          'night-owl': 0.21,
          'early-bird': 0.33,
          morning: 2.3,
          afternoon: 1.44,
          evening: 1.02,
        },
        peakHour: 11,
        prompts: 1_480,
      },
      style_evidence: { subagentSharePct: 34.2, toolCallsPerPrompt: 11.2, prompts: 1_480 },
      history: [
        { month: '2026-09', rhythm: 'night-owl', style: 'autopilot' },
        { month: '2026-08', rhythm: 'morning', style: 'orchestrator' },
        { month: '2026-07', rhythm: 'afternoon', style: 'pair-programmer' },
        { month: '2026-06', rhythm: 'morning', style: 'autopilot' },
        { month: '2026-05', rhythm: null, style: null },
      ],
    },
    milestones: [
      { key: 'joined', label: 'joined clawd.gg', emoji: '👋', kind: 'model', date: '2025-11-10', value: 0 },
      { key: 'model:fable', label: 'first Fable session', emoji: '✨', kind: 'model', date: '2025-12-02', value: 0 },
      { key: 'prompts:1000', label: '1K prompts', emoji: '💬', kind: 'prompts', date: '2026-01-18', value: 1_000 },
      { key: 'ultrathink:100', label: '100 ultrathinks', emoji: '🌈', kind: 'ultrathink', date: '2026-02-04', value: 100 },
      { key: 'streak:7', label: '7-day streak', emoji: '🔥', kind: 'streak', date: '2026-02-19', value: 7 },
      { key: 'lines:100000', label: '100K lines written', emoji: '📝', kind: 'lines', date: '2026-03-22', value: 100_000 },
      { key: 'prompts:10000', label: '10K prompts', emoji: '💬', kind: 'prompts', date: '2026-07-08', value: 10_000 },
      { key: 'ultrathink:1000', label: '1K ultrathinks', emoji: '🌈', kind: 'ultrathink', date: '2026-09-14', value: 1_000 },
      { key: 'streak:30', label: '30-day streak', emoji: '🔥', kind: 'streak', date: '2026-09-30', value: 30 },
    ],
    ultrathink: { count: 4_941, sharePct: 49.5, firstSeen: '2026-01-24' },
  };
}

/** A year with a weekend rhythm, a recovered stretch and a quiet summer. */
export function fixtureYear(): ContributionDay[] {
  const random = seeded(11);
  const days: ContributionDay[] = [];
  const todayMs = Date.parse(`${FIXTURE_TODAY}T00:00:00Z`);

  for (let back = 370; back >= 0; back--) {
    const ms = todayMs - back * 86_400_000;
    const date = new Date(ms).toISOString().slice(0, 10);
    const weekday = (new Date(ms).getUTCDay() + 6) % 7;
    const weekend = weekday >= 5;

    // Before mid-November 2025 there is nothing: the account did not exist.
    if (ms < Date.parse('2025-11-10T00:00:00Z')) continue;
    // A fortnight off in August.
    if (date >= '2026-08-03' && date <= '2026-08-16') continue;
    if (random() > (weekend ? 0.45 : 0.9)) continue;

    const prompts = Math.round((weekend ? 6 : 24) * (0.4 + random()));
    days.push({
      date,
      prompts,
      value: prompts * 1.13 * (0.6 + random()),
      lines: prompts * 36,
      ultrathinks: Math.round(prompts * 0.49),
      // The window the history was recovered from rather than measured.
      estimated: date >= '2026-01-24' && date <= '2026-03-06',
    });
  }

  return days;
}

export function fixtureCurve(): CurveView {
  const random = seeded(23);
  const points = Array.from({ length: 52 }, (_, index) => {
    const monday = new Date(Date.parse(`${FIXTURE_TODAY}T00:00:00Z`) - (51 - index) * 7 * 86_400_000);
    const key = monday.toISOString().slice(0, 10);
    return {
      key,
      // The same label the endpoint would send, so a screenshot shows the axis
      // the way a reader sees it rather than a row of ISO dates.
      label: bucketLabel(key, 'week'),
      value: Math.max(80, 560 + Math.sin(index / 7) * 220 + index * 6 + (random() - 0.5) * 380),
      estimatedShare: index >= 15 && index <= 21 ? 1 : 0,
    };
  });

  const total = points.reduce((sum, point) => sum + point.value, 0);
  const best = points.reduce((top, point) => (point.value > top.value ? point : top), points[0]!);

  return {
    metric: 'value',
    period: '1y',
    groupBy: 'week',
    points,
    summary: {
      total,
      average: total / points.length,
      best,
      estimatedBuckets: points.filter((point) => point.estimatedShare > 0.5).length,
    },
  };
}

export function fixturePlan(): PlanData {
  const now = Math.floor(Date.parse(`${FIXTURE_TODAY}T09:14:00Z`) / 1000);
  const week = 7 * 86_400;
  const random = seeded(31);

  const cycle = (index: number, peak: number, fraction: number) => {
    const from = now - (3 - index) * week - week * fraction;
    const steps = Math.max(2, Math.round(28 * fraction));
    let accumulated = 0;
    const weights = Array.from({ length: steps }, () => 0.6 + 0.8 * random());
    const sum = weights.reduce((total, weight) => total + weight, 0);
    const samples = weights.map((weight, step) => {
      accumulated += weight;
      return {
        at: from + ((step + 1) / steps) * week * fraction,
        pct: (accumulated / sum) * peak,
      };
    });
    return { from, to: samples[samples.length - 1]!.at, peakPct: peak, samples, current: false };
  };

  const cycles = [
    cycle(0, 81, 1),
    cycle(1, 96, 1),
    cycle(2, 73, 1),
    { ...cycle(3, 62, 0.64), current: true },
  ];

  return {
    weekly: { usedPercentage: 62, resetsAt: now + 2 * 86_400 + 4 * 3_600, capturedAt: now },
    session: { usedPercentage: 18, resetsAt: now + 2 * 3_600 + 26 * 60, capturedAt: now },
    cycles,
    projectedPct: 94,
  };
}

export function fixtureOwner(): OwnerData {
  return {
    visibility: {
      value: true,
      anatomy: true,
      conversation: true,
      rings: true,
      class: true,
      milestones: true,
      curve: true,
      year: true,
      ultrathink: true,
      plan: true,
    },
    plan: fixturePlan(),
    today: {
      prompts: 142,
      value: 214.6,
      lines: 3_120,
      ultrathinks: 71,
      lastEventAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    },
    pipeline: {
      lastLiveEventAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      devices: 2,
      ultrathinkHook: true,
      cliVersion: '2.0.1',
      importedFrom: '2025-09-29',
      importedTo: '2026-03-06',
    },
  };
}

export interface FixtureOptions {
  /** The owner layer, or a visitor's view without it. */
  owner?: boolean;
  /** Strip every section, as a profile its owner has taken down. */
  takenDown?: boolean;
  /** Keep the shape and empty every figure, as a brand-new account. */
  empty?: boolean;
  /**
   * Sections to hide, exactly as the API would: omitted from the payload and
   * listed in `hidden`. This is how the leak test asks for "a visitor's page
   * with `value` turned off".
   */
  hide?: FingerprintSection[];
}

/** The payload, minus the sections `hide` names — what the API would send. */
function applyHidden(data: FingerprintData, hide: readonly FingerprintSection[]): FingerprintData {
  const next: FingerprintData = {
    ...data,
    sections: data.sections.filter((section) => !hide.includes(section)),
    hidden: [...hide],
  };
  for (const section of hide) {
    delete next[section as keyof FingerprintData & keyof typeof next];
  }
  return next;
}

export function fixtureProfile(options: FixtureOptions = {}): ProfilePageProps & {
  curve: CurveView | null;
} {
  const base = options.empty ? emptyFingerprint() : fixtureFingerprint();
  const hide = options.takenDown
    ? [...base.sections]
    : options.hide ?? [];
  const fingerprint = applyHidden(base, hide);
  // A visitor's payload has no zone at all — see FingerprintData.timezone.
  if (!options.owner) delete fingerprint.timezone;

  const blank = options.empty || options.takenDown;

  return {
    fingerprint,
    identity: {
      username: fingerprint.username,
      avatarUrl: null,
      joinedOn: blank ? null : '2025-11-10',
      // Straight off the payload, which carries the zone for the owner only.
      timezone: fingerprint.timezone ?? null,
      timezoneAssumed: base.timezone === 'UTC',
    },
    year:
      blank || hide.includes('year')
        ? null
        : {
            days: fixtureYear(),
            today: FIXTURE_TODAY,
            currentStreak: 19,
            longestStreak: 32,
          },
    owner: options.owner ? fixtureOwner() : null,
    publicPlan: options.owner || blank || hide.includes('plan') ? null : fixturePlan(),
    curve: blank || hide.includes('curve') ? null : fixtureCurve(),
    shareUrl: `https://clawd.gg/u/${fingerprint.username}`,
  };
}

/** Every section present and every figure zero: the day someone signs up. */
export function emptyFingerprint(): FingerprintData {
  const zeroFigures = {
    prompts: 0,
    medianPromptChars: 0,
    toolCallsPerPrompt: 0,
    linesPerPrompt: 0,
    valuePerPrompt: 0,
  };

  return {
    username: 'brand-new',
    timezone: 'UTC',
    generatedAt: `${FIXTURE_TODAY}T09:14:00.000Z`,
    sections: [
      'value',
      'anatomy',
      'conversation',
      'rings',
      'class',
      'milestones',
      'ultrathink',
    ],
    hidden: [],
    value: { thisWeek: 0, lastWeek: 0, deltaPct: null, allTime: 0, weekStart: `${FIXTURE_TODAY}T00:00:00.000Z` },
    anatomy: { allTime: { ...zeroFigures }, last30d: { ...zeroFigures } },
    conversation: {
      charsTyped: 0,
      outputTokens: 0,
      approxOutputChars: 0,
      ratio: null,
      historyDerivedCharsPct: 0,
    },
    rings: {
      hours: Array<number>(24).fill(0),
      weekdays: Array<number>(7).fill(0),
      peakHour: null,
      busiestDay: null,
      weekdayShare: 0,
      languages: [],
      topLanguage: null,
      models: [],
      topModel: null,
    },
    class: {
      month: '2026-10',
      rhythm: null,
      style: null,
      rhythm_evidence: {
        shares: { 'night-owl': 0, 'early-bird': 0, morning: 0, afternoon: 0, evening: 0 },
        density: { 'night-owl': 0, 'early-bird': 0, morning: 0, afternoon: 0, evening: 0 },
        peakHour: null,
        prompts: 0,
      },
      style_evidence: { subagentSharePct: 0, toolCallsPerPrompt: 0, prompts: 0 },
      history: [],
    },
    milestones: [],
    ultrathink: { count: 0, sharePct: 0, firstSeen: null },
  };
}
