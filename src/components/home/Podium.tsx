import type { FC } from 'hono/jsx';
import { BOARDS, type BoardKey, type BoardRow } from '../../lib/boards';
import { MiniClock } from './MiniClock';
import { RankDelta, SideFigures } from './RankDelta';

/**
 * The top three, as cards.
 *
 * Built to survive a small board: with two entrants it is two cards, with one
 * it is one — never three slots with two filled and a hole where third place
 * would be. A leaderboard with one person on it is a true leaderboard with one
 * person on it, and it should look deliberate rather than broken.
 *
 * #1 sits in the MIDDLE and stands tallest, which is what a podium is. On a
 * phone the order is 1-2-3 top to bottom instead: a single column has no middle
 * to be the centre of, and "the first card is the winner" is the only reading
 * that works there.
 */

const MEDALS = ['🥇', '🥈', '🥉'] as const;
const HEIGHTS = ['min-h-[230px]', 'min-h-[200px]', 'min-h-[190px]'] as const;
const BORDERS = ['border-[#5a1a5a]', 'border-[#262b38]', 'border-[#262b38]'] as const;

/**
 * Wide screens put gold in the middle; the DOM stays in rank order so a phone
 * (and a screen reader) reads 1, 2, 3. With fewer than three cards there is no
 * middle to centre, so they stay in rank order everywhere.
 */
const CENTERED_GOLD = ['sm:order-2', 'sm:order-1', 'sm:order-3'] as const;

interface PodiumProps {
  board: BoardKey;
  /** The first three rows of the board, in rank order. 0–3 of them. */
  rows: BoardRow[];
  comparedTo: string | null;
  scopeLabel: string;
}

const PodiumCard: FC<{
  board: BoardKey;
  row: BoardRow;
  place: number;
  order: string;
  comparedTo: string | null;
  scopeLabel: string;
}> = ({ board, row, place, order, comparedTo, scopeLabel }) => (
  <div
    class={`flex flex-col gap-2.5 rounded-[14px] border bg-[#0b0d12] p-[18px] ${BORDERS[place]} ${HEIGHTS[place]} ${order} ${
      row.isViewer ? 'ring-1 ring-cyan-400/40' : ''
    }`}
  >
    <div class="flex items-center justify-between">
      <span class="text-[26px]" title={`#${row.rank}`}>
        {MEDALS[place]}
      </span>
      <RankDelta row={row} comparedTo={comparedTo} />
    </div>

    <div class="flex items-center gap-3">
      <MiniClock hours={row.hours} size={54} username={row.username} />
      <div class="flex min-w-0 flex-col gap-[3px]">
        <a
          href={`/u/${row.username}`}
          class="truncate text-base font-bold text-gray-100 transition-colors hover:text-cyan-400"
        >
          @{row.username}
        </a>
        <span class="truncate text-xs text-[#c9ccd4]">{row.classLabel ?? ''}</span>
      </div>
    </div>

    <span class="text-[32px] font-extrabold leading-none tracking-[-0.03em] text-magenta-400">
      {row.display}
    </span>
    <span class="text-[11px] text-[#6f7686]">
      {BOARDS[board].caption} · {scopeLabel}
    </span>
    <span class="mt-auto text-[11px] text-[#8a91a0]">
      <SideFigures row={row} />
    </span>
  </div>
);

export const Podium: FC<PodiumProps> = ({ board, rows, comparedTo, scopeLabel }) => {
  if (rows.length === 0) return null;

  // Two entrants get two columns, not three with a gap. One gets a single card
  // at podium width rather than a lonely third of the page.
  const columns =
    rows.length >= 3
      ? 'sm:grid-cols-3'
      : rows.length === 2
        ? 'sm:grid-cols-2'
        : 'sm:grid-cols-1 sm:max-w-sm';

  return (
    <div class={`grid grid-cols-1 items-end gap-3.5 ${columns}`}>
      {rows.slice(0, 3).map((row, place) => (
        <PodiumCard
          key={row.userId}
          board={board}
          row={row}
          place={place}
          order={rows.length >= 3 ? CENTERED_GOLD[place]! : ''}
          comparedTo={comparedTo}
          scopeLabel={scopeLabel}
        />
      ))}
    </div>
  );
};
