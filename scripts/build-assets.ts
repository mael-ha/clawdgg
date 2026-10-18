#!/usr/bin/env bun
/**
 * Builds everything the browser downloads: one CSS file, one JS file per
 * client island. Output lands in public/build/ under content-hashed names,
 * with manifest.json mapping logical name → hashed file. Hashed names are
 * why src/index.ts can serve public/build/* immutable for a year.
 *
 *   bun run build
 *
 * CSS: the Tailwind v4 CLI (oxide, native) compiles src/styles/app.css —
 * ~120ms for the whole site, against the 407KB of JS the Play CDN used to
 * ship so every visitor's browser could do the same work on every page view.
 * Not bun-plugin-tailwind: that plugin pulls the `bun` npm package (75MB) plus
 * 26MB of its own into node_modules, which the production image copies.
 *
 * JS: Bun.build, one entrypoint per island, no shared chunks. Each island is
 * self-contained, so a page costs exactly the islands it uses and chart.js
 * ships only inside analytics-chart.
 */

import { rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Glob } from 'bun';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'public/build');
const CSS_ENTRY = join(ROOT, 'src/styles/app.css');
const CLIENT_DIR = join(ROOT, 'src/client');

function hash(content: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(content).digest('hex').slice(0, 8);
}

async function buildCss(): Promise<[string, string]> {
  const tmp = join(OUT_DIR, 'app.tmp.css');
  const proc = Bun.spawn(
    ['bun', join(ROOT, 'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', CSS_ENTRY, '-o', tmp, '--minify'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`tailwindcss exited ${code}\n${await new Response(proc.stderr).text()}`);
  }

  const css = await Bun.file(tmp).text();
  const name = `app-${hash(css)}.css`;
  await Bun.write(join(OUT_DIR, name), css);
  await rm(tmp);
  return ['app.css', name];
}

async function buildIslands(): Promise<[string, string][]> {
  if (!existsSync(CLIENT_DIR)) return [];

  const entrypoints = (await Array.fromAsync(new Glob('*.ts').scan(CLIENT_DIR)))
    .map((f) => join(CLIENT_DIR, f))
    .sort();
  if (entrypoints.length === 0) return [];

  const result = await Bun.build({
    entrypoints,
    outdir: OUT_DIR,
    target: 'browser',
    format: 'esm',
    minify: true,
    naming: '[name]-[hash].[ext]',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (!result.success) {
    throw new AggregateError(result.logs, 'island bundle failed');
  }

  return result.outputs
    .filter((o) => o.kind === 'entry-point')
    .map((o) => {
      const file = basename(o.path);
      // "analytics-chart-a1b2c3d4.js" → "analytics-chart.js"
      const logical = file.replace(/-[0-9a-z]+\.js$/, '.js');
      return [logical, file] as [string, string];
    });
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const started = performance.now();
const [css, islands] = await Promise.all([buildCss(), buildIslands()]);
const manifest = Object.fromEntries([css, ...islands].sort());

await Bun.write(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const sizes = await Promise.all(
  Object.values(manifest).map(async (f) => [f, (await Bun.file(join(OUT_DIR, f)).bytes()).length] as const),
);
console.log(`built ${sizes.length} assets in ${Math.round(performance.now() - started)}ms`);
for (const [file, bytes] of sizes) {
  console.log(`  ${(bytes / 1024).toFixed(1).padStart(7)} KB  ${file}`);
}
