import type { FC } from 'hono/jsx';
import { BOARDS, BOARD_KEYS, type BoardKey, type BoardScope } from '../../lib/boards';

/**
 * Which board, and over what — as two GET forms.
 *
 * NO JAVASCRIPT. The selection lives in the URL (`/?board=streak&scope=all`),
 * which makes every board a link someone can send; and because the controls are
 * submit buttons in a form, they work with the keyboard, with a screen reader,
 * and with scripting off. A div with an onclick would have been none of those.
 *
 * `role="tab"` sits on real <button>s, so Tab reaches them and Enter and Space
 * both activate them for free.
 */

export const BOARD_PANEL_ID = 'board-panel';

/** Six stops, the ultrathink rainbow. Also on the profile's ultrathink badge. */
const RAINBOW =
  'bg-[linear-gradient(90deg,#ff00ff,#ff4d8d,#fbbf24,#00ff9f,#67e8f9,#c084fc)] bg-clip-text text-transparent';

const TAB_BASE =
  'min-h-[44px] rounded-[10px] border px-3.5 font-mono text-[13px] transition-colors';
const TAB_ON = 'border-[#5a1a5a] bg-[#1a0a1a] font-bold text-magenta-400';
const TAB_OFF = 'border-[#1a1f2b] bg-[#0b0d12] text-[#8a91a0] hover:text-[#c9ccd4]';

interface BoardTabsProps {
  board: BoardKey;
  scope: BoardScope;
  /** "2d 4h" until the weekly reset. */
  resetIn: string;
}

export const BoardTabs: FC<BoardTabsProps> = ({ board, scope, resetIn }) => (
  <div class="flex flex-wrap items-center justify-between gap-3.5">
    <form
      method="get"
      action="/"
      role="tablist"
      aria-label="Boards"
      class="flex flex-wrap gap-1.5"
    >
      <input type="hidden" name="scope" value={scope} />
      {BOARD_KEYS.map((key) => {
        const active = key === board;
        return (
          <button
            key={key}
            type="submit"
            name="board"
            value={key}
            role="tab"
            aria-selected={active ? 'true' : 'false'}
            aria-controls={BOARD_PANEL_ID}
            class={`${TAB_BASE} ${active ? TAB_ON : TAB_OFF}`}
          >
            {key === 'ultrathinks' ? (
              <span class={`font-extrabold ${RAINBOW}`}>
                {BOARDS[key].emoji} {BOARDS[key].label}
              </span>
            ) : (
              <>
                {BOARDS[key].emoji} {BOARDS[key].label}
              </>
            )}
          </button>
        );
      })}
    </form>

    <div class="flex flex-wrap items-center gap-3 font-mono text-xs text-[#8a91a0]">
      <form
        method="get"
        action="/"
        class="flex rounded-lg border border-[#1a1f2b] bg-[#0b0d12] p-[3px]"
      >
        <input type="hidden" name="board" value={board} />
        <button
          type="submit"
          name="scope"
          value="week"
          aria-pressed={scope === 'week' ? 'true' : 'false'}
          class={`rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors ${
            scope === 'week' ? 'bg-[#1a1f2b] text-[#e6e8ee]' : 'text-[#8a91a0] hover:text-[#c9ccd4]'
          }`}
        >
          this week
        </button>
        <button
          type="submit"
          name="scope"
          value="all"
          aria-pressed={scope === 'all' ? 'true' : 'false'}
          class={`rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors ${
            scope === 'all' ? 'bg-[#1a1f2b] text-[#e6e8ee]' : 'text-[#8a91a0] hover:text-[#c9ccd4]'
          }`}
        >
          all time
        </button>
      </form>

      {/* UTC is named: the week is the same week for everyone, which is not the
          clock the rest of the site reads (see src/lib/boards.ts). */}
      {scope === 'week' ? (
        <span>
          resets Mon 00:00 UTC · <span class="text-[#e6e8ee]">in {resetIn}</span>
        </span>
      ) : (
        <span>every prompt on record</span>
      )}
      {BOARDS[board].scopeless && (
        <span class="text-[#6f7686]">· a streak is a live figure, the scope does not change it</span>
      )}
    </div>
  </div>
);
