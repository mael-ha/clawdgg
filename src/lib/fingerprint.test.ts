import { describe, expect, it } from 'bun:test';
import {
  AUTOPILOT_TOOL_CALLS_PER_PROMPT,
  BUILT_SECTIONS,
  FINGERPRINT_SECTIONS,
  MIN_PROMPTS_FOR_CLASS,
  MIN_USERS_FOR_RARITY,
  ORCHESTRATOR_SUBAGENT_SHARE_PCT,
  RHYTHM_BUCKETS,
  assembleFingerprint,
  attachRarity,
  buildClassHistory,
  buildRings,
  classifyRhythm,
  classifyStyle,
  crossedMilestones,
  deltaPct,
  groupModelsByFamily,
  modelFamilyMilestones,
  rarityTier,
  ratioOfSums,
  splitModelName,
  withShares,
  type DailyPoint,
  type RhythmClass,
} from './fingerprint';

/** 24 zeroed hour buckets, with the given hours filled in. */
function hours(filled: Record<number, number>): number[] {
  const out = Array<number>(24).fill(0);
  for (const [hour, count] of Object.entries(filled)) out[Number(hour)] = count;
  return out;
}

describe('ratioOfSums', () => {
  it('divides totals, and reads 0 rather than NaN on an empty denominator', () => {
    expect(ratioOfSums(325_000, 33_800)).toBeCloseTo(9.615, 3);
    expect(ratioOfSums(0, 0)).toBe(0);
    expect(ratioOfSums(10, 0)).toBe(0);
  });

  // The whole point of ratio-of-sums: it must equal total ÷ total, never the
  // average of the per-day ratios, which is a different and unreconcilable
  // number.
  it('is not the average of per-row ratios', () => {
    const days = [
      { tools: 100, prompts: 1 },
      { tools: 1, prompts: 100 },
    ];
    const ofSums = ratioOfSums(
      days.reduce((s, d) => s + d.tools, 0),
      days.reduce((s, d) => s + d.prompts, 0)
    );
    const ofRatios = days.reduce((s, d) => s + d.tools / d.prompts, 0) / days.length;
    expect(ofSums).toBeCloseTo(1, 10);
    expect(ofRatios).toBeCloseTo(50.005, 3);
  });
});

describe('deltaPct', () => {
  it('reports the week-on-week change', () => {
    expect(deltaPct(120, 100)).toBeCloseTo(20, 10);
    expect(deltaPct(80, 100)).toBeCloseTo(-20, 10);
  });

  // A percentage against nothing is either Infinity or an invented "+100%".
  it('is null when last week was zero', () => {
    expect(deltaPct(50, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
  });
});

describe('withShares', () => {
  it('produces shares that sum to 100', () => {
    const shared = withShares([{ value: 1 }, { value: 3 }]);
    expect(shared.map((s) => s.share)).toEqual([25, 75]);
  });

  it('gives every share as 0 when nothing happened', () => {
    expect(withShares([{ value: 0 }, { value: 0 }]).map((s) => s.share)).toEqual([0, 0]);
    expect(withShares([])).toEqual([]);
  });
});

describe('RHYTHM_BUCKETS', () => {
  // The shares are only comparable if every hour belongs to exactly one bucket.
  it('partitions the 24 hours exactly once each', () => {
    const all = Object.values(RHYTHM_BUCKETS).flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 24 }, (_, h) => h));
  });
});

describe('classifyRhythm', () => {
  const spread = (hoursOfDay: number[], each: number) =>
    hours(Object.fromEntries(hoursOfDay.map((h) => [h, each])));

  it.each([
    ['night-owl', RHYTHM_BUCKETS['night-owl']],
    ['early-bird', RHYTHM_BUCKETS['early-bird']],
    ['morning', RHYTHM_BUCKETS.morning],
    ['afternoon', RHYTHM_BUCKETS.afternoon],
    ['evening', RHYTHM_BUCKETS.evening],
  ] as [RhythmClass, number[]][])('calls someone working only %s hours that', (expected, bucket) => {
    expect(classifyRhythm(spread(bucket, 10)).rhythm).toBe(expected);
  });

  // Density, not raw share: night spans 7 hours and early morning 3, so the
  // widest bucket would otherwise win almost every time.
  it('prefers the denser bucket over the one with the larger raw share', () => {
    // 40 prompts spread over the 7 night hours, 30 over the 3 early hours.
    const counts = hours({
      22: 6, 23: 6, 0: 6, 1: 6, 2: 6, 3: 5, 4: 5, // 40 across 7 hours
      5: 10, 6: 10, 7: 10,                        // 30 across 3 hours
    });
    const { rhythm, evidence } = classifyRhythm(counts);
    expect(evidence.shares['night-owl']).toBeGreaterThan(evidence.shares['early-bird']);
    expect(evidence.density['early-bird']).toBeGreaterThan(evidence.density['night-owl']);
    expect(rhythm).toBe('early-bird');
  });

  it('reports the peak hour and the sample it judged', () => {
    const { evidence } = classifyRhythm(hours({ 9: 5, 14: 40, 15: 5 }));
    expect(evidence.peakHour).toBe(14);
    expect(evidence.prompts).toBe(50);
  });

  it('refuses to classify a sample too small to mean anything', () => {
    const thin = classifyRhythm(hours({ 3: MIN_PROMPTS_FOR_CLASS - 1 }));
    expect(thin.rhythm).toBeNull();
    // The evidence is still returned, so the UI can say how close it is.
    expect(thin.evidence.prompts).toBe(MIN_PROMPTS_FOR_CLASS - 1);

    const enough = classifyRhythm(hours({ 3: MIN_PROMPTS_FOR_CLASS }));
    expect(enough.rhythm).toBe('night-owl');
  });

  it('classifies nothing at all as nothing, with no NaN in the evidence', () => {
    const { rhythm, evidence } = classifyRhythm(hours({}));
    expect(rhythm).toBeNull();
    expect(evidence.peakHour).toBeNull();
    expect(Object.values(evidence.density).every((d) => d === 0)).toBe(true);
  });
});

describe('classifyStyle', () => {
  const evidence = (subagentSharePct: number, toolCallsPerPrompt: number) => ({
    subagentSharePct,
    toolCallsPerPrompt,
    prompts: 500,
  });

  it('calls a subagent habit orchestration, however long the loops', () => {
    expect(classifyStyle(evidence(ORCHESTRATOR_SUBAGENT_SHARE_PCT, 1))).toBe('orchestrator');
    expect(classifyStyle(evidence(40, AUTOPILOT_TOOL_CALLS_PER_PROMPT + 20))).toBe('orchestrator');
  });

  it('calls long tool loops without subagents autopilot', () => {
    expect(classifyStyle(evidence(0, AUTOPILOT_TOOL_CALLS_PER_PROMPT))).toBe('autopilot');
    expect(classifyStyle(evidence(ORCHESTRATOR_SUBAGENT_SHARE_PCT - 1, 40))).toBe('autopilot');
  });

  it('calls short turns pair programming', () => {
    expect(classifyStyle(evidence(0, 2))).toBe('pair-programmer');
    expect(
      classifyStyle(
        evidence(ORCHESTRATOR_SUBAGENT_SHARE_PCT - 1, AUTOPILOT_TOOL_CALLS_PER_PROMPT - 1)
      )
    ).toBe('pair-programmer');
  });

  it('refuses a verdict on too few prompts', () => {
    expect(
      classifyStyle({ subagentSharePct: 90, toolCallsPerPrompt: 99, prompts: MIN_PROMPTS_FOR_CLASS - 1 })
    ).toBeNull();
  });
});

describe('crossedMilestones', () => {
  /** n days of `perDay` prompts starting at 2026-01-01. */
  function series(perDay: number, days: number, from = '2026-01-01'): DailyPoint[] {
    const start = Date.parse(`${from}T00:00:00Z`);
    return Array.from({ length: days }, (_, i) => ({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      prompts: perDay,
      lines: 0,
      ultrathinks: 0,
    }));
  }

  it('dates a threshold on the day the running total reaches it', () => {
    // 100/day: the 1,000th prompt is typed on day 10, 2026-01-10.
    const milestones = crossedMilestones(series(100, 20));
    const prompts1k = milestones.find((m) => m.key === 'prompts_1000');
    expect(prompts1k?.date).toBe('2026-01-10');
    expect(prompts1k?.value).toBe(1_000);
    expect(prompts1k?.label).toBe('1K prompts');
  });

  it('does not award a threshold that was never reached', () => {
    const keys = crossedMilestones(series(10, 10)).map((m) => m.key);
    expect(keys).not.toContain('prompts_1000');
  });

  it('awards every threshold crossed on the same day, on that day', () => {
    const oneBigDay: DailyPoint[] = [
      { date: '2026-02-01', prompts: 30_000, lines: 0, ultrathinks: 0 },
    ];
    const keys = crossedMilestones(oneBigDay).map((m) => m.key);
    expect(keys).toEqual(['prompts_1000', 'prompts_10000', 'prompts_25000']);
    expect(crossedMilestones(oneBigDay).every((m) => m.date === '2026-02-01')).toBe(true);
  });

  it('sorts chronologically whatever order the days arrive in', () => {
    const shuffled = [...series(600, 3)].reverse();
    const milestones = crossedMilestones(shuffled);
    expect(milestones.find((m) => m.key === 'prompts_1000')?.date).toBe('2026-01-02');
    const dates = milestones.map((m) => m.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('counts a streak in consecutive days and dates it where it lands', () => {
    const streak = crossedMilestones(series(1, 7));
    expect(streak.find((m) => m.key === 'streak_7')?.date).toBe('2026-01-07');
    expect(streak.find((m) => m.key === 'streak_7')?.label).toBe('7-day streak');
  });

  it('breaks a streak on a gap, and on a day with no prompts', () => {
    // Six days, a day off, then six more: never seven in a row.
    const broken = [...series(1, 6), ...series(1, 6, '2026-01-08')];
    expect(crossedMilestones(broken).some((m) => m.key === 'streak_7')).toBe(false);

    // A present-but-empty day is a gap too.
    const emptyDay: DailyPoint[] = series(1, 7).map((day, i) =>
      i === 3 ? { ...day, prompts: 0 } : day
    );
    expect(crossedMilestones(emptyDay).some((m) => m.key === 'streak_7')).toBe(false);
  });

  it('keeps counting a streak across a month boundary', () => {
    const across = series(1, 10, '2026-01-28');
    expect(crossedMilestones(across).find((m) => m.key === 'streak_7')?.date).toBe('2026-02-03');
  });

  it('dates line and ultrathink thresholds off their own totals', () => {
    const days: DailyPoint[] = [
      { date: '2026-03-01', prompts: 1, lines: 60_000, ultrathinks: 60 },
      { date: '2026-03-02', prompts: 1, lines: 60_000, ultrathinks: 60 },
    ];
    const milestones = crossedMilestones(days);
    expect(milestones.find((m) => m.key === 'lines_100000')?.date).toBe('2026-03-02');
    expect(milestones.find((m) => m.key === 'lines_100000')?.label).toBe('100K lines written');
    expect(milestones.find((m) => m.key === 'ultrathink_100')?.date).toBe('2026-03-02');
  });

  it('has nothing to say about no data', () => {
    expect(crossedMilestones([])).toEqual([]);
  });
});

describe('rarityTier', () => {
  it('tiers by how many people share it', () => {
    expect(rarityTier(0.5)).toBe('legendary');
    expect(rarityTier(1)).toBe('legendary');
    expect(rarityTier(4)).toBe('rare');
    expect(rarityTier(5)).toBe('rare');
    expect(rarityTier(20)).toBe('uncommon');
    expect(rarityTier(25)).toBe('uncommon');
    expect(rarityTier(60)).toBe('common');
  });
});

describe('attachRarity', () => {
  const milestones = crossedMilestones([
    { date: '2026-01-01', prompts: 30_000, lines: 2_000_000, ultrathinks: 1_500 },
  ]);
  /** 100 peers, of whom 10 have 25k+ prompts and 1 has 2M+ lines. */
  const peers = Array.from({ length: 100 }, (_, i) => ({
    prompts: i < 10 ? 30_000 : 100,
    lines: i < 1 ? 2_000_000 : 0,
    ultrathinks: 0,
  }));

  it('omits rarity entirely below the user floor', () => {
    const under = attachRarity(milestones, peers, MIN_USERS_FOR_RARITY - 1);
    expect(under.every((m) => m.rarity === undefined)).toBe(true);
    // And the milestones themselves are untouched.
    expect(under).toEqual(milestones);
  });

  it('shares a threshold against the active-user count once the floor is met', () => {
    const rated = attachRarity(milestones, peers, MIN_USERS_FOR_RARITY);
    const prompts25k = rated.find((m) => m.key === 'prompts_25000')!;
    expect(prompts25k.rarity).toEqual({ sharePct: 10, tier: 'uncommon' });

    const lines2m = rated.find((m) => m.key === 'lines_1000000')!;
    expect(lines2m.rarity).toEqual({ sharePct: 1, tier: 'legendary' });
  });

  it('rates no streak or first-model milestone, which it cannot answer', () => {
    const withStreak = [
      ...milestones,
      ...modelFamilyMilestones([{ model: 'claude-opus-5', first_day: '2026-01-01' }]),
    ];
    const rated = attachRarity(withStreak, peers, MIN_USERS_FOR_RARITY);
    expect(rated.find((m) => m.kind === 'model')!.rarity).toBeUndefined();
    expect(rated.find((m) => m.kind === 'prompts')!.rarity).toBeDefined();
  });

  it('leaves milestones alone when there are no peers to compare against', () => {
    expect(attachRarity(milestones, [], 500)).toEqual(milestones);
  });
});

describe('splitModelName', () => {
  it('splits the display name into family and version', () => {
    expect(splitModelName('claude-opus-5-5')).toEqual({ family: 'Opus', version: '5.5' });
    expect(splitModelName('claude-sonnet-4-5-20250929')).toEqual({
      family: 'Sonnet',
      version: '4.5',
    });
  });

  it('leaves an unknown id alone rather than guessing a family', () => {
    expect(splitModelName('mystery-model')).toEqual({ family: 'mystery-model', version: '' });
  });

  // The exact set observed on prod on 2026-10-18. The `[1m]` context variants
  // and the dated Haiku id are the ones a hand-rolled split gets wrong: they
  // must land on the SAME family and version as their plain spelling, or the
  // ring shows "Opus 5.5" twice and splits one habit across two slices.
  // MODEL_ID_SQL strips the bracket before these ever reach TypeScript; this
  // asserts they survive either way.
  it.each([
    ['claude-opus-5', 'Opus', '5'],
    ['claude-opus-5-5', 'Opus', '5.5'],
    ['claude-opus-5[1m]', 'Opus', '5'],
    ['claude-opus-5-5[1m]', 'Opus', '5.5'],
    ['claude-opus-4-8', 'Opus', '4.8'],
    ['claude-opus-4-8[1m]', 'Opus', '4.8'],
    ['claude-sonnet-5', 'Sonnet', '5'],
    ['claude-sonnet-5-5', 'Sonnet', '5.5'],
    ['claude-haiku-5-5', 'Haiku', '5.5'],
    ['claude-haiku-4-5-20251001', 'Haiku', '4.5'],
    ['claude-fable-5-1', 'Fable', '5.1'],
  ])('splits the live id %s into %s %s', (id, family, version) => {
    expect(splitModelName(id)).toEqual({ family, version });
  });
});

describe('groupModelsByFamily', () => {
  const rows = [
    { model: 'claude-opus-5-5', value: 60 },
    { model: 'claude-opus-5', value: 20 },
    { model: 'claude-sonnet-5-5', value: 20 },
  ];

  it('shares families against the whole and versions against their family', () => {
    const families = groupModelsByFamily(rows);
    expect(families.map((f) => f.family)).toEqual(['Opus', 'Sonnet']);

    const opus = families[0]!;
    expect(opus.value).toBe(80);
    expect(opus.share).toBeCloseTo(80, 10);
    expect(opus.versions.map((v) => v.name)).toEqual(['Opus 5.5', 'Opus 5']);
    // 60 of the family's 80, not 60 of the overall 100.
    expect(opus.versions[0]!.share).toBeCloseTo(75, 10);
    expect(opus.versions.reduce((sum, v) => sum + v.share, 0)).toBeCloseTo(100, 10);
  });

  it('ignores rows with no value, so a free model is not a family', () => {
    expect(groupModelsByFamily([{ model: 'claude-opus-5', value: 0 }])).toEqual([]);
  });
});

describe('modelFamilyMilestones', () => {
  it('dates the first use of a family from its earliest version', () => {
    const milestones = modelFamilyMilestones([
      { model: 'claude-opus-5-5', first_day: '2026-06-01' },
      { model: 'claude-opus-5', first_day: '2026-03-01' },
      { model: 'claude-sonnet-5-5', first_day: '2026-05-01' },
    ]);
    expect(milestones.map((m) => [m.key, m.date])).toEqual([
      ['model_opus', '2026-03-01'],
      ['model_sonnet', '2026-05-01'],
    ]);
    expect(milestones[0]!.label).toBe('First Opus');
  });

  // ClickHouse min() over an empty set yields the epoch, not null.
  it('drops the 1970 epoch a min() over no rows produces', () => {
    expect(modelFamilyMilestones([{ model: 'claude-opus-5', first_day: '1970-01-01' }])).toEqual([]);
  });
});

describe('buildRings', () => {
  // ClickHouse toDayOfWeek is 1 = Monday … 7 = Sunday; the array is 0 = Monday.
  const grid = [
    { hour: 9, weekday: 1, prompts: 10 }, // Monday 09:00
    { hour: 14, weekday: 1, prompts: 30 }, // Monday 14:00
    { hour: 14, weekday: 7, prompts: 10 }, // Sunday 14:00
  ];

  it('takes both rings off one grid, Monday first', () => {
    const rings = buildRings(grid, [], []);
    expect(rings.hours[9]).toBe(10);
    expect(rings.hours[14]).toBe(40);
    expect(rings.weekdays[0]).toBe(40); // Monday
    expect(rings.weekdays[6]).toBe(10); // Sunday
    expect(rings.hours.reduce((a, b) => a + b, 0)).toBe(
      rings.weekdays.reduce((a, b) => a + b, 0)
    );
  });

  it('exposes a dominant item per ring for the centre label', () => {
    const rings = buildRings(
      grid,
      [{ name: 'TypeScript', value: 80 }, { name: 'Python', value: 20 }],
      [{ model: 'claude-opus-5-5', value: 100 }]
    );
    expect(rings.peakHour).toEqual({ hour: 14, share: 80 });
    expect(rings.busiestDay).toEqual({ weekday: 0, share: 80 });
    expect(rings.topLanguage).toEqual({ name: 'TypeScript', value: 80, share: 80 });
    expect(rings.topModel?.family).toBe('Opus');
  });

  it('reports the Monday-to-Friday share', () => {
    expect(buildRings(grid, [], []).weekdayShare).toBeCloseTo(80, 10);
  });

  it('has no dominant anything with no data', () => {
    const empty = buildRings([], [], []);
    expect(empty.peakHour).toBeNull();
    expect(empty.busiestDay).toBeNull();
    expect(empty.topLanguage).toBeNull();
    expect(empty.topModel).toBeNull();
    expect(empty.weekdayShare).toBe(0);
  });
});

describe('buildClassHistory', () => {
  const monthlyHours = [
    // October: concentrated in the night hours.
    ...RHYTHM_BUCKETS['night-owl'].map((hour) => ({ month: '2026-10', hour, prompts: 20 })),
    // September: concentrated in the afternoon.
    ...RHYTHM_BUCKETS.afternoon.map((hour) => ({ month: '2026-09', hour, prompts: 20 })),
  ];
  const monthlyEvents = [
    { month: '2026-10', prompts: 140, tools: 2_800 }, // 20 per prompt
    { month: '2026-09', prompts: 100, tools: 100 }, // 1 per prompt
  ];
  const monthlyValue = [
    { month: '2026-10', subagent: 0, attributed: 100 },
    { month: '2026-09', subagent: 50, attributed: 100 },
  ];

  it('judges the current month and keeps the earlier ones as history', () => {
    const verdict = buildClassHistory('2026-10', monthlyHours, monthlyEvents, monthlyValue);
    expect(verdict.month).toBe('2026-10');
    expect(verdict.rhythm).toBe('night-owl');
    expect(verdict.style).toBe('autopilot');

    expect(verdict.history).toEqual([
      { month: '2026-09', rhythm: 'afternoon', style: 'orchestrator' },
    ]);
  });

  it('returns the evidence for the current month, not just the verdict', () => {
    const verdict = buildClassHistory('2026-10', monthlyHours, monthlyEvents, monthlyValue);
    expect(verdict.rhythm_evidence.prompts).toBe(140);
    expect(verdict.rhythm_evidence.shares['night-owl']).toBeCloseTo(100, 10);
    expect(verdict.style_evidence.toolCallsPerPrompt).toBeCloseTo(20, 10);
    expect(verdict.style_evidence.subagentSharePct).toBe(0);
  });

  it('shares the subagent value against ATTRIBUTED value only', () => {
    // Half the value predates query_source, so it is not evidence either way:
    // 30 of 60 attributed is a 50% habit, not 30 of 120.
    const verdict = buildClassHistory(
      '2026-10',
      monthlyHours,
      monthlyEvents,
      [{ month: '2026-10', subagent: 30, attributed: 60 }]
    );
    expect(verdict.style_evidence.subagentSharePct).toBeCloseTo(50, 10);
    expect(verdict.style).toBe('orchestrator');
  });

  it('still answers for a month with no rows at all', () => {
    const verdict = buildClassHistory('2026-12', [], [], []);
    expect(verdict.month).toBe('2026-12');
    expect(verdict.rhythm).toBeNull();
    expect(verdict.style).toBeNull();
    expect(verdict.history).toEqual([]);
  });

  it('drops a history month too thin to judge rather than listing it blank', () => {
    const verdict = buildClassHistory(
      '2026-10',
      [{ month: '2026-08', hour: 3, prompts: 2 }, ...monthlyHours],
      [{ month: '2026-08', prompts: 2, tools: 1 }, ...monthlyEvents],
      monthlyValue
    );
    expect(verdict.history.map((h) => h.month)).toEqual(['2026-09']);
  });

  it('lists history newest first', () => {
    const verdict = buildClassHistory(
      '2026-10',
      [
        ...monthlyHours,
        ...RHYTHM_BUCKETS.morning.map((hour) => ({ month: '2026-08', hour, prompts: 20 })),
      ],
      [...monthlyEvents, { month: '2026-08', prompts: 80, tools: 80 }],
      monthlyValue
    );
    expect(verdict.history.map((h) => h.month)).toEqual(['2026-09', '2026-08']);
  });
});


describe('assembleFingerprint', () => {
  /**
   * The real assembly, which is where the hide/show decision lives. A section
   * must be ABSENT, not zeroed: a zero is a claim about the data.
   */
  const parts = {
    value: { thisWeek: 10, lastWeek: 5, deltaPct: 100, allTime: 99, weekStart: '2026-10-12T00:00:00.000Z' },
    anatomy: {
      allTime: { prompts: 1, medianPromptChars: 170, toolCallsPerPrompt: 9.6, linesPerPrompt: 36, valuePerPrompt: 1.13 },
      last30d: { prompts: 1, medianPromptChars: 170, toolCallsPerPrompt: 9.6, linesPerPrompt: 36, valuePerPrompt: 1.13 },
    },
    conversation: {
      charsTyped: 100,
      outputTokens: 50,
      approxOutputChars: 200,
      ratio: 2,
      historyDerivedCharsPct: 0,
    },
    rings: buildRings([], [], []),
    class: buildClassHistory('2026-10', [], [], []),
    milestones: [],
    ultrathink: { count: 7, sharePct: 50, firstSeen: '2026-10-01' },
  };
  const meta = {
    username: 'ann',
    timezone: 'Europe/Paris',
    generatedAt: '2026-10-18T09:00:00.000Z',
  };

  it('lists every built section when nothing is hidden', () => {
    const data = assembleFingerprint(parts, { ...meta, hidden: [] });
    expect(data.sections).toEqual([...BUILT_SECTIONS]);
    expect(data.hidden).toEqual([]);
    expect(data.value?.allTime).toBe(99);
    expect(data.ultrathink?.count).toBe(7);
  });

  it('omits a hidden section entirely rather than zeroing it', () => {
    const data = assembleFingerprint(parts, { ...meta, hidden: ['value', 'ultrathink'] });

    expect('value' in data).toBe(false);
    expect('ultrathink' in data).toBe(false);
    expect(data.sections).not.toContain('value');
    expect(data.hidden).toEqual(['value', 'ultrathink']);
    // Everything else is untouched.
    expect(data.conversation?.charsTyped).toBe(100);
    expect(data.anatomy?.allTime.medianPromptChars).toBe(170);
  });

  it('can hide every section at once', () => {
    const data = assembleFingerprint(parts, { ...meta, hidden: [...FINGERPRINT_SECTIONS] });
    expect(data.sections).toEqual([]);
    for (const section of BUILT_SECTIONS) {
      expect(section in data).toBe(false);
    }
    // The identity of the profile survives; only its contents are withheld.
    expect(data.username).toBe('ann');
  });

  /**
   * The zone is OWNER-ONLY. It is not usage data — `America/Argentina/
   * Buenos_Aires` is where somebody lives, narrower than most location fields,
   * and nobody consented to publishing it by running `clawdgg setup`. Left OUT
   * for a visitor rather than defaulted to UTC, because a wrong zone is still a
   * claim about where someone is, and the figures do not need it: they arrive
   * already converted.
   */
  it('tells only the owner which clock the hours were read in', () => {
    const owner = assembleFingerprint(parts, { ...meta, isOwner: true, hidden: [] });
    expect(owner.timezone).toBe('Europe/Paris');

    const visitor = assembleFingerprint(parts, { ...meta, hidden: [] });
    expect('timezone' in visitor).toBe(false);
    // And the figures are there all the same.
    expect(visitor.rings).toBeDefined();
    expect(visitor.class).toBeDefined();
  });

  // `curve`, `year` and `plan` are toggleable sections this payload does not
  // carry yet. Hiding one must not disturb the sections it does carry.
  it('tolerates hiding a section it does not build', () => {
    const data = assembleFingerprint(parts, { ...meta, hidden: ['curve', 'year', 'plan'] });
    expect(data.sections).toEqual([...BUILT_SECTIONS]);
    expect(data.hidden).toEqual(['curve', 'year', 'plan']);
  });
});
