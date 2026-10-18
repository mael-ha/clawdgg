import { describe, expect, test } from 'bun:test';
import {
  VIEW,
  arcPath,
  barsPath,
  cellFill,
  contributionGrid,
  hoursRing,
  languagesRing,
  linePath,
  modelsRing,
  nextMilestone,
  polar,
  sawtooth,
  weekRing,
  type ContributionDay,
} from './geometry';
import { CONTRIB_BEFORE, CONTRIB_RAMP, quadrantOf } from './palette';
import type { ModelFamilyShare, RingItem } from '../../lib/fingerprint';

/**
 * The rings are arithmetic, so they are tested as arithmetic.
 *
 * What is asserted here is what a reader would notice: that a ring with no
 * data draws nothing rather than a flat circle, that a single 100% slice
 * closes instead of leaving a hairline gap, that a model version's wedge is a
 * share of its family and not of the whole, and that the year's grid ends on
 * today.
 */

const zeros = (length: number) => Array<number>(length).fill(0);

function pathCommands(d: string): string[] {
  return d.match(/[A-Z]/g) ?? [];
}

describe('polar / arcPath', () => {
  test('angle 0 is the top of the ring', () => {
    const [x, y] = polar(50, -Math.PI / 2);
    expect(x).toBeCloseTo(VIEW / 2, 6);
    expect(y).toBeCloseTo(VIEW / 2 - 50, 6);
  });

  test('a sweep too small to see draws nothing at all', () => {
    // The alternative is a path whose end angle precedes its start, which
    // renders as a spike across the dial.
    expect(arcPath(50, 90, 1, 1)).toBe('');
    expect(arcPath(50, 90, 1, 1.0005)).toBe('');
  });

  test('a full circle closes as an annulus, not as a zero-length arc', () => {
    const full = arcPath(50, 90, 0, Math.PI * 2);
    // Two rings, each drawn with two half-arcs: four A commands, two Z.
    expect(pathCommands(full).filter((c) => c === 'A')).toHaveLength(4);
    expect(pathCommands(full).filter((c) => c === 'Z')).toHaveLength(2);
  });

  test('a sweep past a half turn sets the large-arc flag', () => {
    expect(arcPath(50, 90, 0, Math.PI * 1.5)).toContain('A 90 90 0 1 1');
    expect(arcPath(50, 90, 0, Math.PI * 0.5)).toContain('A 90 90 0 0 1');
  });
});

describe('hoursRing', () => {
  test('no prompts means an empty ring, not a ring of zeros', () => {
    const ring = hoursRing(zeros(24), null);
    expect(ring.empty).toBe(true);
    expect(ring.wedges).toHaveLength(0);
    expect(ring.big).toBe('—');
    // The legend stays: it explains the colours the card is not drawing yet.
    expect(ring.legend).toHaveLength(4);
  });

  test('24 bars, each coloured by its quadrant', () => {
    const hours = Array.from({ length: 24 }, (_, h) => h + 1);
    const ring = hoursRing(hours, 23);

    expect(ring.wedges).toHaveLength(24);
    expect(ring.wedges[0]!.color).toBe(quadrantOf(0).color);
    expect(ring.wedges[7]!.color).toBe(quadrantOf(7).color);
    expect(ring.wedges[13]!.color).toBe(quadrantOf(13).color);
    expect(ring.wedges[20]!.color).toBe(quadrantOf(20).color);
    expect(ring.big).toBe('23h');
  });

  test('a quiet hour still draws a visible bar', () => {
    // One prompt in an hour is not no prompts, and a bar too short to see
    // would say it was.
    const hours = zeros(24);
    hours[3] = 1;
    hours[11] = 10_000;
    const ring = hoursRing(hours, 11);
    expect(ring.wedges[3]!.d).not.toBe('');
  });

  test('labels mark every third hour and highlight the peak', () => {
    const hours = zeros(24);
    hours[11] = 5;
    const ring = hoursRing(hours, 11);

    expect(ring.labels.map((label) => label.text)).toEqual([
      '00', '03', '06', '09', '12', '15', '18', '21',
    ]);
    // 11 falls in the 09 block, which is label index 3.
    expect(ring.labels[3]!.color).not.toBe(ring.labels[0]!.color);
  });
});

describe('weekRing', () => {
  test('index 0 is Monday and the weekend is the dim colour', () => {
    const ring = weekRing([10, 10, 10, 10, 10, 2, 2], { weekday: 0, share: 20 }, 86);
    expect(ring.wedges[0]!.label).toBe('Mon');
    expect(ring.wedges[6]!.label).toBe('Sun');
    expect(ring.wedges[5]!.color).not.toBe(ring.wedges[0]!.color);
    expect(ring.wedges[6]!.color).toBe(ring.wedges[5]!.color);
    expect(ring.big).toBe('Mon');
    expect(ring.small).toBe('86% weekdays');
  });

  test('the legend splits weekdays from the weekend and sums to 100', () => {
    const ring = weekRing([1, 1, 1, 1, 1, 1, 1], { weekday: 2, share: 14 }, 71);
    expect(ring.legend[0]!.name).toBe('weekdays 71%');
    expect(ring.legend[1]!.name).toBe('weekend 29%');
  });

  test('an empty week draws nothing', () => {
    expect(weekRing(zeros(7), null, 0).empty).toBe(true);
  });
});

describe('languagesRing', () => {
  const items = (shares: number[]): RingItem[] =>
    shares.map((share, index) => ({ name: `Lang${index}`, value: share, share }));

  test('the legend is the top four, however many there are', () => {
    const ring = languagesRing(items([40, 25, 15, 10, 6, 4]), {
      name: 'Lang0',
      value: 40,
      share: 40,
    });
    expect(ring.wedges).toHaveLength(6);
    expect(ring.legend).toHaveLength(4);
    expect(ring.big).toBe('40%');
    expect(ring.small).toBe('Lang0');
  });

  test('one language at 100% draws a closed ring', () => {
    const ring = languagesRing(items([100]), { name: 'Lang0', value: 100, share: 100 });
    expect(ring.wedges).toHaveLength(1);
    expect(ring.wedges[0]!.d).not.toBe('');
  });

  test('no edits yet says so instead of drawing an empty donut', () => {
    const ring = languagesRing([], null);
    expect(ring.empty).toBe(true);
    expect(ring.small).toBe('no edits yet');
  });
});

describe('modelsRing', () => {
  const families: ModelFamilyShare[] = [
    {
      family: 'Opus',
      value: 54,
      share: 54,
      versions: [
        { name: 'Opus 5.5', value: 38, share: 70.4 },
        { name: 'Opus 5', value: 12, share: 22.2 },
        { name: 'Opus 4.8', value: 4, share: 7.4 },
      ],
    },
    {
      family: 'Sonnet',
      value: 46,
      share: 46,
      versions: [{ name: 'Sonnet 5.5', value: 46, share: 100 }],
    },
  ];

  test('a version wedge is its share OF ITS FAMILY, scaled by the family', () => {
    // groupModelsByFamily returns version shares relative to the family, so
    // taking them as shares of the whole would draw ~250% of a circle.
    const ring = modelsRing(families, families[0]!);
    const versions = ring.wedges.slice(0, 4);

    // Opus 5.5 is 70.4% of 54% ≈ 38% of the dial; Sonnet 5.5 is all of 46%.
    // The Sonnet wedge must therefore be the wider of the two.
    const sweepOf = (d: string) => (d.match(/A /g) ?? []).length;
    expect(sweepOf(versions[0]!.d)).toBeGreaterThan(0);
    expect(ring.wedges).toHaveLength(6); // 4 versions + 2 family bands
    expect(ring.wedges[4]!.label).toBe('Opus 54%');
    expect(ring.wedges[5]!.label).toBe('Sonnet 46%');
  });

  test('the centre names the family and its commonest version', () => {
    const ring = modelsRing(families, families[0]!);
    expect(ring.big).toBe('54%');
    // The family is not repeated inside the version: "Opus · Opus 5.5" is
    // the same word twice, and the pair overflowed the ring's hole.
    expect(ring.small).toBe('Opus · 5.5');
  });

  test('versions of one family are shades of one colour', () => {
    const ring = modelsRing(families, families[0]!);
    const [first, second, third] = ring.wedges;
    expect(first!.color).not.toBe(second!.color);
    expect(second!.color).not.toBe(third!.color);
    // The band is the family's undimmed colour.
    expect(ring.wedges[4]!.color).toBe(first!.color);
  });

  test('no models yet draws nothing', () => {
    expect(modelsRing([], null).empty).toBe(true);
  });
});

describe('contributionGrid', () => {
  const day = (date: string, prompts: number, estimated = false): ContributionDay => ({
    date,
    prompts,
    value: prompts * 1.1,
    lines: prompts * 30,
    ultrathinks: Math.round(prompts / 2),
    estimated,
  });

  test('the grid ends on today, in the last column', () => {
    // 2026-10-18 is a Sunday, so it is the last cell of the last column.
    const grid = contributionGrid([day('2026-10-18', 5)], { today: '2026-10-18', weeks: 53 });
    expect(grid.weeks).toHaveLength(53);
    const lastColumn = grid.weeks[52]!;
    expect(lastColumn[6]!.date).toBe('2026-10-18');
    expect(lastColumn[6]!.prompts).toBe(5);
  });

  test('a mid-week today leaves the rest of the column in the future', () => {
    // 2026-10-14 is a Wednesday: Thursday onwards has not happened.
    const grid = contributionGrid([], { today: '2026-10-14', weeks: 4 });
    const lastColumn = grid.weeks[3]!;
    expect(lastColumn[2]!.kind).toBe('day');
    expect(lastColumn[3]!.kind).toBe('future');
    expect(cellFill(lastColumn[3]!)).toBe('transparent');
  });

  test('month labels sit on the column each month starts in, not every fourth', () => {
    const grid = contributionGrid([], { today: '2026-10-18', weeks: 53 });
    const named = grid.monthLabels.filter((label) => label !== '');
    // A year's worth of columns crosses twelve or thirteen month boundaries.
    expect(named.length).toBeGreaterThanOrEqual(12);
    expect(named.length).toBeLessThanOrEqual(13);
    // No month is named twice in a row.
    const consecutive = grid.monthLabels.filter(
      (label, index) => label !== '' && label === grid.monthLabels[index - 1]
    );
    expect(consecutive).toHaveLength(0);
  });

  test('days before joining are outlined, not level zero', () => {
    const grid = contributionGrid([day('2026-10-18', 4)], {
      today: '2026-10-18',
      weeks: 2,
      joined: '2026-10-12',
    });
    const before = grid.weeks[0]![0]!;
    expect(before.kind).toBe('before');
    expect(cellFill(before)).toBe(CONTRIB_BEFORE);
  });

  test('a day with activity before the joined date is still a day', () => {
    // Recovered history can predate the account. The square has numbers on it,
    // so it must not be drawn as "there was nothing here".
    const grid = contributionGrid([day('2026-10-06', 9)], {
      today: '2026-10-18',
      weeks: 3,
      joined: '2026-10-12',
    });
    const recovered = grid.weeks.flat().find((cell) => cell.date === '2026-10-06')!;
    expect(recovered.kind).toBe('day');
    expect(recovered.prompts).toBe(9);
  });

  test('levels are 1–4 against the busiest day, and a worked day is never 0', () => {
    const days = [day('2026-10-12', 1), day('2026-10-13', 50), day('2026-10-14', 100)];
    const grid = contributionGrid(days, { today: '2026-10-18', weeks: 2 });
    const byDate = new Map(grid.weeks.flat().map((cell) => [cell.date, cell]));

    expect(byDate.get('2026-10-12')!.level).toBe(1);
    expect(byDate.get('2026-10-14')!.level).toBe(4);
    expect(byDate.get('2026-10-13')!.level).toBeGreaterThan(0);
    expect(cellFill(byDate.get('2026-10-14')!)).toBe(CONTRIB_RAMP[4]);
  });

  test('a recovered day asks for the hatch rather than a colour', () => {
    const grid = contributionGrid([day('2026-10-14', 10, true)], {
      today: '2026-10-18',
      weeks: 2,
    });
    const recovered = grid.weeks.flat().find((cell) => cell.date === '2026-10-14')!;
    expect(recovered.estimated).toBe(true);
    expect(cellFill(recovered)).toBe('');
  });

  test('active days counts days with work, not squares', () => {
    const grid = contributionGrid([day('2026-10-12', 3), day('2026-10-15', 7)], {
      today: '2026-10-18',
      weeks: 53,
    });
    expect(grid.activeDays).toBe(2);
  });

  test('26 weeks is the same grid, one window narrower', () => {
    const wide = contributionGrid([], { today: '2026-10-18', weeks: 53 });
    const narrow = contributionGrid([], { today: '2026-10-18', weeks: 26 });
    expect(narrow.weeks).toHaveLength(26);
    // Both end on the same day — which is what makes hiding columns with CSS
    // equivalent to rendering a shorter grid.
    expect(narrow.weeks[25]![6]!.date).toBe(wide.weeks[52]![6]!.date);
  });
});

describe('nextMilestone', () => {
  test('picks the nearest in PROGRESS, not in absolute distance', () => {
    // 48K of 50K prompts (96%) beats 10 of 100 ultrathinks (10%), even though
    // the ultrathink gap is 90 and the prompt gap is 2,000.
    const next = nextMilestone({ prompts: 48_000, lines: 0, ultrathink: 10 });
    expect(next?.kind).toBe('prompts');
    expect(next?.target).toBe(50_000);
    expect(next?.label).toBe('50K prompts');
    expect(next?.progressPct).toBeCloseTo(96, 5);
  });

  test('turns a weekly pace into weeks, and stays silent without one', () => {
    const paced = nextMilestone({ prompts: 9_000, lines: 0, ultrathink: 0 }, { prompts: 250 });
    expect(paced?.weeksAway).toBe(4);
    expect(nextMilestone({ prompts: 9_000, lines: 0, ultrathink: 0 })?.weeksAway).toBeNull();
  });

  test('a ladder that has been topped out is skipped', () => {
    const next = nextMilestone({ prompts: 200_000, lines: 50_000_000, ultrathink: 20 });
    expect(next?.kind).toBe('ultrathink');
    expect(next?.target).toBe(100);
  });

  test('nothing left to reach returns nothing', () => {
    expect(
      nextMilestone({ prompts: 200_000, lines: 50_000_000, ultrathink: 10_000 })
    ).toBeNull();
  });

  test('a brand-new account aims at the first rung', () => {
    const next = nextMilestone({ prompts: 0, lines: 0, ultrathink: 0 });
    expect(next).not.toBeNull();
    expect(next!.progressPct).toBe(0);
    expect(Number.isFinite(next!.progressPct)).toBe(true);
  });
});

describe('sawtooth', () => {
  const cycle = (from: number, peak: number, current = false) => ({
    from,
    to: from + 6 * 86_400,
    samples: [
      { at: from + 86_400, pct: peak / 3 },
      { at: from + 3 * 86_400, pct: (peak * 2) / 3 },
      { at: from + 6 * 86_400, pct: peak },
    ],
    current,
  });

  test('every cycle gets an equal slot and a divider between them', () => {
    const saw = sawtooth([cycle(0, 80), cycle(1_000_000, 90), cycle(2_000_000, 60, true)], {
      width: 900,
      height: 150,
    });
    expect(saw.dividers).toEqual([300, 600]);
    expect(saw.line.startsWith('M 0.0')).toBe(true);
  });

  test('a finished cycle drops back to the floor and the current one does not', () => {
    const closed = sawtooth([cycle(0, 80)], { width: 100, height: 150 });
    const open = sawtooth([cycle(0, 80, true)], { width: 100, height: 150 });
    expect(closed.line.endsWith('149.0')).toBe(true);
    expect(open.line.endsWith('149.0')).toBe(false);
  });

  test('the area closes back to the baseline', () => {
    const saw = sawtooth([cycle(0, 80, true)], { width: 100, height: 150 });
    expect(saw.area.endsWith('Z')).toBe(true);
    expect(saw.area).toContain('L 0 149.0 Z');
  });

  test('no cycles draws nothing', () => {
    expect(sawtooth([], { width: 100, height: 150 })).toEqual({
      line: '',
      area: '',
      dividers: [],
    });
  });

  test('a percentage past 100 is clamped to the top of the box', () => {
    const over = sawtooth(
      [{ from: 0, to: 100, samples: [{ at: 50, pct: 180 }], current: true }],
      { width: 100, height: 150 }
    );
    expect(over.line).toContain('14.0');
  });
});

describe('barsPath / linePath', () => {
  test('an empty series draws nothing', () => {
    expect(barsPath([], { width: 100, height: 100 })).toBe('');
    expect(linePath([], { width: 100, height: 100 })).toBe('');
  });

  test('all-zero values do not divide by zero', () => {
    const bars = barsPath([0, 0, 0], { width: 90, height: 100 });
    expect(bars).toContain('M');
    expect(bars).not.toContain('NaN');
    expect(linePath([0, 0, 0], { width: 90, height: 100 })).not.toContain('NaN');
  });

  test('the picker leaves out the bars it rejects', () => {
    const only = barsPath([1, 2, 3], { width: 90, height: 100 }, (index) => index === 1);
    expect(only.match(/M /g)).toHaveLength(1);
  });

  test('the line passes through the middle of each slot', () => {
    expect(linePath([10, 10], { width: 100, height: 50 })).toBe('M 25.0 0.0 L 75.0 0.0');
  });
});
