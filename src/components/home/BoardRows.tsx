import type { FC } from 'hono/jsx';
import { BOARDS, type BoardKey, type BoardRow, type BoardScope } from '../../lib/boards';
import { MiniClock } from './MiniClock';
import { RankDelta, SideFigures } from './RankDelta';

/**
 * The ranked rows under the podium.
 *
 * One grid template, declared once and used by the header and every row, so a
 * column cannot drift between them. Below `sm` the class and the side figures
 * move under the handle: at 390px seven columns is four columns of ellipsis,
 * and the figure the board ranks on has to stay readable.
 *
 * `BoardRowList` is also what GET /rows returns for the load-more island, which
 * is why the rows and their footer are a separate component from the card: the
 * island appends exactly this fragment and drops the button it clicked.
 */

const GRID =
  'grid items-center gap-3 px-4 sm:px-[18px] ' +
  'grid-cols-[2.5rem_2.25rem_1.875rem_minmax(0,1fr)_auto] ' +
  'sm:grid-cols-[3.5rem_2.75rem_2.75rem_minmax(0,1fr)_13.75rem_8.75rem_7.5rem]';

export const SCOPE_LABELS: Record<BoardScope, string> = {
  week: 'this week',
  all: 'all time',
};

interface RowProps {
  row: BoardRow;
  comparedTo: string | null;
}

const Row: FC<RowProps> = ({ row, comparedTo }) => (
  <div
    class={`${GRID} border-b border-[#12151d] py-2.5 font-mono text-[13px] ${
      row.isViewer ? 'bg-[#0c1a14]' : 'hover:bg-[#0e1118]'
    }`}
  >
    <span class="text-[#8a91a0]">#{row.rank}</span>
    <RankDelta row={row} comparedTo={comparedTo} />
    <MiniClock hours={row.hours} size={30} username={row.username} />

    <span class="flex min-w-0 flex-col">
      <span class="flex items-center gap-1.5">
        <a
          href={`/u/${row.username}`}
          class="truncate font-bold text-gray-100 transition-colors hover:text-cyan-400"
        >
          @{row.username}
        </a>
        {row.isViewer && (
          <span class="shrink-0 rounded bg-cyan-400/10 px-1 py-0.5 text-[10px] font-normal text-cyan-400">
            you
          </span>
        )}
      </span>
      {/* The mobile home for the two columns that are hidden below sm. The
          class truncates and the side figures do not: a cut-off "🌈 312 · 🔥 1"
          would read as a smaller number, where a cut-off class still reads. */}
      <span class="flex items-baseline gap-1.5 text-[11px] text-[#8a91a0] sm:hidden">
        {row.classLabel && <span class="min-w-0 truncate">{row.classLabel}</span>}
        <span class="shrink-0">
          <SideFigures row={row} />
        </span>
      </span>
    </span>

    <span class="hidden truncate text-xs text-[#c9ccd4] sm:block">{row.classLabel ?? ''}</span>
    <span class="text-right font-extrabold text-gray-100">{row.display}</span>
    <span class="hidden text-right text-xs text-[#8a91a0] sm:block">
      <SideFigures row={row} />
    </span>
  </div>
);

interface BoardRowListProps {
  board: BoardKey;
  scope: BoardScope;
  rows: BoardRow[];
  comparedTo: string | null;
  /** Rows after this page, if any — the load-more button's reason to exist. */
  remaining: number;
  /** Offset the next page starts at. */
  nextOffset: number;
}

export const BoardRowList: FC<BoardRowListProps> = ({
  board,
  scope,
  rows,
  comparedTo,
  remaining,
  nextOffset,
}) => (
  <>
    {rows.map((row) => (
      <Row key={row.userId} row={row} comparedTo={comparedTo} />
    ))}
    <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 font-mono text-xs text-[#6f7686] sm:px-[18px]">
      <span>
        ranks recomputed hourly
        {comparedTo ? ` · ▲▼ vs ${comparedTo}` : ' · ▲▼ once there is a day to compare'}
      </span>
      {remaining > 0 && (
        <button
          type="button"
          data-load-more={`/rows?board=${board}&scope=${scope}&offset=${nextOffset}`}
          class="min-h-[44px] font-mono text-xs text-cyan-400 transition-colors hover:text-cyan-300"
        >
          full board → <span class="text-[#6f7686]">({remaining} more)</span>
        </button>
      )}
    </div>
  </>
);

interface BoardTableProps extends BoardRowListProps {
  total: number;
}

export const BoardTable: FC<BoardTableProps> = (props) => (
  <div class="overflow-hidden rounded-[14px] border border-[#1a1f2b] bg-[#0b0d12]">
    <div
      class={`${GRID} border-b border-[#1a1f2b] py-2.5 font-mono text-[11px] tracking-[0.06em] text-[#6f7686]`}
    >
      <span>#</span>
      <span class="sr-only">movement</span>
      <span class="text-[10px]">when</span>
      <span>who</span>
      <span class="hidden sm:block">class</span>
      <span class="text-right">
        {BOARDS[props.board].heading} <span class="hidden sm:inline">{SCOPE_LABELS[props.scope]}</span>
      </span>
      <span class="hidden text-right sm:block">🌈 · 🔥</span>
    </div>
    <div id="leaderboard-rows">
      <BoardRowList {...props} />
    </div>
  </div>
);
