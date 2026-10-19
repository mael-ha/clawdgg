/**
 * GET /api/boards — the five boards, as JSON.
 *
 * The homepage renders from the same `getBoardPage()` call, so this endpoint is
 * not a second implementation of the board: it is the same page payload without
 * the HTML. Anything the API reports is on the page and vice versa, including
 * the figures a profile owner has taken down (src/lib/boards.ts leaves those
 * users off the board that ranks on them — here too, or the API would be a way
 * around the setting).
 */

import { Hono } from 'hono';
import { optionalAuth } from '../lib/auth-middleware';
import type { SessionUser } from '../types';
import {
  BOARDS,
  BOARD_KEYS,
  DEFAULT_BOARD_LIMIT,
  MAX_BOARD_LIMIT,
  boardCaption,
  clampBoardLimit,
  getBoardPage,
  getGlobalPulse,
  parseBoard,
  parseScope,
} from '../lib/boards';

type Variables = {
  user: SessionUser | null;
};

const app = new Hono<{ Variables: Variables }>();

function intParam(raw: string | undefined, fallback: number, max: number): number {
  const parsed = parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, parsed));
}

app.get('/', optionalAuth, async (c) => {
  const board = parseBoard(c.req.query('board'));
  const scope = parseScope(c.req.query('scope'), board);
  // Both bounds are getBoardPage's to enforce — it is the one place that knows
  // how long the board is — and the limit is clamped here too so the `limit`
  // this response REPORTS is the one it was served with.
  const limit = clampBoardLimit(intParam(c.req.query('limit'), DEFAULT_BOARD_LIMIT, MAX_BOARD_LIMIT));
  const offset = intParam(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);

  const page = await getBoardPage({
    board,
    scope,
    limit,
    offset,
    viewerId: c.get('user')?.id ?? null,
  });

  // 503 when a query failed: the rows would be missing figures, and a 200 with
  // an empty board reads as "nobody is on it".
  return c.json(
    {
      board: page.board,
      scope: page.scope,
      meta: {
        emoji: BOARDS[board].emoji,
        label: BOARDS[board].label,
        caption: boardCaption(board, scope),
        scopes: BOARDS[board].scopes,
        // Named, because it is no longer `scopes[0]`: 🪙 prints its switch
        // "this week | all time" and opens on the second one.
        defaultScope: BOARDS[board].defaultScope,
      },
      total: page.total,
      // The CLAMPED offset, which is what the rows came from.
      offset: page.offset,
      limit,
      weekStart: page.weekStart,
      resetIn: page.resetIn,
      rows: page.rows,
    },
    page.complete ? 200 : 503
  );
});

/** The week's global figures — what the pulse strip under the board prints. */
app.get('/pulse', async (c) => {
  const pulse = await getGlobalPulse();
  return c.json(pulse, pulse.complete ? 200 : 503);
});

/** What boards exist, so a client does not have to hardcode the five keys. */
app.get('/list', (c) =>
  c.json({
    boards: BOARD_KEYS.map((key) => ({
      key,
      emoji: BOARDS[key].emoji,
      label: BOARDS[key].label,
      caption: BOARDS[key].caption,
      scopes: BOARDS[key].scopes,
      defaultScope: BOARDS[key].defaultScope,
    })),
  })
);

export default app;
