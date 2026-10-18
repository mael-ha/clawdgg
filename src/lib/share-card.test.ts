import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shareCardFrom } from './share-card';
import { ShareCard } from '../components/profile/ShareCard';
import { emptyFingerprint, fixtureFingerprint } from '../components/profile/fixture';
import { RHYTHM_LABELS, className } from '../components/profile/palette';
import type { RhythmClass } from './fingerprint';
import type { FingerprintData, FingerprintSection } from './fingerprint';

/**
 * The card goes wherever the link is pasted, so what it may NOT contain
 * matters more than what it does. These assert both: that it is a valid,
 * self-contained SVG with no way to reach the network, and that a section
 * missing from the payload is missing from the card.
 *
 * This markup is also what card.png is rasterised from, so everything
 * asserted here holds of the PNG too — the last test in the file is what
 * keeps that true.
 */

const identity = { username: 'fixture-user' };

function svgFor(data: FingerprintData): string {
  return String(ShareCard({ card: shareCardFrom(data, identity) }));
}

/** The payload minus a section, exactly as the API would send it. */
function without(section: FingerprintSection): FingerprintData {
  const data = fixtureFingerprint();
  data.sections = data.sections.filter((name) => name !== section);
  data.hidden = [section];
  delete data[section as keyof FingerprintData & typeof section];
  return data;
}

describe('shareCardFrom', () => {
  test('carries the class, the value, the anatomy and the 🌈 count', () => {
    const card = shareCardFrom(fixtureFingerprint(), identity);
    expect(card.initials).toBe('FI');
    expect(card.userClass).toEqual({ emoji: '☀️', rhythm: 'morning', style: 'orchestrator' });
    expect(card.value).toBe('$38.3K');
    expect(card.anatomy).toBe('170 chars → 9.6 tools → 36 lines');
    // No 🌈 in the string: the card draws that one as artwork.
    expect(card.ultrathinks).toBe('4,941 ultrathinks');
    expect(card.rings).toHaveLength(4);
  });

  test('leaves out a dial that has nothing in it', () => {
    // Four empty rings on a share card is four empty circles. The card
    // carries what can be read and lays the rest out across the width.
    const card = shareCardFrom(emptyFingerprint(), identity);
    expect(card.rings).toHaveLength(0);
    expect(card.value).toBeNull();
    expect(card.anatomy).toBeNull();
    expect(card.ultrathinks).toBeNull();
    expect(card.userClass).toBeNull();
  });

  test('a brand-new account still produces a card, not a crash', () => {
    const blank = emptyFingerprint();
    const svg = String(ShareCard({ card: shareCardFrom(blank, { username: blank.username }) }));
    expect(svg).toContain('<svg');
    expect(svg).toContain('@brand-new');
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('null');
  });
});

describe('ShareCard · the SVG itself', () => {
  test('is a standalone document at exactly 1200×630', () => {
    const svg = svgFor(fixtureFingerprint());
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    expect(svg).toContain('viewBox="0 0 1200 630"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  test('reaches for nothing off the page', () => {
    // An unfurler loads this as an <img>, where every external resource is
    // blocked and script never runs. Anything here that needed one would
    // simply be missing from the preview, with no way to notice.
    const svg = svgFor(fixtureFingerprint());
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('<foreignObject');
    expect(svg).not.toContain('@import');
    // The only URL in the document is the SVG namespace on the root element.
    expect(svg.match(/https?:\/\/[^"']*/g)).toEqual(['http://www.w3.org/2000/svg']);
  });

  test('draws its emoji as artwork, because the raster has no emoji font', () => {
    const svg = svgFor(fixtureFingerprint());
    // Not one emoji CHARACTER survives into the markup: resvg supports
    // neither sbix nor CBDT, so each one would rasterise to nothing.
    expect(svg).not.toMatch(/\p{Extended_Pictographic}/u);
    // They are here as Twemoji paths instead — ☀️'s amber, 💎's blue.
    expect(svg).toContain('fill="#FFAC33"');
    expect(svg).toContain('fill="#5DADEC"');
  });

  test('has artwork for every emoji the card can be asked to print', () => {
    // The vendored set is small on purpose, so the thing that can go wrong is
    // a class emoji with no file behind it. Every rhythm, plus the 🧭 that
    // stands in when only the style is known.
    const rhythms = [...(Object.keys(RHYTHM_LABELS) as RhythmClass[]), null];
    for (const rhythm of rhythms) {
      const card = {
        ...shareCardFrom(fixtureFingerprint(), identity),
        userClass: className(rhythm, 'orchestrator'),
      };
      expect(() => String(ShareCard({ card }))).not.toThrow();
    }
  });

  test('refuses an emoji it has no artwork for, rather than drawing a hole', () => {
    const card = {
      ...shareCardFrom(fixtureFingerprint(), identity),
      userClass: { emoji: '🦄', rhythm: 'mythical', style: 'orchestrator' },
    };
    expect(() => String(ShareCard({ card }))).toThrow(/No Twemoji artwork/);
  });

  test('paints the brand in two tones and the 🌈 chip with a gradient', () => {
    const svg = svgFor(fixtureFingerprint());
    expect(svg).toContain('clawd<tspan fill="#00ff9f">.gg</tspan>');
    expect(svg).toContain('url(#fp-card-rainbow)');
  });

  test('every ring caption fits inside the ring', () => {
    // A monospace advance is ~0.6em, and the hole's chord at the caption's
    // baseline is about 89 units wide. A caption that does not fit runs out
    // over the wedges, which is what happened to "busiest · 86% weekdays".
    for (const ring of shareCardFrom(fixtureFingerprint(), identity).rings) {
      const size = ring.small.length > 10 ? 12 : 14;
      expect(ring.small.length * size * 0.6).toBeLessThan(89);
    }
  });
});

describe('ShareCard · a hidden section is not on the card', () => {
  test("hiding 'value' takes the headline figure off it", () => {
    expect(svgFor(fixtureFingerprint())).toContain('$38.3K');
    const svg = svgFor(without('value'));
    expect(svg).not.toContain('$38.3K');
    expect(svg).not.toContain('API-equivalent');
  });

  test("hiding 'anatomy' takes the per-prompt line off it", () => {
    const svg = svgFor(without('anatomy'));
    expect(svg).not.toContain('per prompt');
    expect(svg).not.toContain('170 chars');
  });

  test("hiding 'ultrathink' takes the 🌈 chip off it", () => {
    const svg = svgFor(without('ultrathink'));
    expect(svg).not.toContain('4,941');
    expect(svg).not.toContain('url(#fp-card-rainbow)');
    // And the gradient it would have used is not defined either.
    expect(svg).not.toContain('<linearGradient');
  });

  test("hiding 'class' takes the class off it", () => {
    const svg = svgFor(without('class'));
    expect(svg).not.toContain('orchestrator');
  });

  test("hiding 'rings' takes every dial off it", () => {
    const svg = svgFor(without('rings'));
    expect(svg).not.toContain('TypeScript');
    expect(svg).not.toContain('peak hour');
    // And what is left still lays out: the handle and the figures.
    expect(svg).toContain('@fixture-user');
    expect(svg).toContain('$38.3K');
  });

  test('a profile taken down entirely is a card with only a handle on it', () => {
    const bare = fixtureFingerprint();
    const all = [...bare.sections];
    bare.hidden = all;
    bare.sections = [];
    for (const section of all) delete bare[section as keyof FingerprintData & typeof section];

    const svg = svgFor(bare);
    expect(svg).toContain('@fixture-user');
    expect(svg).toContain('clawd');
    expect(svg).not.toContain('$');
    expect(svg).not.toContain('ultrathinks');
    expect(svg).not.toContain('NaN');
  });

  test('and the PNG is this markup rasterised, so it cannot say more', () => {
    // Everything above asserts on the SVG. That is also the whole truth about
    // card.png only while the route rasterises the string it serves rather
    // than building a second one — which is what this reads the route for.
    const route = readFileSync(join(import.meta.dir, '../routes/og.ts'), 'utf8');
    expect(route.match(/ShareCard\(/g)).toHaveLength(1);
    expect(route).toContain('cardPng(svg)');
  });
});
