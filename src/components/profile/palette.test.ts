/**
 * The colour tables are keyed on strings the CLIENT chose.
 *
 * A language name and a model id arrive as OTEL attributes, so `constructor`
 * and `__proto__` are names a profile can genuinely contain — and against an
 * object literal neither is a miss: the first returns `Object.prototype
 * .constructor`, a FUNCTION, and the second returns the prototype. Neither is
 * nullish, so `??` never reaches the fallback and the value ends up in an SVG
 * `fill` attribute. A file called `constructor.ts` in somebody's repository
 * would have taken their profile down.
 */

import { describe, expect, it } from 'bun:test';
import { className, familyColor, languageColor } from './palette';

const HEX = /^#[0-9a-f]{6}$/i;

/** Names that are inherited properties of a plain object. */
const PROTOTYPE_KEYS = [
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'prototype',
];

describe('languageColor', () => {
  it('knows the languages it has a house colour for', () => {
    expect(languageColor('typescript', 0)).toBe(languageColor('TypeScript', 7));
    expect(languageColor('TypeScript', 0)).toMatch(HEX);
  });

  it('falls back by position for anything else', () => {
    expect(languageColor('befunge', 0)).toMatch(HEX);
    // Stable for a given ring, which is sorted by volume, so the colour of a
    // slice does not move between renders.
    expect(languageColor('befunge', 3)).toBe(languageColor('malbolge', 3));
  });

  it.each(PROTOTYPE_KEYS)('treats %p as an unknown language, not a function', (name) => {
    const color = languageColor(name, 1);
    expect(typeof color).toBe('string');
    expect(color).toMatch(HEX);
  });
});

describe('familyColor', () => {
  it('knows the four families', () => {
    for (const family of ['Opus', 'Sonnet', 'Haiku', 'Fable']) {
      expect(familyColor(family, 0)).toMatch(HEX);
    }
  });

  it.each(PROTOTYPE_KEYS)('treats %p as an unknown family, not a function', (family) => {
    const color = familyColor(family, 2);
    expect(typeof color).toBe('string');
    expect(color).toMatch(HEX);
  });
});

describe('className', () => {
  it('names both halves when both are known', () => {
    expect(className('morning', 'orchestrator')).toEqual({
      emoji: '☀️',
      rhythm: 'morning',
      style: 'orchestrator',
    });
  });

  it('names one half, with the compass for the other', () => {
    expect(className('night-owl', null)?.style).toBe('');
    expect(className(null, 'autopilot')).toEqual({
      emoji: '🧭',
      rhythm: '',
      style: 'autopilot',
    });
  });

  it('has nothing to say with neither', () => {
    expect(className(null, null)).toBeNull();
  });

  // A verdict read off a payload rather than computed here: an unknown one is
  // "no class", never a read of `.emoji` off the prototype.
  it.each(PROTOTYPE_KEYS)('treats %p as no verdict at all', (word) => {
    expect(className(word as never, null)).toBeNull();
    expect(className(null, word as never)).toBeNull();
    expect(className(word as never, word as never)).toBeNull();
  });
});
