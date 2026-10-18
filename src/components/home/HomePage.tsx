import type { FC } from 'hono/jsx';
import type { SessionUser } from '../../types';
import { Wordmark } from '../Layout';
import { BOARDS, type BoardKey, type BoardRow, type BoardScope, type GlobalPulse } from '../../lib/boards';
import { Pitch } from './Pitch';
import { BoardTabs, BOARD_PANEL_ID } from './BoardTabs';
import { Podium } from './Podium';
import { BoardTable, SCOPE_LABELS } from './BoardRows';
import { Pulse } from './Pulse';

/**
 * The homepage, as a pure function of one payload.
 *
 * Nothing in here reaches for a database or a clock: everything it prints
 * arrives in `HomeView`. That is what lets the layout be rendered against a
 * fixture — one user, three users, thirty — without ClickHouse running, which
 * is the only way the small-board states ever get looked at.
 */

export interface HomeView {
  user: SessionUser | null;
  board: BoardKey;
  scope: BoardScope;
  rows: BoardRow[];
  /** Users on this board in total, across every page. */
  total: number;
  /** "2d 4h" until the weekly reset. */
  resetIn: string;
  comparedTo: string | null;
  /** False when a query failed: the page says so instead of printing a zero. */
  complete: boolean;
  pulse: GlobalPulse;
  /** A handle for "see a profile →", when there is one worth linking. */
  featuredProfile: string | null;
}

const Header: FC<{ user: SessionUser | null }> = ({ user }) => (
  <header class="border-b border-[#141821]">
    <div class="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-6 py-4">
      <a href="/" class="font-mono text-lg font-extrabold tracking-tight">
        <Wordmark />
      </a>
      <nav class="flex items-center gap-4 font-mono text-[13px] sm:gap-[22px]">
        <a href="/" class="text-[#e6e8ee] transition-colors hover:text-cyan-400">
          leaderboard
        </a>
        <a href="/about" class="hidden text-[#8a91a0] transition-colors hover:text-cyan-400 sm:block">
          how it works
        </a>
        {user ? (
          <div class="flex items-center gap-3">
            <a
              href={`/u/${user.githubUsername}`}
              class="flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-lg border border-[#262b38] px-3 text-[#e6e8ee] transition-colors hover:border-cyan-400/50 sm:px-3.5"
            >
              {user.avatarUrl && (
                <img src={user.avatarUrl} alt="" class="h-6 w-6 rounded-full" />
              )}
              <span class="text-cyan-400">@{user.githubUsername}</span>
            </a>
            <a href="/auth/logout" class="font-mono text-xs text-[#6f7686] hover:text-[#ff4d6d]">
              [logout]
            </a>
          </div>
        ) : (
          <a
            href="/auth/github"
            class="flex min-h-[44px] items-center whitespace-nowrap rounded-lg border border-[#262b38] px-3 text-[#e6e8ee] transition-colors hover:border-cyan-400/50 sm:px-3.5"
          >
            login with GitHub
          </a>
        )}
      </nav>
    </div>
  </header>
);

/**
 * Nobody on this board yet.
 *
 * Says which board and which scope, because "nothing here" is usually a
 * question about the filter rather than about the site: a brand-new week has an
 * empty value board and a full all-time one.
 */
const EmptyBoard: FC<{ board: BoardKey; scope: BoardScope; loggedIn: boolean }> = ({
  board,
  scope,
  loggedIn,
}) => (
  <div class="rounded-[14px] border border-[#1a1f2b] bg-[#0b0d12] px-6 py-12 text-center">
    <div class="mb-3 text-4xl">{BOARDS[board].emoji}</div>
    <h3 class="mb-1.5 text-lg font-bold text-[#c9ccd4]">
      no {BOARDS[board].label} {SCOPE_LABELS[scope]}
    </h3>
    <p class="font-mono text-[13px] text-[#6f7686]">
      {scope === 'week'
        ? 'the week is young — this board fills as people work'
        : 'nobody has this figure on record yet'}
    </p>
    {!loggedIn && (
      <a
        href="/auth/github"
        class="mt-6 inline-flex min-h-[44px] items-center rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-5 font-mono text-[13px] text-cyan-400 transition-colors hover:bg-cyan-400/20"
      >
        login with GitHub
      </a>
    )}
  </div>
);

const Footer: FC = () => (
  <footer class="border-t border-[#141821] px-6 py-10">
    <div class="mx-auto flex max-w-[1180px] flex-col items-center gap-5 font-mono text-xs text-[#6f7686] sm:flex-row sm:justify-between">
      <span>
        <Wordmark /> <span class="text-[#374151]">v0.2.0</span>
      </span>
      <div class="flex gap-5">
        <a href="/about" class="transition-colors hover:text-cyan-400">
          about
        </a>
        <a href="/api/boards/list" class="transition-colors hover:text-cyan-400">
          api
        </a>
        <a
          href="https://github.com/mael-ha/clawdgg"
          target="_blank"
          rel="noopener noreferrer"
          class="transition-colors hover:text-cyan-400"
        >
          github
        </a>
      </div>
      <span>never sends prompt text</span>
    </div>
  </footer>
);

export const HomePage: FC<{ view: HomeView }> = ({ view }) => {
  const { board, scope, rows, total, comparedTo } = view;
  const nextOffset = rows.length;
  const remaining = Math.max(0, total - nextOffset);
  // With three or fewer entrants the podium IS the board: a table of the same
  // three people under their own cards is a scroll for no information.
  const podiumIsEnough = total <= 3;

  return (
    <div class="min-h-screen bg-[#050508] font-mono text-[#e6e8ee]">
      <Header user={view.user} />

      <main class="mx-auto flex w-full max-w-[1180px] flex-col gap-9 px-4 pb-14 pt-8 sm:px-6 sm:pt-10">
        <Pitch featuredProfile={view.featuredProfile} />

        <section
          id={BOARD_PANEL_ID}
          role="tabpanel"
          aria-label={`${BOARDS[board].label}, ${SCOPE_LABELS[scope]}`}
          class="flex flex-col gap-4"
        >
          <BoardTabs board={board} scope={scope} resetIn={view.resetIn} />

          {!view.complete && (
            <p class="rounded-xl border border-[#5a1a1a] bg-[#1a0a0a] px-4 py-3 font-mono text-xs text-[#ff4d6d]">
              some figures could not be read just now — reload in a moment rather than trust this
              order
            </p>
          )}

          {rows.length === 0 ? (
            <EmptyBoard board={board} scope={scope} loggedIn={!!view.user} />
          ) : (
            <>
              <Podium
                board={board}
                rows={rows.slice(0, 3)}
                comparedTo={comparedTo}
                scopeLabel={SCOPE_LABELS[scope]}
              />
              {podiumIsEnough ? (
                <p class="font-mono text-xs text-[#6f7686]">
                  {total === 1
                    ? 'one dev on this board so far'
                    : `${total} devs on this board so far`}
                  {comparedTo ? ` · ▲▼ vs ${comparedTo}` : ''}
                </p>
              ) : (
                <BoardTable
                  board={board}
                  scope={scope}
                  rows={rows}
                  total={total}
                  comparedTo={comparedTo}
                  remaining={remaining}
                  nextOffset={nextOffset}
                />
              )}
            </>
          )}
        </section>

        <Pulse pulse={view.pulse} />
      </main>

      <Footer />
    </div>
  );
};
