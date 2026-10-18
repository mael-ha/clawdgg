import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { Layout } from '../components/Layout';
import { optionalAuth } from '../lib/auth-middleware';
import { db } from '../db';
import { users } from '../db/schema';
import type { Island } from '../lib/assets';
import type { SessionUser } from '../types';
import { HomePage, type HomeView } from '../components/home/HomePage';
import { BoardRowList } from '../components/home/BoardRows';
import {
  BOARDS,
  getBoardPage,
  getGlobalPulse,
  parseBoard,
  parseScope,
  type BoardKey,
  type BoardScope,
} from '../lib/boards';

/**
 * The homepage: the leaderboard, first.
 *
 * Four boards (💎 value, 🔥 streak, 🌈 ultrathinks, ⚡ leverage) over this UTC
 * week or all time, with the selection in the URL so a board is a link someone
 * can send and the page works with scripting off.
 *
 * Every figure comes from src/lib/boards.ts, which is also what GET /api/boards
 * answers with — one computation, two renderings, so the page and the API can
 * never disagree. The rendering itself is a pure function of the payload
 * (src/components/home/HomePage.tsx), which is how the one-user and three-user
 * states can be looked at without a database.
 */

type Variables = {
  user: SessionUser | null;
};

const app = new Hono<{ Variables: Variables }>();

/** Rows on the first screen. The rest arrive through the load-more island. */
const PAGE_SIZE = 25;

function pageArgs(c: {
  req: { query: (key: string) => string | undefined };
}): { board: BoardKey; scope: BoardScope } {
  // Board first: the scope is validated against THAT board's pair, so
  // switching boards with a stale `scope` in the form lands on its default.
  const board = parseBoard(c.req.query('board'));
  return { board, scope: parseScope(c.req.query('scope'), board) };
}

/**
 * Someone to send a first-time visitor to.
 *
 * The busiest profile on record, not a hardcoded handle: whoever that is, their
 * page is the best demonstration of what the fingerprint looks like when it is
 * full. Null when nobody qualifies yet, and the link is then simply absent.
 */
async function featuredProfile(): Promise<string | null> {
  const row = await db
    .select({ username: users.githubUsername })
    .from(users)
    .where(sql`COALESCE(${users.totalPrompts}, 0) > 0`)
    .orderBy(sql`COALESCE(${users.totalPrompts}, 0) DESC`, users.id)
    .limit(1)
    .get();
  return row?.username ?? null;
}

// The fragment the leaderboard-more island appends: the next rows plus their
// own footer, including the next button. Same component the first page renders.
app.get('/rows', optionalAuth, async (c) => {
  const user = c.get('user');
  const { board, scope } = pageArgs(c);
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

  const page = await getBoardPage({
    board,
    scope,
    limit: PAGE_SIZE,
    offset,
    viewerId: user?.id ?? null,
  });
  const nextOffset = offset + page.rows.length;

  return c.html(
    <BoardRowList
      board={board}
      scope={scope}
      rows={page.rows}
      comparedTo={page.comparedTo}
      remaining={Math.max(0, page.total - nextOffset)}
      nextOffset={nextOffset}
    />
  );
});

app.get('/', optionalAuth, async (c) => {
  const user = c.get('user');
  const { board, scope } = pageArgs(c);

  const [page, pulse, featured] = await Promise.all([
    getBoardPage({ board, scope, limit: PAGE_SIZE, offset: 0, viewerId: user?.id ?? null }),
    getGlobalPulse(),
    featuredProfile(),
  ]);

  const view: HomeView = {
    user,
    board,
    scope,
    rows: page.rows,
    total: page.total,
    resetIn: page.resetIn,
    comparedTo: page.comparedTo,
    complete: page.complete,
    pulse,
    featuredProfile: featured,
  };

  // The copy button is the only JavaScript a first-time visitor downloads; the
  // load-more island ships only when there is more board to load.
  const islands: Island[] = ['home-copy'];
  if (page.total > page.rows.length) islands.push('leaderboard-more');

  const title = `clawd.gg — ${BOARDS[board].emoji} ${BOARDS[board].label}, ${
    scope === 'week' ? 'this week' : 'all time'
  }`;

  return c.html(
    <Layout
      title={title}
      description="How you use Claude Code, as a fingerprint. Ranked every week."
      user={user}
      nav={false}
      effects={false}
      islands={islands}
      bodyClass="bg-[#050508] text-[#e6e8ee] font-mono min-h-screen antialiased"
      og={{ title, description: 'How you use Claude Code, as a fingerprint. Ranked every week.' }}
    >
      <HomePage view={view} />
    </Layout>
  );
});

export default app;
