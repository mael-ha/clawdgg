import { describe, expect, test } from 'bun:test';
import { FINGERPRINT_SECTIONS, type FingerprintSection } from '../../lib/fingerprint';
import { ProfilePage } from './ProfilePage';
import { fixtureProfile, fixtureFingerprint, fixtureCurve } from './fixture';
import { group, money } from './format';
import { summarise } from '../../routes/profile';
import { visibilityOf } from '../../lib/profile-settings';

/**
 * The profile, rendered from a fixture.
 *
 * Two things are asserted, and the second is the important one.
 *
 * 1. Every empty and partial state renders — no NaN, no "undefined", no
 *    "0 prompts" on an account that has not run anything yet.
 *
 * 2. A HIDDEN SECTION LEAKS NOWHERE. Not into the body, not into a <meta>
 *    tag, not into an HTML attribute. The page this replaces got that wrong:
 *    `profile_settings` filtered only the fingerprint API, while the page put
 *    "$X invested · rank #N" into og:description and 365 days of cost and
 *    token figures into data attributes for everybody.
 */

function render(node: unknown): string {
  return String(node);
}

function page(options: Parameters<typeof fixtureProfile>[0] = {}): string {
  const props = fixtureProfile(options);
  return render(<ProfilePage {...props} />);
}

/**
 * Strings that appear on the page ONLY because `section` is visible.
 *
 * Deliberately distinctive. A bare number like "170" is useless here: SVG path
 * coordinates are full of them, so an assertion on one would pass whether the
 * section leaked or not.
 */
function figuresOf(section: FingerprintSection): string[] {
  const data = fixtureFingerprint();

  switch (section) {
    case 'value':
      return [
        money(data.value!.thisWeek),
        money(data.value!.allTime),
        'API-EQUIVALENT VALUE',
        // ⚡ activity plots 💎 by default, so its control, its footer total and
        // its aria-label are all this section's figures too.
        'aria-label="API-equivalent value"',
        money(fixtureCurve().summary.total),
      ];
    case 'anatomy':
      return [
        'ANATOMY OF YOUR AVERAGE PROMPT',
        '✍️ you type',
        'it ships',
        'API-equivalent, per prompt',
        'long tail to 778',
        // The curve's `lines` metric is this section's figure over time.
        'data-fp-metric="lines"',
        'Bash · Read · Edit · Grep',
      ];
    case 'conversation':
      return ['THE CONVERSATION', 'Claude sent back', 'for every character you type', '~558M'];
    case 'rings':
      return ['TypeScript 46%', 'Opus 54%', 'peak hour', 'Opus · 5.5'];
    case 'class':
      // The last string is a PAST month's evidence: every row carries its own,
      // not just the current one.
      return ['class history', '38% before noon', 'orchestrator', '42% after 22h'];
    case 'milestones':
      return ['🏁 milestones', '1K ultrathinks', '30-day streak', 'next ·'];
    case 'ultrathink':
      return [
        `🌈 ${group(data.ultrathink!.count)} ultrathinks`,
        'ultrathinks · 49.5%',
        'data-fp-metric="ultrathinks"',
      ];
    case 'curve':
      return ['⚡ activity', 'granularity', 'fp-curve-paths'];
    case 'year':
      return ['📅 the year', 'active days', 'before joining', 'fp-year-tooltip'];
    case 'plan':
      return ['weekly limit', '5-hour session'];
  }
}

describe('ProfilePage · the whole page renders', () => {
  test("a visitor's view", () => {
    const html = page();
    expect(html).toContain('@fixture-user');
    expect(html).toContain('☀️ morning');
    expect(html).toContain('orchestrator');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('Infinity');
  });

  test("the owner's view adds the owner layer and nothing else is lost", () => {
    const html = page({ owner: true });
    expect(html).toContain('OWNER LAYER');
    expect(html).toContain('what visitors see');
    expect(html).toContain('🩺 pipeline');
    expect(html).toContain('☀️ today');
    expect(html).toContain('preview as visitor');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  test('a visitor never gets the owner layer', () => {
    const html = page();
    expect(html).not.toContain('OWNER LAYER');
    expect(html).not.toContain('what visitors see');
    expect(html).not.toContain('🩺 pipeline');
    expect(html).not.toContain('☀️ today');
  });

  test('every toggle in the grid is a real button with a pressed state', () => {
    const html = page({ owner: true });
    for (const section of FINGERPRINT_SECTIONS) {
      expect(html).toContain(`data-section="${section}"`);
    }
    // One grid button per section, plus the inline pills.
    expect(html.match(/aria-pressed="true"/g)!.length).toBeGreaterThanOrEqual(
      FINGERPRINT_SECTIONS.length
    );
  });
});

describe('ProfilePage · empty and partial states', () => {
  test('a brand-new account is told it is new, not told it has done nothing', () => {
    const html = page({ empty: true });
    expect(html).toContain('nothing measured yet');
    expect(html).toContain('clawdgg setup');
    // No figure at all, rather than a page of zeros.
    expect(html).not.toContain('0 prompts');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('$0');
  });

  test("a brand-new owner's page still renders its instruments", () => {
    const html = page({ empty: true, owner: true });
    expect(html).toContain('nothing measured yet');
    expect(html).toContain('what visitors see');
    expect(html).not.toContain('NaN');
  });

  test('a profile its owner has taken down says so', () => {
    const html = page({ takenDown: true });
    expect(html).toContain('has taken this profile down');
    expect(html).not.toContain('ANATOMY');
    expect(html).not.toContain('NaN');
  });

  test('a missing ratio reads as a dash, never as a division by zero', () => {
    const props = fixtureProfile({ empty: true });
    props.fingerprint.conversation = {
      charsTyped: 0,
      outputTokens: 1_000,
      approxOutputChars: 4_000,
      ratio: null,
      historyDerivedCharsPct: 0,
    };
    props.fingerprint.anatomy!.allTime.prompts = 1;
    const html = render(<ProfilePage {...props} />);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  test('a week with no previous week shows no delta rather than ▲ 0%', () => {
    const props = fixtureProfile();
    props.fingerprint.value = {
      thisWeek: 120,
      lastWeek: 0,
      deltaPct: null,
      allTime: 120,
      weekStart: '2026-10-12T00:00:00.000Z',
    };
    const html = render(<ProfilePage {...props} />);
    expect(html).not.toContain('▲');
    expect(html).not.toContain('▼');
  });

  test('a month too quiet to classify shows the evidence, not a blank class', () => {
    const props = fixtureProfile();
    props.fingerprint.class!.rhythm = null;
    props.fingerprint.class!.style = null;
    props.fingerprint.class!.style_evidence = {
      subagentSharePct: 0,
      toolCallsPerPrompt: 0,
      prompts: 6,
    };
    const html = render(<ProfilePage {...props} />);
    expect(html).toContain('too quiet to call');
    expect(html).toContain('6 prompts this month');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });

  test('no languages and no models render as a caption, not an empty donut', () => {
    const props = fixtureProfile();
    props.fingerprint.rings = {
      ...props.fingerprint.rings!,
      languages: [],
      topLanguage: null,
      models: [],
      topModel: null,
    };
    const html = render(<ProfilePage {...props} />);
    expect(html).toContain('no edits yet');
    expect(html).toContain('no models yet');
    expect(html).not.toContain('NaN');
  });

  test('a user with no plan data is told where plan data comes from', () => {
    const props = fixtureProfile({ owner: true });
    props.owner!.plan = null;
    const html = render(<ProfilePage {...props} />);
    expect(html).toContain('no plan usage reported yet');
    expect(html).not.toContain('weekly limit');
  });

  test('a visitor sees no plan card when there is nothing to show', () => {
    const props = fixtureProfile();
    props.publicPlan = null;
    const html = render(<ProfilePage {...props} />);
    expect(html).not.toContain('weekly limit');
    expect(html).not.toContain('no plan usage reported yet');
  });

  test('a figure built on recovered prompt lengths says so', () => {
    // history.jsonl records a paste as "[Pasted text #1 +40 lines]", so the
    // characters it contributes understate what was sent — and the median
    // prompt length and the conversation ratio are both built on them.
    const loud = fixtureProfile();
    expect(loud.fingerprint.conversation!.historyDerivedCharsPct).toBeGreaterThan(5);
    const caveated = render(<ProfilePage {...loud} />);
    expect(caveated).toContain('reads low');
    expect(caveated).toContain('characters typed*');
    expect(caveated).toContain('chars*');

    const clean = fixtureProfile();
    clean.fingerprint.conversation!.historyDerivedCharsPct = 0.4;
    const quiet = render(<ProfilePage {...clean} />);
    expect(quiet).not.toContain('reads low');
    expect(quiet).toContain('characters typed ');
    // The caption keeps its p95 either way; the caveat is what comes and goes.
    expect(quiet).toContain('median · long tail to 778');
  });

  test('the caveat is not shown when conversation is hidden but anatomy is not', () => {
    // The share lives on `conversation`. With that section gone there is
    // nothing to claim, so the median is printed plainly rather than with an
    // asterisk pointing at a footnote that is no longer on the page.
    const html = page({ hide: ['conversation'] });
    expect(html).toContain('median · long tail to 778');
    expect(html).not.toContain('reads low');
  });

  test('an owner on the default timezone is told their hours are UTC', () => {
    const props = fixtureProfile({ owner: true });
    props.identity.timezone = 'UTC';
    props.identity.timezoneAssumed = true;
    const html = render(<ProfilePage {...props} />);
    expect(html).toContain('clawdgg setup');
    expect(html).toContain('UTC');
  });
});

describe('ProfilePage · a hidden section leaks nowhere', () => {
  for (const section of FINGERPRINT_SECTIONS) {
    test(`hiding '${section}' removes its figures from the HTML`, () => {
      const hidden = page({ hide: [section] });
      const shown = page();

      for (const figure of figuresOf(section)) {
        // Sanity: the figure IS on the page when the section is visible, so a
        // passing assertion below means something.
        expect(shown).toContain(figure);
        expect(hidden).not.toContain(figure);
      }

      expect(hidden).not.toContain('NaN');
      expect(hidden).not.toContain('undefined');
    });
  }

  test("hiding 'value' leaves ⚡ activity plotting prompts, not dollars", () => {
    // The panel has its own toggle, and three of its five metrics are another
    // section's figure drawn over time. With 💎 down the panel stays up on
    // prompts — the one thing the curve's own toggle covers — rather than
    // publishing the dollars the rest of the page refuses to print.
    const hidden = page({ hide: ['value'] });
    expect(hidden).toContain('⚡ activity');
    expect(hidden).toContain('data-fp-metric="prompts"');
    expect(hidden).not.toContain('data-fp-metric="value"');
    expect(hidden).toContain('data-metric="prompts"');
    // The chart's own aria-label — "<noun> per week, 1y — $X in total". The
    // bare noun also names the model ring, which belongs to another section.
    expect(hidden).not.toContain('API-equivalent value per ');
  });

  test('a visitor gets only the metric controls their sections allow', () => {
    // Nothing is left to ask for but the two the curve itself owns.
    const stripped = page({ hide: ['value', 'anatomy', 'ultrathink'] });
    expect(stripped).toContain('data-fp-metric="prompts"');
    expect(stripped).toContain('data-fp-metric="toolCalls"');
    for (const gone of ['value', 'lines', 'ultrathinks']) {
      expect(stripped).not.toContain(`data-fp-metric="${gone}"`);
    }

    // The owner's own page keeps all five, hidden sections and all.
    const owner = page({ owner: true });
    for (const metric of ['prompts', 'value', 'toolCalls', 'lines', 'ultrathinks']) {
      expect(owner).toContain(`data-fp-metric="${metric}"`);
    }
  });

  test("hiding 'value' strips the daily values out of the year's attributes", () => {
    // A data attribute is as public as rendered text. 371 days of cost in
    // data-value would publish the whole of a hidden section.
    expect(page()).toContain('data-value=');
    expect(page({ hide: ['value'] })).not.toContain('data-value=');
  });

  test("hiding 'ultrathink' strips the daily 🌈 counts out of the attributes", () => {
    expect(page()).toContain('data-ultrathinks=');
    expect(page({ hide: ['ultrathink'] })).not.toContain('data-ultrathinks=');
  });

  test("hiding 'anatomy' strips the daily line counts out of the attributes", () => {
    expect(page()).toContain('data-lines=');
    expect(page({ hide: ['anatomy'] })).not.toContain('data-lines=');
  });

  test('a visitor is never told the timezone', () => {
    const visitor = page();
    expect(visitor).not.toContain('Europe/Paris');
    expect(visitor).toContain('their own clock');

    // The owner, on their own page, is.
    expect(page({ owner: true })).toContain('Europe/Paris');
  });

  test('the owner sees their hidden sections, and a visitor does not', () => {
    const owner = fixtureProfile({ owner: true });
    owner.owner!.visibility.value = false;
    const ownerHtml = render(<ProfilePage {...owner} />);
    // The payload the owner gets is unfiltered, so the figure is there — with
    // a pill saying it is private.
    expect(ownerHtml).toContain(money(owner.fingerprint.value!.allTime));
    expect(ownerHtml).toContain('○ private');
  });
});

describe('summarise · the meta description', () => {
  test('is built from the payload and the visibility, never the payload alone', () => {
    const data = fixtureFingerprint();
    const all = visibilityOf(null);

    const open = summarise(data, all);
    expect(open).toContain('morning orchestrator');
    expect(open).toContain(money(data.value!.allTime));
    expect(open).toContain('🌈');

    // The owner's payload is UNFILTERED on purpose. A summary built from it
    // alone would put a hidden figure into og:description — which is read by
    // crawlers, not by the owner.
    const closed = summarise(data, { ...all, value: false, ultrathink: false, class: false });
    expect(closed).not.toContain(money(data.value!.allTime));
    expect(closed).not.toContain('🌈');
    expect(closed).not.toContain('orchestrator');
    expect(closed).toContain('prompts');
  });

  test('says nothing but the handle when there is nothing public', () => {
    const data = fixtureFingerprint();
    const none = Object.fromEntries(
      FINGERPRINT_SECTIONS.map((section) => [section, false])
    ) as ReturnType<typeof visibilityOf>;
    expect(summarise(data, none)).toBe('@fixture-user on clawd.gg');
  });

  test('never carries the retired "invested" or "rank #N" claims', () => {
    const summary = summarise(fixtureFingerprint(), visibilityOf(null));
    expect(summary).not.toContain('invested');
    expect(summary).not.toContain('rank #');
    expect(summary).not.toContain('Top ');
  });
});
