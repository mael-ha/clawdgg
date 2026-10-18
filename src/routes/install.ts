/**
 * GET /install                      — the installer script
 * GET /install/checksums/:version   — the SHA-256 list for one release
 *
 * The second route is the point of the first. install.sh takes the BINARY from
 * GitHub Releases and the expected HASH from here, so neither host alone is
 * enough to make anyone run a swapped binary: an attacker with the GitHub
 * release still has to make clawd.gg serve a matching hash, and an attacker
 * with clawd.gg still has to put a matching binary on GitHub.
 *
 * Both files are read from disk (and copied into the image — see the Dockerfile)
 * rather than embedded in this module, so a release is a commit plus a deploy
 * and never a code change. The release order is in cli/checksums/README.md.
 */

import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const install = new Hono();

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const INSTALL_SCRIPT = join(REPO_ROOT, 'scripts/install.sh');
const CHECKSUM_DIR = join(REPO_ROOT, 'cli/checksums');

/**
 * Short, not immutable. `curl | sh` has to pick up a fixed installer quickly,
 * and the script is a few KB — but a minute of CDN caching still absorbs the
 * thundering herd of a launch.
 */
const CACHE_CONTROL = 'public, max-age=60';

/** Only ever a published version number: this value becomes a file path. */
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

install.get('/', async (c) => {
  try {
    const script = await readFile(INSTALL_SCRIPT, 'utf-8');
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', CACHE_CONTROL);
    return c.body(script);
  } catch (error) {
    console.error('[install] cannot read install.sh:', error);
    return c.text('# clawd.gg installer is unavailable right now\nexit 1\n', 500, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }
});

install.get('/checksums/:version', async (c) => {
  const version = c.req.param('version').replace(/\.txt$/, '');
  if (!VERSION_RE.test(version)) {
    return c.text('not found\n', 404, { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  try {
    const body = await readFile(join(CHECKSUM_DIR, `${version}.txt`), 'utf-8');
    c.header('Content-Type', 'text/plain; charset=utf-8');
    // A published release's checksums never change, so this one can be.
    c.header('Cache-Control', 'public, max-age=86400, immutable');
    return c.body(body);
  } catch {
    // install.sh REFUSES to install when this 404s, which is the behaviour we
    // want for a version whose checksums have not been committed yet.
    return c.text('not found\n', 404, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

export default install;
