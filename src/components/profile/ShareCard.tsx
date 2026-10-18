/**
 * The share card, 1200×630, as a standalone SVG document.
 *
 * SVG and not HTML-then-rasterised, deliberately:
 *
 *   it is EXACT. The rings are the same geometry functions the profile draws,
 *   at the same numbers, with no second rendering path to drift.
 *   it keeps the EMOJI. Every rasteriser worth running in this image either
 *   cannot do colour emoji at all (resvg: Apple Color Emoji is sbix, Noto is
 *   CBDT, neither supported) or needs a vendored emoji artwork set — so a
 *   PNG today would be a card with ? boxes where the signature should be.
 *   it costs NOTHING. No native dependency, no vendored font, no per-platform
 *   binary in the Docker image.
 *
 * What it does not do is satisfy X, which will not unfurl an SVG og:image.
 * That is a real gap and a decision with a price tag attached — see the note
 * in src/routes/og.ts.
 *
 * TWO CONSEQUENCES of being loaded as an <img> by an unfurler, which is the
 * only way this is ever seen:
 *
 *   NO EXTERNAL RESOURCES load. A webfont link would be ignored and so would
 *   a remote avatar, so the type falls back to the viewer's monospace and the
 *   avatar is the initials circle the design already specifies.
 *   NOTHING IS INTERACTIVE. There is no CSS file, so every value is an
 *   attribute, and every colour is a literal from ./palette.
 */

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
        <text x={PAD_X + 90} y={PAD_Y + 68} font-size="26" font-weight="800" fill={TEXT} font-family={mono}>
          {card.userClass.emoji} {card.userClass.rhythm}{' '}
          <tspan fill={ACCENT}>{card.userClass.style}</tspan>
        </text>
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
          <text x={PAD_X} y={CARD_HEIGHT - 102} font-size="14" fill={DIM} font-family={mono}>
            💎 API-equivalent
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
          <text
            x={CARD_WIDTH - PAD_X - 150}
            y={CARD_HEIGHT - 60}
            text-anchor="middle"
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
