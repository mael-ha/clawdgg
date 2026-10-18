/**
 * The fingerprint's colours, labels and emoji — one table per thing the page
 * names, so a colour is decided once and every ring, legend and chip agrees.
 *
 * Hex, not Tailwind classes: these values go into SVG `fill` attributes and
 * into the share card, which is rasterised with no stylesheet at all. The same
 * values exist as Tailwind tokens (`--color-fp-*` in src/styles/app.css) for
 * the markup around the charts.
 */

export const GROUND = '#050508';
export const CARD = '#0b0d12';
export const RAISE = '#11151c';
export const LINE = '#161a23';
export const BORDER = '#1a1f2b';
export const EDGE = '#262b38';
export const MUTE = '#3a4050';
export const TEXT = '#e6e8ee';
export const DIM = '#8a91a0';
export const FAINT = '#6f7686';
export const GHOST = '#4b5263';

export const PRIMARY = '#00ff9f';
export const ACCENT = '#ff00ff';
export const ICE = '#67e8f9';
export const SUN = '#fbbf24';
export const VIOLET = '#c084fc';
export const ROSE = '#ff4d6d';
export const PINK = '#ff4d8d';
/** The weekend's dimmed cousin of ICE. */
export const WEEKEND = '#2f6f7a';

/** The rainbow the 🌈 chip and the ultrathink milestone are painted with. */
export const RAINBOW = 'linear-gradient(90deg, #ff00ff, #ff4d8d, #fbbf24, #00ff9f, #67e8f9, #c084fc)';

/**
 * The 24 hours, coloured by quadrant.
 *
 * Six-hour blocks, not the five rhythm buckets of src/lib/fingerprint.ts: the
 * ring is a clock face and a reader counts quadrants off it. The rhythm buckets
 * are deliberately uneven (night spans 7 hours) because they answer a different
 * question, and painting them on a clock would read as a rendering bug.
 */
export const QUADRANTS = [
  { name: 'night', color: VIOLET },
  { name: 'morning', color: SUN },
  { name: 'afternoon', color: PRIMARY },
  { name: 'evening', color: ACCENT },
] as const;

export function quadrantOf(hour: number): (typeof QUADRANTS)[number] {
  return QUADRANTS[Math.floor(hour / 6)] ?? QUADRANTS[0];
}

export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Languages people actually write here, in the colour they are recognised by.
 * Anything else falls through to FALLBACK_COLORS by position, which is stable
 * for a given ring because the ring is sorted by volume.
 */
const LANGUAGE_COLORS: Record<string, string> = {
  typescript: ICE,
  javascript: SUN,
  tsx: ICE,
  jsx: SUN,
  ruby: PINK,
  python: SUN,
  go: '#4dd0e1',
  rust: '#ff8a65',
  java: '#ef5350',
  kotlin: VIOLET,
  swift: '#ff7043',
  c: '#90a4ae',
  cpp: '#90a4ae',
  'c++': '#90a4ae',
  csharp: '#81c784',
  php: '#9fa8da',
  html: '#ff8a65',
  css: '#64b5f6',
  scss: PINK,
  sql: VIOLET,
  shell: PRIMARY,
  bash: PRIMARY,
  markdown: TEXT,
  json: DIM,
  yaml: '#a5d6a7',
  toml: '#bcaaa4',
  dockerfile: '#64b5f6',
  elixir: '#b39ddb',
  erb: PINK,
  vue: '#66bb6a',
  svelte: '#ff7043',
  lua: '#7986cb',
  zig: SUN,
  haskell: '#9575cd',
  scala: '#e57373',
  dart: '#4dd0e1',
  r: '#64b5f6',
  perl: '#9fa8da',
  text: FAINT,
};

const FALLBACK_COLORS = [ICE, PINK, TEXT, SUN, PRIMARY, VIOLET, ROSE, WEEKEND] as const;

export function languageColor(name: string, index: number): string {
  return (
    LANGUAGE_COLORS[name.trim().toLowerCase()] ??
    FALLBACK_COLORS[index % FALLBACK_COLORS.length] ??
    DIM
  );
}

/**
 * Model families in their house colour. The versions inside a family are the
 * same hue stepped darker (see shade), so the inner ring reads as "which Opus"
 * and the outer one as "how much Opus".
 */
const FAMILY_COLORS: Record<string, string> = {
  opus: ACCENT,
  fable: VIOLET,
  sonnet: ICE,
  haiku: PRIMARY,
};

export function familyColor(family: string, index: number): string {
  return (
    FAMILY_COLORS[family.trim().toLowerCase()] ??
    FALLBACK_COLORS[index % FALLBACK_COLORS.length] ??
    DIM
  );
}

/**
 * `hex` darkened towards black by `amount` (0 = unchanged, 1 = black).
 *
 * Versions within a family are stepped with this rather than given their own
 * hues: a family has to read as one block on the ring, and three unrelated
 * colours under one legend entry read as three families.
 */
export function shade(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return hex;
  const keep = Math.max(0, Math.min(1, 1 - amount));
  const channel = (offset: number) =>
    Math.round(Number.parseInt(clean.slice(offset, offset + 2), 16) * keep)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

/** `hex` mixed towards `target` by `t` (0 = hex, 1 = target), as `rgb(...)`. */
export function mix(hex: string, target: string, t: number): string {
  const read = (value: string, offset: number) =>
    Number.parseInt(value.replace('#', '').slice(offset, offset + 2), 16);
  const blend = (offset: number) =>
    Math.round(read(hex, offset) + (read(target, offset) - read(hex, offset)) * t);
  return `rgb(${blend(0)},${blend(2)},${blend(4)})`;
}

/**
 * The contribution graph's five levels, from "a day with work on it" to "your
 * loudest day", plus the two squares that are not levels at all: a day before
 * this person joined, and a day whose numbers were recovered rather than
 * measured.
 */
export const CONTRIB_RAMP = [
  RAISE,
  mix(RAISE, PRIMARY, 0.22),
  mix(RAISE, PRIMARY, 0.45),
  mix(RAISE, PRIMARY, 0.7),
  PRIMARY,
] as const;

export const CONTRIB_BEFORE = '#0a0c10';

// ═══════════════════════════════════════════════════════════════════════════
// The class, in words
// ═══════════════════════════════════════════════════════════════════════════

import type { RhythmClass, StyleClass } from '../../lib/fingerprint';

export const RHYTHM_LABELS: Record<RhythmClass, { emoji: string; label: string }> = {
  'early-bird': { emoji: '🌅', label: 'early-bird' },
  morning: { emoji: '☀️', label: 'morning' },
  afternoon: { emoji: '🌤', label: 'afternoon' },
  evening: { emoji: '🌆', label: 'evening' },
  'night-owl': { emoji: '🌙', label: 'night-owl' },
};

export const STYLE_LABELS: Record<StyleClass, string> = {
  orchestrator: 'orchestrator',
  autopilot: 'autopilot',
  'pair-programmer': 'pair-programmer',
};

export interface ClassName {
  emoji: string;
  rhythm: string;
  style: string;
}

/**
 * "☀️ morning orchestrator", in parts, so the style half can be painted
 * magenta. Null when there is not enough history to name either half — the
 * page then shows no chip rather than a hedged one.
 */
export function className(
  rhythm: RhythmClass | null,
  style: StyleClass | null
): ClassName | null {
  if (!rhythm && !style) return null;
  return {
    emoji: rhythm ? RHYTHM_LABELS[rhythm].emoji : '🧭',
    rhythm: rhythm ? RHYTHM_LABELS[rhythm].label : '',
    style: style ? STYLE_LABELS[style] : '',
  };
}
