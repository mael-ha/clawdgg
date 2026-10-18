import type { FC } from 'hono/jsx';
import { BOARDS, BOARD_KEYS, SCOPE_LABELS, type BoardKey, type BoardScope } from '../../lib/boards';

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
      {/* The pair differs per board: 💎 🌈 ⚡ switch between windows of time,
          🔥 between the run you are on and the longest one you ever had —
          because "this week's streak" is not a number anybody has. */}
      <form
        method="get"
        action="/"
        class="flex rounded-lg border border-[#1a1f2b] bg-[#0b0d12] p-[3px]"
      >
        <input type="hidden" name="board" value={board} />
        {BOARDS[board].scopes.map((option) => (
          <button
            key={option}
            type="submit"
            name="scope"
            value={option}
            aria-pressed={scope === option ? 'true' : 'false'}
            class={`rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors ${
              scope === option ? 'bg-[#1a1f2b] text-[#e6e8ee]' : 'text-[#8a91a0] hover:text-[#c9ccd4]'
            }`}
          >
            {SCOPE_LABELS[option]}
          </button>
        ))}
      </form>

      {/* UTC is named: the week is the same week for everyone, which is not the
          clock the rest of the site reads (see src/lib/boards.ts). */}
      {scope === 'week' && (
        <span>
          resets Mon 00:00 UTC · <span class="text-[#e6e8ee]">in {resetIn}</span>
        </span>
      )}
      {scope === 'all' && <span>every prompt on record</span>}
      {scope === 'current' && <span>a run ends the first day without a prompt</span>}
      {scope === 'best' && <span>the longest run anyone has finished or is still on</span>}
    </div>
  </div>
);
