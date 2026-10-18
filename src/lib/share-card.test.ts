import { describe, expect, test } from 'bun:test';
import { shareCardFrom } from './share-card';
import { ShareCard } from '../components/profile/ShareCard';
import { emptyFingerprint, fixtureFingerprint } from '../components/profile/fixture';
import type { FingerprintData, FingerprintSection } from './fingerprint';

/**
 * The card goes wherever the link is pasted, so what it may NOT contain
 * matters more than what it does. These assert both: that it is a valid,
 * self-contained SVG with no way to reach the network, and that a section
 * missing from the payload is missing from the card.
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
    expect(card.ultrathinks).toBe('🌈 4,941 ultrathinks');
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

  test('keeps the emoji, which is the whole reason it is not a raster', () => {
    const svg = svgFor(fixtureFingerprint());
    expect(svg).toContain('💎');
    expect(svg).toContain('🌈');
    expect(svg).toContain('☀️');
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
    expect(svg).not.toContain('🌈');
    expect(svg).not.toContain('NaN');
  });
});
