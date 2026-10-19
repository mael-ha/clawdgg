/**
 * What `bun test` needs in place before a single module is evaluated.
 *
 * WHY A PRELOAD AND NOT A `beforeAll`. Two modules in this app reach outside
 * the process at IMPORT time, and both of them throw when what they reach for
 * is not there:
 *
 *   src/db/index.ts    opens ./data/clawd.db — `create: true` creates the FILE
 *                      and not the DIRECTORY, so a checkout with no data/ gets
 *                      SQLITE_CANTOPEN.
 *   src/lib/assets.ts  reads public/build/manifest.json and throws
 *                      "run `bun run build`" when there is none.
 *
 * A top-level throw poisons every importer, however little of the module they
 * wanted: src/components/Layout.tsx imports assets.ts for the stylesheet URL,
 * so a test that renders nothing but the <Wordmark> in its header died with
 * "Cannot access 'Wordmark' before initialization" — Layout's module body had
 * aborted before it got that far. Nothing a test file can do in a hook helps,
 * because the import has already run. It has to be true before the first
 * module loads, which is what a preload is.
 *
 * This is also why the release workflow went red on a clean checkout while
 * every laptop was green: a laptop has a data/ directory and a public/build
 * from the last `bun run dev`, and CI has neither.
 *
 * It changes NO runtime behaviour. Both eager throws stay exactly as they are —
 * a server started without a build still fails at boot, which is the point of
 * them.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { Glob } from 'bun';

const ROOT = new URL('..', import.meta.url).pathname;

// ─────────────────────────────────────────────────────────────────────────────
// A SQLite file of this run's own
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A throwaway path, so no suite can read or write the developer's real
 * data/clawd.db — a test that passes because of a row somebody's laptop
 * happens to hold is a test that fails in CI, which is this file's whole
 * subject. An explicit DATABASE_PATH is honoured: src/db/clickhouse-reads.test.ts
 * is run with one on purpose, and it refuses to start without it.
 */
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'clawd-test-')), 'clawd.db');
}
const dbPath = isAbsolute(process.env.DATABASE_PATH)
  ? process.env.DATABASE_PATH
  : join(process.cwd(), process.env.DATABASE_PATH);
mkdirSync(dirname(dbPath), { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// A build manifest, if the checkout has no build
// ─────────────────────────────────────────────────────────────────────────────

const OUT_DIR = join(ROOT, 'public/build');
const MANIFEST = join(OUT_DIR, 'manifest.json');

if (!existsSync(MANIFEST)) {
  // The SAME keys scripts/build-assets.ts writes — one per src/client
  // entrypoint, plus the stylesheet — discovered the same way, so a new island
  // cannot be missing from the stub. The filenames are deliberately not hashes:
  // if one of these ever reaches a browser, the 404 says where it came from.
  const islands = [...new Glob('*.ts').scanSync(join(ROOT, 'src/client'))]
    .map((file) => basename(file, '.ts'))
    .sort();
  const manifest = Object.fromEntries([
    ['app.css', 'app-test-stub.css'],
    ...islands.map((name) => [`${name}.js`, `${name}-test-stub.js`]),
  ]);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  // Put the tree back the way it was found. A developer who runs the suite and
  // then `bun run dev` without building has to get the real "run `bun run
  // build`" error, not a page quietly linking to assets that do not exist.
  process.on('exit', () => rmSync(MANIFEST, { force: true }));
}
