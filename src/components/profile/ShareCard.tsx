/**
 * The share card, 1200×630, as a standalone SVG document — which
 * src/routes/og.ts serves as-is at card.svg and rasterises at card.png.
 *
 * SVG as the single source: the rings are the same geometry functions the
 * profile draws, at the same numbers, and the PNG is this markup through
 * resvg rather than a second drawing that would drift from it.
 *
 * WHICH IS WHY THE EMOJI ARE ARTWORK, not characters. resvg has no colour
 * emoji (Apple Color Emoji is sbix, Noto is CBDT, it supports neither), so a
 * 🌈 left as text would rasterise to a blank. Every emoji on this card is
 * inlined from a vendored Twemoji SVG instead — see src/assets/og/README.md —
 * which costs a few hundred bytes and buys a card that looks the same in the
 * PNG, in the SVG, and on a machine with no emoji font at all.
 *
 * TWO CONSEQUENCES of being loaded as an <img> by an unfurler, which is the
 * only way this is ever seen:
 *
 *   NO EXTERNAL RESOURCES load. A webfont link would be ignored and so would
 *   a remote avatar, so the type falls back to the viewer's monospace (the
 *   PNG renders it in the vendored JetBrains Mono) and the avatar is the
 *   initials circle the design already specifies.
 *   NOTHING IS INTERACTIVE. There is no CSS file, so every value is an
 *   attribute, and every colour is a literal from ./palette.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FC } from 'hono/jsx';
import type { ShareCard as ShareCardData } from '../../lib/share-card';
import { VIEW, type Ring } from './geometry';
import { ACCENT, BORDER, DIM, GROUND, PRIMARY, TEXT } from './palette';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const PAD_X = 56;
const PAD_Y = 48;
const RING_SIZE = 190;
const RING_ROW_CENTRE = 318;

/** JetBrains Mono's advance, in ems. Every string here is monospace, so a
 *  width is a character count — which is how the emoji-plus-text runs below
 *  get centred without a text measurer. */
const ADVANCE = 0.6;

const TWEMOJI_DIR = join(import.meta.dir, '../../assets/og/twemoji');
const twemoji = new Map<string, string>();

/**
 * The paths of one Twemoji glyph, without its <svg> wrapper, from a 36×36 box.
 *
 * Throws on a glyph with no vendored artwork rather than rendering a hole:
 * the card is cached for ten minutes and then cached again by every unfurler
 * that saw it, so a missing emoji has to fail in a test, not in the wild.
 */
function twemojiPaths(emoji: string): string {
  const cached = twemoji.get(emoji);
  if (cached) return cached;

  // Twemoji names a file by its codepoints, with the variation selector that
  // only asks for the colour presentation dropped: ☀️ is 2600.svg.
  const name = [...emoji]
    .map((char) => char.codePointAt(0)!)
    .filter((code) => code !== 0xfe0f)
    .map((code) => code.toString(16))
    .join('-');

  let file: string;
  try {
    file = readFileSync(join(TWEMOJI_DIR, `${name}.svg`), 'utf8');
  } catch {
    throw new Error(
      `No Twemoji artwork for ${emoji} (${name}.svg). Vendor it into ` +
        `src/assets/og/twemoji — the card cannot print an emoji as text.`,
    );
  }

  const paths = file.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  twemoji.set(emoji, paths);
  return paths;
}

/**
 * One emoji, as artwork, sitting on `baseline` the way a glyph of `size`
 * would: Twemoji fills its 36-unit box, so it hangs a fifth of its height
 * below the baseline and the rest above.
 */
const Emoji: FC<{ char: string; x: number; baseline: number; size: number }> = ({
  char,
  x,
  baseline,
  size,
}) => (
  <g
    transform={`translate(${x.toFixed(1)} ${(baseline - size * 0.82).toFixed(1)}) scale(${(size / 36).toFixed(5)})`}
    dangerouslySetInnerHTML={{ __html: twemojiPaths(char) }}
  />
);

/** One dial, scaled from the shared 240-unit frame into the card. */
const CardRing: FC<{ ring: Ring; cx: number }> = ({ ring, cx }) => {
  const scale = RING_SIZE / VIEW;
  const left = cx - RING_SIZE / 2;
  const top = RING_ROW_CENTRE - RING_SIZE / 2;

  return (
    <g transform={`translate(${left.toFixed(1)} ${top}) scale(${scale.toFixed(5)})`}>
      {ring.wedges.map((wedge, index) =>
        wedge.d ? <path key={index} d={wedge.d} fill={wedge.color} /> : null,
      )}
      <text
        x={VIEW / 2}
        y="124"
        text-anchor="middle"
        font-size="32"
        font-weight="800"
        fill={TEXT}
        font-family="JetBrains Mono, ui-monospace, monospace"
      >
        {ring.big}
      </text>
      {/* The caption has to stay inside the ring's hole, and the hole is
          narrower this far below the centre than it is across the middle:
          at y=147 the chord is ~89 units, so a 12-character line needs 12px
          and a short one can have 14. */}
      <text
        x={VIEW / 2}
        y="147"
        text-anchor="middle"
        font-size={ring.small.length > 10 ? 12 : 14}
        fill={DIM}
        font-family="JetBrains Mono, ui-monospace, monospace"
      >
        {ring.small}
      </text>
    </g>
  );
};

export const ShareCard: FC<{ card: ShareCardData }> = ({ card }) => {
  const mono = 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace';
  // The rings are laid out across the content box in however many columns
  // there turn out to be, so a profile with two readable dials gets two
  // centred dials rather than two dials and a hole.
  const columns = Math.max(1, card.rings.length);
  const columnWidth = (CARD_WIDTH - PAD_X * 2) / columns;

  // The 🌈 chip is a glyph and a line centred TOGETHER in the pill. Nothing
  // here can measure text, but the line is monospace, so its width is its
  // length — which is the whole reason the count arrives as text with the
  // emoji taken off it.
  const chipCentre = CARD_WIDTH - PAD_X - 150;
  const chipTextWidth = (card.ultrathinks?.length ?? 0) * 18 * ADVANCE;
  const chipLeft = chipCentre - (20 + 8 + chipTextWidth) / 2;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={CARD_WIDTH}
      height={CARD_HEIGHT}
      viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`}
      role="img"
      aria-label={`@${card.username} on clawd.gg`}
    >
      {/* Defined only when something is painted with it — an unused gradient
          in an unfurled image is bytes every crawler pays for. */}
      {card.ultrathinks && (
        <defs>
          <linearGradient id="fp-card-rainbow" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#ff00ff" />
            <stop offset="20%" stop-color="#ff4d8d" />
            <stop offset="40%" stop-color="#fbbf24" />
            <stop offset="60%" stop-color="#00ff9f" />
            <stop offset="80%" stop-color="#67e8f9" />
            <stop offset="100%" stop-color="#c084fc" />
          </linearGradient>
        </defs>
      )}

      <rect width={CARD_WIDTH} height={CARD_HEIGHT} fill={GROUND} />
      <rect
        x="0.5"
        y="0.5"
        width={CARD_WIDTH - 1}
        height={CARD_HEIGHT - 1}
        fill="none"
        stroke={BORDER}
      />

      {/* ── who ──────────────────────────────────────────────────────────── */}
      <circle cx={PAD_X + 36} cy={PAD_Y + 36} r="34.5" fill="#1a1f2b" stroke={PRIMARY} stroke-width="3" />
      <text
        x={PAD_X + 36}
        y={PAD_Y + 45}
        text-anchor="middle"
        font-size="22"
        font-weight="800"
        fill={TEXT}
        font-family={mono}
      >
        {card.initials}
      </text>

      <text x={PAD_X + 90} y={PAD_Y + 30} font-size="32" font-weight="700" fill={TEXT} font-family={mono}>
        @{card.username}
      </text>
      {card.userClass && (
        <>
          <Emoji char={card.userClass.emoji} x={PAD_X + 90} baseline={PAD_Y + 68} size={28} />
          <text x={PAD_X + 126} y={PAD_Y + 68} font-size="26" font-weight="800" fill={TEXT} font-family={mono}>
            {card.userClass.rhythm}{' '}
            <tspan fill={ACCENT}>{card.userClass.style}</tspan>
          </text>
        </>
      )}

      <text
        x={CARD_WIDTH - PAD_X}
        y={PAD_Y + 28}
        text-anchor="end"
        font-size="30"
        font-weight="800"
        fill="#f3f4f6"
        font-family={mono}
      >
        {/* The brand is two spans in two tones, everywhere it appears. */}
        clawd<tspan fill={PRIMARY}>.gg</tspan>
      </text>

      {/* ── the rings ────────────────────────────────────────────────────── */}
      {card.rings.map((ring, index) => (
        <CardRing key={index} ring={ring} cx={PAD_X + columnWidth * (index + 0.5)} />
      ))}

      {/* ── the headline figures ─────────────────────────────────────────── */}
      {card.value && (
        <>
          <Emoji char="💎" x={PAD_X} baseline={CARD_HEIGHT - 102} size={16} />
          <text x={PAD_X + 22} y={CARD_HEIGHT - 102} font-size="14" fill={DIM} font-family={mono}>
            API-equivalent
          </text>
          <text
            x={PAD_X}
            y={CARD_HEIGHT - 58}
            font-size="40"
            font-weight="800"
            fill={ACCENT}
            font-family={mono}
          >
            {card.value}
          </text>
        </>
      )}

      {card.anatomy && (
        <>
          <text x={PAD_X + 300} y={CARD_HEIGHT - 102} font-size="14" fill={DIM} font-family={mono}>
            per prompt
          </text>
          <text
            x={PAD_X + 300}
            y={CARD_HEIGHT - 60}
            font-size="22"
            font-weight="700"
            fill={TEXT}
            font-family={mono}
          >
            {card.anatomy}
          </text>
        </>
      )}

      {card.ultrathinks && (
        <>
          <rect
            x={CARD_WIDTH - PAD_X - 300}
            y={CARD_HEIGHT - 88}
            width="300"
            height="42"
            rx="21"
            fill="none"
            stroke="#262b38"
          />
          <Emoji char="🌈" x={chipLeft} baseline={CARD_HEIGHT - 60} size={20} />
          <text
            x={chipLeft + 28}
            y={CARD_HEIGHT - 60}
            font-size="18"
            font-weight="800"
            fill="url(#fp-card-rainbow)"
            font-family={mono}
          >
            {card.ultrathinks}
          </text>
        </>
      )}
    </svg>
  );
};
