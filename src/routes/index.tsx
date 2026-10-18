import { Hono } from 'hono';
import { Layout } from '../components/Layout';
import { optionalAuth } from '../lib/auth-middleware';
import { db } from '../db';
import { users } from '../db/schema';
import { sql, desc, and, inArray } from 'drizzle-orm';
import type { LeaderboardEntry } from '../types';
import { BADGES } from '../lib/badges';
import { clickhouse, type LeaderboardSort } from '../db/clickhouse';
import { formatCost, formatNumber, formatRelativeTime, formatTokens } from '../lib/format';
import { rankChangesFor, rankOrdering } from '../lib/rank-snapshots';

// Extend Hono types for our app
type Variables = {
  user: import('../types').SessionUser | null;
};

const app = new Hono<{ Variables: Variables }>();

// Valid sort columns with their SQL equivalents
const SORT_OPTIONS = {
  prompts: { column: 'total_prompts', label: 'Prompts' },
  tokens: { column: 'total_tokens', label: 'Tokens' },
  lines: { column: 'total_lines', label: 'Lines' },
} as const;

type SortKey = keyof typeof SORT_OPTIONS;
type Period = 'today' | 'week' | 'month' | 'all';

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function getBadgeEmojis(badgeIds: string[], max: number = 3): string[] {
  return badgeIds
    .slice(0, max)
    .map(id => BADGES[id]?.emoji)
    .filter((e): e is string => !!e);
}

// ═══════════════════════════════════════════════════════════════════════════
// Components
// ═══════════════════════════════════════════════════════════════════════════

interface HeaderProps {
  user: import('../types').SessionUser | null;
}

const Header = ({ user }: HeaderProps) => (
  <header class="border-b border-cyan-500/20 bg-black/80 backdrop-blur-md sticky top-0 z-50">
    <div class="max-w-5xl mx-auto px-4 py-4 flex justify-between items-center">
      <a href="/" class="flex items-center gap-3 group">
        <div class="font-mono text-xl font-bold tracking-tight">
          <span class="text-magenta-400">&gt;</span>{' '}
          <span class="text-gray-100">clawd</span><span class="text-cyan-400">.gg</span>
        </div>
      </a>

      <div class="flex items-center gap-4">
        {user ? (
          <div class="flex items-center gap-3">
            <a
              href={`/u/${user.githubUsername}`}
              class="flex items-center gap-2 px-3 py-1.5 rounded border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors"
            >
              {user.avatarUrl && (
                <img src={user.avatarUrl} alt={user.githubUsername} class="w-6 h-6 rounded-full ring-2 ring-cyan-500/50" />
              )}
              <span class="text-cyan-400 font-mono text-sm">@{user.githubUsername}</span>
            </a>
            <a href="/auth/logout" class="text-gray-500 hover:text-red-400 font-mono text-xs transition-colors">
              [logout]
            </a>
          </div>
        ) : (
          <a
            href="/auth/github"
            class="group relative px-4 py-2 font-mono text-sm overflow-hidden"
          >
            <span class="absolute inset-0 bg-gradient-to-r from-cyan-500 to-magenta-500 opacity-80 group-hover:opacity-100 transition-opacity"></span>
            <span class="absolute inset-[1px] bg-black group-hover:bg-gray-950 transition-colors"></span>
            <span class="relative text-cyan-400 group-hover:text-white transition-colors flex items-center gap-2">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              Login
            </span>
          </a>
        )}
      </div>
    </div>
  </header>
);

interface HeroProps {
  totalUsers: number;
  totalPrompts: number;
  totalTokens: number;
}

const SmallHero = ({ totalUsers, totalPrompts, totalTokens }: HeroProps) => (
  <section class="relative py-12 px-4 text-center overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-b from-cyan-500/5 via-transparent to-transparent"></div>
    <div class="relative z-10 max-w-3xl mx-auto">
      <h1 class="text-4xl sm:text-5xl font-bold tracking-tight mb-3">
        <span class="glitch-text" data-text="clawd.gg">
          <span class="text-gray-100">clawd</span>
          <span class="text-cyan-400">.gg</span>
        </span>
      </h1>
      <p class="text-lg text-gray-400 mb-2">
        The leaderboard for <span class="text-cyan-400">Claude Code</span> power users
      </p>
      <p class="text-gray-600 font-mono text-sm mb-6">
        // I built this. Yes, me—Claude.
      </p>
      <div class="flex justify-center gap-8 text-sm">
        <div class="text-center">
          <div class="text-xl font-bold text-cyan-400">{formatNumber(totalUsers)}</div>
          <div class="text-gray-500 font-mono text-xs">users</div>
        </div>
        <div class="text-center">
          <div class="text-xl font-bold text-magenta-400">{formatNumber(totalPrompts)}</div>
          <div class="text-gray-500 font-mono text-xs">prompts</div>
        </div>
        <div class="text-center">
          <div class="text-xl font-bold text-yellow-400">{formatNumber(totalTokens)}</div>
          <div class="text-gray-500 font-mono text-xs">tokens</div>
        </div>
      </div>
    </div>
  </section>
);

interface PeriodTabProps {
  period: Period;
  currentPeriod: Period;
  currentSort: SortKey;
  label: string;
}

const PeriodTab = ({ period, currentPeriod, currentSort, label }: PeriodTabProps) => {
  const isActive = period === currentPeriod;
  return (
    <a
      href={`/?period=${period}&sort=${currentSort}`}
      class={`px-3 py-1.5 font-mono text-sm transition-all duration-200 border-b-2 ${
        isActive
          ? 'text-cyan-400 border-cyan-400 bg-cyan-400/10'
          : 'text-gray-500 border-transparent hover:text-gray-300 hover:border-gray-600'
      }`}
    >
      {label}
    </a>
  );
};

interface SortOptionProps {
  sort: SortKey;
  currentSort: SortKey;
  currentPeriod: Period;
  label: string;
}

const SortOption = ({ sort, currentSort, currentPeriod, label }: SortOptionProps) => {
  const isActive = sort === currentSort;
  return (
    <a
      href={`/?period=${currentPeriod}&sort=${sort}`}
      class={`block px-4 py-2 text-sm font-mono ${
        isActive
          ? 'bg-cyan-500/20 text-cyan-400'
          : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
      }`}
    >
      {label}
    </a>
  );
};

// Enhanced leaderboard row with badges, streak, cost, rank change, last active
interface RowProps {
  entry: LeaderboardEntry;
  isCurrentUser: boolean;
}

const LeaderboardRow = ({ entry, isCurrentUser }: RowProps) => {
  const isTopThree = entry.rank <= 3;
  const badges = entry.badges ? getBadgeEmojis(entry.badges, 3) : [];
  const streak = entry.currentStreak || 0;
  const costCents = entry.costUsdCents || 0;
  const rankChange = entry.rankChange || 0;
  const lastActive = entry.lastActive ? formatRelativeTime(entry.lastActive) : '';

  return (
    <div
      class={`group flex items-center gap-3 p-3 sm:p-4 rounded-lg transition-all duration-200 ${
        isTopThree
          ? 'bg-gradient-to-r from-gray-900/80 via-gray-900/50 to-transparent border-l-2 ' +
            (entry.rank === 1 ? 'border-l-yellow-400' : entry.rank === 2 ? 'border-l-gray-400' : 'border-l-amber-600')
          : 'hover:bg-gray-900/50'
      } ${isCurrentUser ? 'ring-2 ring-cyan-500/50 shadow-lg shadow-cyan-500/20' : ''}`}
    >
      {/* Rank + Change */}
      <div class="flex items-center gap-1 flex-shrink-0">
        <div class={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg ${
          entry.rank === 1 ? 'bg-gradient-to-br from-yellow-400 to-amber-600' :
          entry.rank === 2 ? 'bg-gradient-to-br from-gray-300 to-gray-500' :
          entry.rank === 3 ? 'bg-gradient-to-br from-amber-600 to-amber-800' :
          'border border-gray-700'
        }`}>
          <span class={`font-bold text-sm ${entry.rank <= 3 ? 'text-black' : 'text-gray-500 font-mono'}`}>
            {entry.rank}
          </span>
        </div>
        {/* Rank change indicator */}
        {rankChange !== 0 && (
          <span class={`text-xs font-mono ${rankChange > 0 ? 'text-green-400' : 'text-red-400'}`}>
            {rankChange > 0 ? `↑${rankChange}` : `↓${Math.abs(rankChange)}`}
          </span>
        )}
      </div>

      {/* User info + badges + streak */}
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gray-800 overflow-hidden flex-shrink-0">
          {entry.avatarUrl ? (
            <img src={entry.avatarUrl} alt={entry.githubUsername} class="w-full h-full object-cover" />
          ) : (
            <div class="w-full h-full flex items-center justify-center text-gray-500 font-mono text-xs">
              {entry.githubUsername.slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>
        <div class="flex flex-col min-w-0">
          <div class="flex items-center gap-1.5">
            <a
              href={`/u/${entry.githubUsername}`}
              class="text-gray-100 font-medium hover:text-cyan-400 transition-colors truncate text-sm"
            >
              @{entry.githubUsername}
            </a>
            {isCurrentUser && (
              <span class="text-[10px] text-cyan-400 font-mono px-1 py-0.5 bg-cyan-500/10 rounded hidden sm:inline">you</span>
            )}
          </div>
          {/* Badges + Streak row */}
          <div class="flex items-center gap-1.5 mt-0.5">
            {streak >= 3 && (
              <span class="text-orange-400 text-xs" title={`${streak}-day streak`}>
                🔥{streak}
              </span>
            )}
            {badges.length > 0 && (
              <span class="text-xs" title="Badges">
                {badges.join('')}
              </span>
            )}
            {lastActive && (
              <span class="text-gray-600 text-[10px] font-mono hidden sm:inline" title="Last active">
                {lastActive}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div class="flex items-center gap-1.5 flex-wrap justify-end">
        {/* Prompts - primary */}
        <div class="flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 text-xs font-mono" title="Prompts">
          <span>{entry.promptCount.toLocaleString()}</span>
        </div>
        {/* Lines */}
        {entry.linesWritten > 0 && (
          <div class="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-xs font-mono" title="Lines written">
            <span>{formatTokens(entry.linesWritten)}</span>
          </div>
        )}
        {/* Cost */}
        {costCents > 0 && (
          <div class="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 text-xs font-mono" title="Cost">
            <span>{formatCost(costCents)}</span>
          </div>
        )}
        {/* Tokens */}
        <div class="flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-xs font-mono" title="Tokens">
          <span>{formatTokens(entry.tokenCount)}</span>
        </div>
      </div>
    </div>
  );
};

interface YourRankPillProps {
  rank: number;
  total: number;
}

const YourRankPill = ({ rank, total }: YourRankPillProps) => {
  const percentile = Math.max(1, Math.ceil((rank / total) * 100));
  return (
    <div class="flex justify-center mb-4">
      <div class="flex items-center gap-3 px-4 py-2 bg-gray-900/95 backdrop-blur border border-cyan-500/50 rounded-full shadow-lg shadow-cyan-500/20">
        <span class="text-cyan-400 font-mono text-sm">You're #{rank}</span>
        <span class="text-gray-500 text-xs">Top {percentile}%</span>
      </div>
    </div>
  );
};

const HowItWorks = () => (
  <section class="py-16 px-4 border-t border-gray-800">
    <div class="max-w-5xl mx-auto">
      <h2 class="text-xl font-bold text-center mb-10">
        <span class="text-gray-400">&gt;</span> How It Works
      </h2>
      <div class="grid md:grid-cols-3 gap-6">
        <div class="relative p-5 border border-gray-800 rounded-lg bg-gray-950/50 hover:border-cyan-500/30 transition-colors">
          <div class="absolute -top-3 -left-3 w-7 h-7 bg-cyan-500 rounded-lg flex items-center justify-center font-bold text-black text-sm">1</div>
          <div class="text-3xl mb-3">📦</div>
          <h3 class="text-base font-bold text-gray-100 mb-1">Install the CLI</h3>
          <p class="text-gray-500 text-sm font-mono">npm install -g clawdgg</p>
        </div>
        <div class="relative p-5 border border-gray-800 rounded-lg bg-gray-950/50 hover:border-magenta-500/30 transition-colors">
          <div class="absolute -top-3 -left-3 w-7 h-7 bg-magenta-500 rounded-lg flex items-center justify-center font-bold text-black text-sm">2</div>
          <div class="text-3xl mb-3">🔑</div>
          <h3 class="text-base font-bold text-gray-100 mb-1">Login with GitHub</h3>
          <p class="text-gray-500 text-sm font-mono">clawdgg login</p>
        </div>
        <div class="relative p-5 border border-gray-800 rounded-lg bg-gray-950/50 hover:border-blue-500/30 transition-colors">
          <div class="absolute -top-3 -left-3 w-7 h-7 bg-blue-500 rounded-lg flex items-center justify-center font-bold text-black text-sm">3</div>
          <div class="text-3xl mb-3">🚀</div>
          <h3 class="text-base font-bold text-gray-100 mb-1">Sync &amp; Compete</h3>
          <p class="text-gray-500 text-sm font-mono">clawdgg setup</p>
        </div>
      </div>
    </div>
  </section>
);

const Footer = () => (
  <footer class="border-t border-gray-800 py-10 px-4">
    <div class="max-w-5xl mx-auto">
      <div class="flex flex-col md:flex-row justify-between items-center gap-6">
        <div class="text-gray-500 font-mono text-sm">
          <span class="text-cyan-400">&gt;</span> clawd.gg
          <span class="text-gray-700 ml-2">v0.2.0</span>
        </div>
        <div class="flex gap-6 text-sm font-mono">
          <a href="/about" class="text-gray-500 hover:text-cyan-400 transition-colors">About</a>
          <a href="https://github.com/anthropics/claude-code" target="_blank" rel="noopener noreferrer" class="text-gray-500 hover:text-cyan-400 transition-colors">Claude Code</a>
          <a href="https://github.com/mael-ha/clawdgg" target="_blank" rel="noopener noreferrer" class="text-gray-500 hover:text-cyan-400 transition-colors">GitHub</a>
        </div>
        <div class="text-gray-600 text-xs font-mono text-center md:text-right">
          <a href="/about" class="hover:text-cyan-400 transition-colors">Built by Claude</a>
        </div>
      </div>
      <div class="mt-8 text-center">
        <pre class="text-gray-800 text-xs inline-block">{`    .---.
   /     \\
   \\.@-@./
   /\`\\_/\`\\
  //  _  \\\\
 | \\     )|_
/\`\\_\`>  <_/ \\
\\__/'---'\\__/`}</pre>
      </div>
      <div class="mt-4 text-center text-gray-700 text-xs font-mono">// EOF</div>
    </div>
  </footer>
);

const EmptyState = ({ isLoggedIn }: { isLoggedIn: boolean }) => (
  <div class="text-center py-16">
    <div class="text-5xl mb-4">🏆</div>
    <h3 class="text-xl font-bold text-gray-400 mb-2">The leaderboard awaits</h3>
    <p class="text-gray-600 font-mono text-sm mb-6">No one's here yet. Be the first!</p>
    {!isLoggedIn && (
      <a href="/auth/github" class="inline-flex items-center gap-2 px-5 py-2.5 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 hover:border-cyan-500/50 rounded-lg font-mono text-cyan-400 text-sm transition-all">
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
        </svg>
        Login with GitHub
      </a>
    )}
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════
// Data Fetching
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The homepage leaderboard.
 *
 * All-time reads `users.total_*`, which src/jobs/sync-clickhouse.ts fills from
 * ClickHouse; period views ask ClickHouse directly. This used to GROUP BY over
 * SQLite daily_stats for every period, which meant the homepage and the
 * profile page could print different totals for the same person — the
 * homepage summed what the old CLI had uploaded, the profile showed what
 * OTEL had measured.
 *
 * Membership rule, same as /api/leaderboard: a user is listed when ClickHouse
 * has usage for them, and `users.total_*` IS that answer.
 */
const HAS_USAGE = sql`(COALESCE(${users.totalPrompts}, 0) > 0 OR COALESCE(${users.totalTokens}, 0) > 0)`;

const SORT_COLUMNS = {
  prompts: { sqlite: users.totalPrompts, ch: 'prompts' },
  tokens: { sqlite: users.totalTokens, ch: 'tokens' },
  lines: { sqlite: users.totalLinesAdded, ch: 'lines' },
} as const;

async function getLeaderboardData(period: Period, sort: SortKey, limit: number, offset: number = 0) {
  const column = SORT_COLUMNS[sort];

  if (period !== 'all') {
    return getPeriodLeaderboard(period, column.ch, limit, offset);
  }

  const results = await db
    .select({
      userId: users.id,
      githubUsername: users.githubUsername,
      avatarUrl: users.avatarUrl,
      badges: users.badges,
      currentStreak: users.currentStreak,
      totalCostCents: users.totalCostCents,
      updatedAt: users.updatedAt,
      promptCount: users.totalPrompts,
      tokenCount: users.totalTokens,
      linesWritten: users.totalLinesAdded,
      commitCount: users.totalCommits,
    })
    .from(users)
    .where(HAS_USAGE)
    // The tiebreaker is load-bearing, not tidiness: without it two users on
    // the same total come back in an arbitrary order, and the rank snapshot
    // would show both a phantom move every day. src/lib/rank-snapshots.ts.
    .orderBy(...rankOrdering(column.sqlite))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(HAS_USAGE);

  const entries: LeaderboardEntry[] = results.map((row, index) => ({
    rank: offset + index + 1,
    userId: row.userId,
    githubUsername: row.githubUsername,
    avatarUrl: row.avatarUrl,
    promptCount: row.promptCount || 0,
    tokenCount: row.tokenCount || 0,
    linesWritten: row.linesWritten || 0,
    commitCount: row.commitCount || 0,
    badges: parseBadges(row.badges),
    currentStreak: row.currentStreak || 0,
    costUsdCents: row.totalCostCents || 0,
    lastActive: row.updatedAt ? new Date(row.updatedAt) : null,
  }));

  // The arrows. Only on the all-time board, and only for users who were in the
  // previous snapshot — see rankChangesFor for why a period board gets none.
  const changes = await rankChangesFor(
    sort,
    entries.map(e => e.userId),
    new Map(entries.map(e => [e.userId, e.rank]))
  );
  for (const entry of entries) {
    const change = changes.get(entry.userId);
    if (change !== undefined) entry.rankChange = change;
  }

  return { entries, total: countResult[0]?.count || 0 };
}

/** today / week / month — straight from ClickHouse, which is the only store that has days. */
async function getPeriodLeaderboard(
  period: Exclude<Period, 'all'>,
  sortBy: LeaderboardSort,
  limit: number,
  offset: number
) {
  const chResults = await clickhouse.getLeaderboard(period, sortBy, limit, offset);
  const userIds = chResults.entries.map(e => e.user_id);

  const userInfos = userIds.length
    ? await db
        .select({
          id: users.id,
          githubUsername: users.githubUsername,
          avatarUrl: users.avatarUrl,
          badges: users.badges,
          currentStreak: users.currentStreak,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const userMap = new Map(userInfos.map(u => [u.id, u]));

  const entries: LeaderboardEntry[] = chResults.entries
    .filter(e => userMap.has(e.user_id))
    .map((e, index) => {
      const u = userMap.get(e.user_id)!;
      return {
        rank: offset + index + 1,
        userId: e.user_id,
        githubUsername: u.githubUsername,
        avatarUrl: u.avatarUrl,
        promptCount: e.total_prompts,
        tokenCount: e.total_tokens,
        linesWritten: e.total_lines_added,
        commitCount: e.total_commits,
        badges: parseBadges(u.badges),
        currentStreak: u.currentStreak || 0,
        // Period cost comes from ClickHouse too, so it matches the row's period.
        costUsdCents: Math.round(e.total_cost_usd * 100),
        lastActive: u.updatedAt ? new Date(u.updatedAt) : null,
      };
    });

  return { entries, total: chResults.total };
}

function parseBadges(raw: string | null): string[] {
  try {
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════

// HTML fragment the leaderboard-more island appends (rows + the next button)
app.get('/rows', optionalAuth, async (c) => {
  const user = c.get('user');
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const period = (c.req.query('period') || 'all') as Period;
  const sortParam = c.req.query('sort') || 'prompts';
  const sort = (sortParam in SORT_OPTIONS ? sortParam : 'prompts') as SortKey;
  const limit = 20; // Load 20 more at a time

  const { entries, total } = await getLeaderboardData(period, sort, limit, offset);
  const nextOffset = offset + entries.length;
  const hasMore = nextOffset < total;

  // Return just the rows + load more button (no full page)
  return c.html(
    <div>
      {entries.map((entry) => (
        <LeaderboardRow
          key={entry.userId}
          entry={entry}
          isCurrentUser={user?.id === entry.userId}
        />
      ))}
      {hasMore && (
        <div class="text-center mt-4">
          <button
            data-load-more={`/rows?period=${period}&sort=${sort}&offset=${nextOffset}`}
            class="px-6 py-2 text-cyan-400 hover:text-cyan-300 border border-cyan-500/30 hover:border-cyan-500/50 rounded-lg font-mono text-sm transition-all"
          >
            Load More ({total - nextOffset} remaining)
          </button>
        </div>
      )}
    </div>
  );
});

// Homepage - Top 42 + How It Works
app.get('/', optionalAuth, async (c) => {
  const user = c.get('user');
  const initialSize = 25; // Show 25 initially (fits well on screen)
  const period = (c.req.query('period') || 'all') as Period;
  const sortParam = c.req.query('sort') || 'prompts';
  const sort = (sortParam in SORT_OPTIONS ? sortParam : 'prompts') as SortKey;

  const { entries, total } = await getLeaderboardData(period, sort, initialSize);

  // Hero totals: the same synced columns the rows above are ordered by, so the
  // headline and the list can't disagree. (They used to: the hero summed
  // daily_stats across ALL users including ones the list filtered out.)
  const aggregateStats = await db
    .select({
      totalPrompts: sql<number>`COALESCE(sum(${users.totalPrompts}), 0)`,
      totalTokens: sql<number>`COALESCE(sum(${users.totalTokens}), 0)`,
    })
    .from(users)
    .where(HAS_USAGE);

  const heroStats = {
    totalUsers: total,
    totalPrompts: aggregateStats[0]?.totalPrompts || 0,
    totalTokens: aggregateStats[0]?.totalTokens || 0,
  };

  // Get current user's rank if logged in
  let currentUserRank: number | undefined;
  if (user) {
    const userEntry = entries.find(e => e.userId === user.id);
    if (userEntry) {
      currentUserRank = userEntry.rank;
    } else {
      // Not in the visible rows: count how many users are ahead on the same
      // column the leaderboard is ordered by.
      const ahead = await db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(
          and(
            HAS_USAGE,
            sql`COALESCE(${users.totalPrompts}, 0) > (SELECT COALESCE(total_prompts, 0) FROM users WHERE id = ${user.id})`
          )
        );
      currentUserRank = (ahead[0]?.count || 0) + 1;
    }
  }

  const isUserInPreview = user && entries.some(e => e.userId === user.id);
  const showYourRankPill = currentUserRank && !isUserInPreview && currentUserRank > 0;
  const hasMore = total > initialSize;

  const sortConfig = SORT_OPTIONS[sort];

  return c.html(
    <Layout
      title="clawd.gg - Claude Code Leaderboard"
      user={user}
      nav={false}
      islands={hasMore && entries.length > 0 ? ['leaderboard-more'] : []}
    >
      <div class="relative z-10">
        <Header user={user} />
        <SmallHero
          totalUsers={heroStats.totalUsers}
          totalPrompts={heroStats.totalPrompts}
          totalTokens={heroStats.totalTokens}
        />

        <section class="px-4 pb-8">
          <div class="max-w-5xl mx-auto">
            {/* Filters row */}
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <div class="flex gap-1 border-b border-gray-800">
                <PeriodTab period="today" currentPeriod={period} currentSort={sort} label="Today" />
                <PeriodTab period="week" currentPeriod={period} currentSort={sort} label="Week" />
                <PeriodTab period="month" currentPeriod={period} currentSort={sort} label="Month" />
                <PeriodTab period="all" currentPeriod={period} currentSort={sort} label="All" />
              </div>

              <div class="relative group">
                <button class="flex items-center gap-2 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded font-mono text-sm text-gray-400 hover:border-gray-600 transition-colors">
                  Sort: {sortConfig.label}
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <div class="absolute right-0 mt-1 w-36 bg-gray-900 border border-gray-700 rounded overflow-hidden opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                  <SortOption sort="prompts" currentSort={sort} currentPeriod={period} label="Prompts" />
                  <SortOption sort="tokens" currentSort={sort} currentPeriod={period} label="Tokens" />
                  <SortOption sort="lines" currentSort={sort} currentPeriod={period} label="Lines" />
                </div>
              </div>
            </div>

            {/* Your rank pill */}
            {showYourRankPill && (
              <YourRankPill rank={currentUserRank!} total={total} />
            )}

            {/* Leaderboard */}
            <div id="leaderboard-rows" class="space-y-1.5">
              {entries.length > 0 ? (
                entries.map((entry) => (
                  <LeaderboardRow
                    key={entry.userId}
                    entry={entry}
                    isCurrentUser={user?.id === entry.userId}
                  />
                ))
              ) : (
                <EmptyState isLoggedIn={!!user} />
              )}
            </div>

            {/* Load more (leaderboard-more island) */}
            {hasMore && entries.length > 0 && (
              <div class="text-center mt-6">
                <button
                  data-load-more={`/rows?period=${period}&sort=${sort}&offset=${initialSize}`}
                  class="px-6 py-3 text-cyan-400 hover:text-cyan-300 border border-cyan-500/30 hover:border-cyan-500/50 rounded-lg font-mono text-sm transition-all hover:shadow-lg hover:shadow-cyan-500/10"
                >
                  Load More ({total - initialSize} remaining)
                </button>
              </div>
            )}

            {/* Stats footer */}
            {entries.length > 0 && (
              <div class="mt-6 pt-4 border-t border-gray-800 flex justify-center gap-6 text-gray-500 text-xs font-mono">
                <span>{total.toLocaleString()} users total</span>
              </div>
            )}
          </div>
        </section>

        <HowItWorks />
        <Footer />
      </div>
    </Layout>
  );
});

export default app;
