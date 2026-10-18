# src/assets/og — what the share card is drawn with

The 1200×630 link-preview card is rasterised server-side by resvg, which has
no system fonts to fall back on and cannot draw a colour-emoji font. So the
card carries its own typeface and its own emoji artwork, vendored here and
read off disk at render time. **Nothing in the card fetches anything.**

These files live under `src/` so the Dockerfile's `COPY /app/src ./src` picks
them up; nothing else has to know about them.

## fonts/ — JetBrains Mono 2.304

`JetBrainsMono-{Regular,Bold,ExtraBold}.ttf`, the three weights the card draws
at (400 captions, 700 handle and figures, 800 headline numbers), from
[the v2.304 release](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304).

SIL Open Font License 1.1 — `fonts/OFL.txt`.

## twemoji/ — Twemoji 14.0.2

One SVG per emoji the card can print, named by codepoint the way Twemoji names
them (U+FE0F dropped), from
[twitter/twemoji v14.0.2](https://github.com/twitter/twemoji/tree/v14.0.2/assets/svg).
The set is exactly what `ShareCard.tsx` can reach, and nothing more:

| file        | emoji | where it comes from                     |
| ----------- | ----- | --------------------------------------- |
| `1f305.svg` | 🌅    | `RHYTHM_LABELS['early-bird']`           |
| `2600.svg`  | ☀️    | `RHYTHM_LABELS.morning`                 |
| `1f324.svg` | 🌤    | `RHYTHM_LABELS.afternoon`               |
| `1f306.svg` | 🌆    | `RHYTHM_LABELS.evening`                 |
| `1f319.svg` | 🌙    | `RHYTHM_LABELS['night-owl']`            |
| `1f9ed.svg` | 🧭    | `className()`, when only the style is known |
| `1f48e.svg` | 💎    | the API-equivalent caption              |
| `1f308.svg` | 🌈    | the ultrathink chip                     |

Adding an emoji to the card means adding its file here — `ShareCard.tsx`
throws on a glyph it has no artwork for rather than printing a blank, so a
missing one shows up in tests, not in a crawler's cache.

Graphics are CC-BY 4.0 — `twemoji/LICENSE-GRAPHICS`, and the credit line is on
`/about`.
