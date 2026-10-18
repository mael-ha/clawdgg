import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { CARD_FONTS, cardPng } from './card-png';
import { shareCardFrom } from './share-card';
import { CARD_HEIGHT, CARD_WIDTH, ShareCard } from '../components/profile/ShareCard';
import { fixtureFingerprint } from '../components/profile/fixture';

/**
 * What the rasteriser has to get right is not the drawing — that is asserted
 * on the markup in share-card.test.ts — but the two things resvg will fail at
 * silently: a font it was never handed, and a size nobody checked.
 */

const svg = String(
  ShareCard({ card: shareCardFrom(fixtureFingerprint(), { username: 'fixture-user' }) }),
);

/** Width and height out of the PNG's IHDR, which is always the first chunk. */
function dimensions(png: Uint8Array): [number, number] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

describe('cardPng', () => {
  test('is a PNG at exactly the card’s dimensions', () => {
    const png = cardPng(svg);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(dimensions(png)).toEqual([CARD_WIDTH, CARD_HEIGHT]);
  });

  test('stays small enough that an unfurler will actually fetch it', () => {
    expect(cardPng(svg).byteLength).toBeLessThan(300 * 1024);
  });

  test('draws its text with the vendored font, not with the host’s', () => {
    for (const path of CARD_FONTS) expect(existsSync(path)).toBe(true);

    // The production image has no fonts at all. Rendering the same card with
    // none handed to resvg is therefore what the server would produce if
    // these files went missing from the image — and it must not be what the
    // server produces today.
    const fontless = new Resvg(svg, { font: { fontFiles: [], loadSystemFonts: false } })
      .render()
      .asPng();
    expect(cardPng(svg).byteLength).not.toBe(fontless.byteLength);
  });
});
