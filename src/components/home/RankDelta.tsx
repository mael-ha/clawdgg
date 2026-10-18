import type { FC } from 'hono/jsx';
import type { BoardRow } from '../../lib/boards';

/**
 * Which way someone is moving — and, just as importantly, the three different
 * kinds of nothing.
 *
 *   ▲ 3 / ▼ 1  they moved since the last snapshot
 *   —          they were here yesterday and held their place
 *   new        they were not on this board in the last snapshot
 *   (blank)    this board has no snapshot to compare against yet
 *
 * The last two are why `comparedTo` exists. Printing "new" beside every row on
 * a board nobody has ever snapshotted would be a claim about 25 people that
 * happens to be unfalsifiable.
 */
export const RankDelta: FC<{ row: BoardRow; comparedTo: string | null }> = ({
  row,
  comparedTo,
}) => {
  if (!comparedTo) return <span class="text-[11px]" aria-hidden="true"></span>;

  if (row.change === undefined) {
    return (
      <span class="font-mono text-[11px] text-cyan-300" title="new on this board">
        new
      </span>
    );
  }
  if (row.change === 0) {
    return (
      <span class="font-mono text-[11px] text-[#6f7686]" title={`unchanged since ${comparedTo}`}>
        —
      </span>
    );
  }

  const up = row.change > 0;
  return (
    <span
      class={`font-mono text-[11px] ${up ? 'text-cyan-400' : 'text-[#ff4d6d]'}`}
      title={`${up ? 'up' : 'down'} ${Math.abs(row.change)} since ${comparedTo}`}
    >
      {up ? '▲' : '▼'} {Math.abs(row.change)}
    </span>
  );
};

/**
 * 🌈 ultrathinks · 🔥 streak, beside whichever board is being shown.
 *
 * Either half is ABSENT when its owner hid the section behind it, or when the
 * board already prints it, which is why the separator is assembled rather than
 * hardcoded: "🌈 312 · " with nothing after it would read as a missing number
 * instead of a private one.
 *
 * With neither half, the column is EMPTY. A lone separator is a mark with no
 * meaning — it looks like a figure that failed to render rather than one that
 * was never going to be there.
 */
export const SideFigures: FC<{ row: BoardRow }> = ({ row }) => {
  const parts: string[] = [];
  if (row.ultrathinks !== undefined) parts.push(`🌈 ${row.ultrathinks.toLocaleString('en-US')}`);
  if (row.streak !== undefined) parts.push(`🔥 ${row.streak}`);
  return <>{parts.join(' · ')}</>;
};
