#!/usr/bin/env bun
/**
 * Render the fixture profile to standalone HTML files, with no database.
 *
 *   bun run build                                  # the stylesheet first
 *   bun src/scripts/render-profile.ts <out-dir>
 *
 * Writes one file per view — visitor, owner, brand-new, taken-down and one
 * with a section hidden — with the compiled CSS inlined, so each opens from
 * `file://` and screenshots at any width without a server, an account or a
 * ClickHouse.
 *
 * This exists because the profile is a pure function of its payload (see
 * src/components/profile/types.ts). The moment a layout change needs a logged-in
 * user with a year of history to look at, it stops being reviewable.
 */

import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProfilePage } from '../components/profile/ProfilePage';
import { fixtureProfile, type FixtureOptions } from '../components/profile/fixture';
import { ShareCard } from '../components/profile/ShareCard';
import { shareCardFrom } from '../lib/share-card';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: bun src/scripts/render-profile.ts <out-dir>');
  process.exit(1);
}

const BUILD_DIR = new URL('../../public/build/', import.meta.url).pathname;

async function stylesheet(): Promise<string> {
  const files = await readdir(BUILD_DIR);
  const css = files.find((file) => file.startsWith('app-') && file.endsWith('.css'));
  if (!css) throw new Error('no public/build/app-*.css — run `bun run build` first');
  return Bun.file(join(BUILD_DIR, css)).text();
}

/**
 * The same <head> the real Layout emits, minus the nav and the effects.
 *
 * The fonts are fetched from Google exactly as in production, so the
 * screenshots are taken in JetBrains Mono rather than in whatever the
 * screenshotting machine happens to call `monospace`.
 */
function shell(title: string, css: string, body: string, bodyClass: string): string {
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body class="${bodyClass}">${body}</body>
</html>
`;
}

const VIEWS: { name: string; options: FixtureOptions }[] = [
  { name: 'visitor', options: {} },
  { name: 'owner', options: { owner: true } },
  { name: 'empty', options: { empty: true } },
  { name: 'empty-owner', options: { empty: true, owner: true } },
  { name: 'taken-down', options: { takenDown: true } },
  { name: 'hidden-value', options: { hide: ['value', 'ultrathink'] } },
];

const css = await stylesheet();
await mkdir(outDir, { recursive: true });

for (const view of VIEWS) {
  const props = fixtureProfile(view.options);
  const html = shell(
    `profile · ${view.name}`,
    css,
    String(ProfilePage(props)),
    'bg-fp-ground text-fp-text font-mono min-h-screen antialiased'
  );
  const path = join(outDir, `profile-${view.name}.html`);
  await Bun.write(path, html);
  console.log(`${path}  ${(html.length / 1024).toFixed(0)} KB`);
}

// The share card is already a standalone SVG document, so it is written as
// one — exactly the bytes /u/:username/card.svg serves.
const card = shareCardFrom(fixtureProfile().fingerprint, { username: 'fixture-user' });
const cardPath = join(outDir, 'share-card.svg');
await Bun.write(cardPath, String(ShareCard({ card })));
console.log(cardPath);
