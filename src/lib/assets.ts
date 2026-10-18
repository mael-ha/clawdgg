/**
 * Resolves logical asset names to the hashed files `bun run build` produced.
 * Read once at startup: the manifest only changes when the build runs, and a
 * build is followed by a restart (or a `bun --hot` run that re-imports this).
 */

const MANIFEST_PATH = new URL('../../public/build/manifest.json', import.meta.url);

let manifest: Record<string, string>;
try {
  manifest = await Bun.file(MANIFEST_PATH).json();
} catch {
  throw new Error('No public/build/manifest.json — run `bun run build` before starting the server.');
}

export type Island =
  | 'analytics-chart'
  | 'contribution-tooltip'
  | 'copy-share'
  | 'device-code-input'
  | 'leaderboard-more';

function url(name: string): string {
  const file = manifest[name];
  if (!file) {
    throw new Error(`Asset '${name}' is not in the build manifest — is it still a src/client entrypoint?`);
  }
  return `/public/build/${file}`;
}

export const stylesheet = (): string => url('app.css');

export const islandUrl = (island: Island): string => url(`${island}.js`);
