/**
 * The share card's SVG, rasterised to a PNG — because X will not unfurl an
 * SVG og:image, and X is where this link gets pasted.
 *
 * resvg, not a headless browser: the card is already a flat SVG of paths and
 * text, which is exactly what resvg draws, and the alternative is Chromium in
 * the image for one 1200×630 picture.
 *
 * It renders with the fonts it is handed AND NOTHING ELSE. `loadSystemFonts`
 * is off deliberately: the production image has no fonts at all (so a card
 * that relied on them would come out blank), and a developer's machine that
 * does have them must not be able to render a different card from the server.
 * The three weights here are the three the card draws at — see
 * src/assets/og/README.md.
 *
 * Colour emoji are NOT a font here, in any build: resvg supports neither sbix
 * (Apple) nor CBDT (Noto). The card inlines Twemoji artwork instead, which is
 * why the PNG and the SVG show the same picture.
 */

import { Resvg } from '@resvg/resvg-js';
import { join } from 'node:path';

const FONT_DIR = join(import.meta.dir, '../assets/og/fonts');

/** Regular for captions, Bold for the handle, ExtraBold for the figures. */
export const CARD_FONTS = ['Regular', 'Bold', 'ExtraBold'].map((weight) =>
  join(FONT_DIR, `JetBrainsMono-${weight}.ttf`),
);

export function cardPng(svg: string): Uint8Array {
  return new Resvg(svg, {
    font: {
      fontFiles: CARD_FONTS,
      loadSystemFonts: false,
      defaultFontFamily: 'JetBrains Mono',
    },
  })
    .render()
    .asPng();
}
