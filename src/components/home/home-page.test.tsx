import { describe, expect, it } from 'bun:test';
import { HomePage, type HomeView } from './HomePage';
import { BoardRowList } from './BoardRows';
import {
  BOARDS,
  BOARD_KEYS,
  SCOPE_LABELS,
  formatBoardValue,
  parseBoard,
  parseScope,
  type BoardKey,
  type BoardRow,
} from '../../lib/boards';

/**
 * The homepage, rendered from a fixture.
 *
 * No database and no clock: HomePage is a pure function of one payload (see
 * its own header), which is the only way the states that matter on day one —
 * one entrant, three entrants — ever get looked at.
 *
 * What is asserted here is the leaderboard READING as one: the podium and the
 * ranked table both, from rank 1, with however few people are on the board,
 * and a load-more offset that continues the ranks instead of repeating or
 * skipping them. Everything is read off whatever the DEFAULT board is, so the
 * default moving does not take this suite with it.
 */

const DEFAULT_BOARD: BoardKey = parseBoard(undefined);
const DEFAULT_SCOPE = parseScope(undefined, DEFAULT_BOARD);

function render(node: unknown): string {
  return String(node);
}

function row(rank: number): BoardRow {
  const value = 1_000_000 * (100 - rank);
  return {
    rank,
    userId: `github_${rank}`,
    username: `dev${rank}`,
    avatarUrl: null,
    value,
    display: formatBoardValue(DEFAULT_BOARD, value),
  };
}

function view(overrides: Partial<HomeView> = {}): HomeView {
  return {
    user: null,
    board: DEFAULT_BOARD,
    scope: DEFAULT_SCOPE,
    rows: [row(1)],
    total: 1,
    resetIn: '2d 4h',
    comparedTo: null,
    complete: true,
    pulse: { devs: 1, valueUsd: 120, ultrathinks: 9, busiestHourUtc: 14, complete: true },
    featuredProfile: 'dev1',
    ...overrides,
  };
}

/** Just the ranked table's rows — the podium prints a rank too, as a title. */
function tableHtml(html: string): string {
  const start = html.indexOf('id="leaderboard-rows"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

/** The ranks a fragment printed, in the order it printed them. */
function ranks(html: string): number[] {
  return [...html.matchAll(/>#(\d+)</g)].map((match) => Number(match[1]));
}

describe('the ranked table is always there', () => {
  /**
   * The finding: `total <= 3` replaced the table with a one-line count, so a
   * board with one, two or three people on it did not look like a board. The
   * top three are now on the podium AND in the table — the repetition is the
   * cheaper half of the trade.
   */
  it('renders the table from rank 1 for a single entrant', () => {
    const html = render(<HomePage view={view()} />);
    expect(ranks(tableHtml(html))).toEqual([1]);
    expect(html).toContain('one dev on this board so far');
    // The podium is still there: one card, not three slots with two holes.
    expect(html).toContain('🥇');
    expect(html).not.toContain('🥈');
  });

  it('keeps the podium and the table in step with three entrants', () => {
    const html = render(<HomePage view={view({ rows: [row(1), row(2), row(3)], total: 3 })} />);
    expect(ranks(tableHtml(html))).toEqual([1, 2, 3]);
    expect(html).toContain('3 devs on this board so far');
    expect(html).toContain('🥉');
    // Nobody is paginated away on a board that fits on one screen.
    expect(html).not.toContain('data-load-more');
  });

  it('has no table at all when nobody is on the board', () => {
    const html = render(<HomePage view={view({ rows: [], total: 0 })} />);
    expect(html).not.toContain('id="leaderboard-rows"');
    expect(html).toContain(
      `no ${BOARDS[DEFAULT_BOARD].label} ${SCOPE_LABELS[DEFAULT_SCOPE]}`
    );
  });
});

describe('pagination starts where the rows do', () => {
  const PAGE = 25;

  /**
   * The offset is the number of rows ALREADY on the page, which is what makes
   * it right whether the table starts at rank 1 or (as it used to) at rank 4:
   * a table of 25 rows that began at rank 4 and asked for offset 25 dropped
   * ranks 26, 27 and 28.
   */
  it('asks for the next page from the end of this one', () => {
    const rows = Array.from({ length: PAGE }, (_, i) => row(i + 1));
    const html = render(<HomePage view={view({ rows, total: 60 })} />);

    expect(ranks(tableHtml(html))).toEqual(rows.map((r) => r.rank));
    expect(html).toContain(`offset=${PAGE}`);
    expect(html).toContain('(35 more)');
  });

  it('continues the ranks across the fragment boundary, with no gap and no repeat', () => {
    const first = Array.from({ length: PAGE }, (_, i) => row(i + 1));
    const second = Array.from({ length: PAGE }, (_, i) => row(PAGE + i + 1));

    const page = render(<HomePage view={view({ rows: first, total: 60 })} />);
    // What GET /rows answers with for the offset the button above carries:
    // `nextOffset = page.offset + page.rows.length` (src/routes/index.tsx).
    const fragment = render(
      <BoardRowList
        board={DEFAULT_BOARD}
        scope={DEFAULT_SCOPE}
        rows={second}
        comparedTo={null}
        remaining={60 - 2 * PAGE}
        nextOffset={2 * PAGE}
      />
    );

    const seen = [...ranks(tableHtml(page)), ...ranks(fragment)];
    expect(seen).toEqual(Array.from({ length: 2 * PAGE }, (_, i) => i + 1));
    expect(new Set(seen).size).toBe(seen.length);
    expect(fragment).toContain(`offset=${2 * PAGE}`);
  });
});

describe('the tabs', () => {
  it('prints the boards in tab order, 🪙 💎 🔥 🌈 ⚡', () => {
    const html = render(<HomePage view={view()} />);
    expect(BOARD_KEYS.map((key) => BOARDS[key].emoji)).toEqual(['🪙', '💎', '🔥', '🌈', '⚡']);

    const positions = BOARD_KEYS.map((key) =>
      html.indexOf(`${BOARDS[key].emoji} ${BOARDS[key].label}`)
    );
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  /**
   * The board a visitor who clicked nothing is looking at. Asserted on the
   * RENDERED page and not just on parseBoard, because the tab drawn as
   * selected and the panel the figures came from have to be the same board.
   */
  it('opens on 🪙 tokens over all time', () => {
    expect([DEFAULT_BOARD, DEFAULT_SCOPE]).toEqual(['tokens', 'all']);

    const html = render(<HomePage view={view()} />);
    const selected = /aria-selected="true"[\s\S]{0,240}?<\/button>/.exec(html)?.[0] ?? '';
    expect(selected).toContain('🪙 tokens');
    expect(html).toContain('aria-label="tokens, all time"');
    // The all-time switch is the one pressed, and its note is the all-time one.
    expect(html).toContain('value="all" aria-pressed="true"');
    expect(html).toContain('every prompt on record');
    // The table's figure column says which board and which window.
    expect(tableHtml(html)).not.toContain('resets Mon');
    expect(html).toContain('🪙 tokens');
  });
});

describe('board tabs carry only a scope their board has', () => {
  /** Each tab's form, as (board, scope) pairs, in tab order. */
  function tabTargets(html: string): [string, string][] {
    const forms = html.match(/<form[^>]*class="contents"[^>]*>[\s\S]*?<\/form>/g) ?? [];
    return forms.map((form) => [
      /name="board" value="([a-z]+)"/.exec(form)?.[1] ?? '',
      /name="scope" value="([a-z]+)"/.exec(form)?.[1] ?? '',
    ]);
  }

  it('sends the 🔥 board’s `current` to none of the others', () => {
    const html = render(<HomePage view={view({ board: 'streak', scope: 'current' })} />);
    const targets = tabTargets(html);
    expect(targets.map(([board]) => board)).toEqual([...BOARD_KEYS]);
    for (const [board, scope] of targets) {
      expect(BOARDS[board as BoardKey].scopes).toContain(scope as never);
      expect(scope).toBe(board === 'streak' ? 'current' : BOARDS[board as BoardKey].defaultScope);
    }
  });

  it('keeps a scope the target board has', () => {
    const html = render(<HomePage view={view({ board: 'value', scope: 'all' })} />);
    for (const [board, scope] of tabTargets(html)) {
      expect(scope).toBe(board === 'streak' ? BOARDS.streak.defaultScope : 'all');
    }
  });
});
