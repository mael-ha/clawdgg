import { Hono } from 'hono';
import { optionalAuth } from '../lib/auth-middleware';
import { db } from '../db';
import { dailyStats, users } from '../db/schema';
import { sql, desc, eq } from 'drizzle-orm';
import type { LeaderboardEntry } from '../types';
import { BADGES } from '../lib/badges';
import { formatCost, formatNumber, formatRelativeTime, formatTokens } from '../lib/format';

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

// Row component for HTMX partial rendering
export const LeaderboardRowPartial = LeaderboardRow;

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

async function getLeaderboardData(period: Period, sort: SortKey, limit: number, offset: number = 0) {
  // Build date filter
  let dateFilter = '';
  const now = new Date();
  if (period === 'today') {
    dateFilter = now.toISOString().split('T')[0]!;
  } else if (period === 'week') {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    dateFilter = weekAgo.toISOString().split('T')[0]!;
  } else if (period === 'month') {
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    dateFilter = monthAgo.toISOString().split('T')[0]!;
  }

  const baseQuery = dateFilter
    ? sql`${dailyStats.date} >= ${dateFilter}`
    : sql`1=1`;

  const sortConfig = SORT_OPTIONS[sort];
  const sortColumn = sortConfig.column;

  // Yesterday's date for rank change calculation
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
  const yesterdayQuery = sql`${dailyStats.date} < ${yesterday}`;

  // Fetch leaderboard with user data for badges, streak, cost
  const results = await db
    .select({
      userId: users.id,
      githubUsername: users.githubUsername,
      avatarUrl: users.avatarUrl,
      badges: users.badges,
      currentStreak: users.currentStreak,
      totalCostCents: users.totalCostCents,
      updatedAt: users.updatedAt,
      promptCount: sql<number>`sum(${dailyStats.promptCount})`.as('total_prompts'),
      tokenCount: sql<number>`sum(${dailyStats.tokenCount})`.as('total_tokens'),
      linesWritten: sql<number>`sum(${dailyStats.linesWritten})`.as('total_lines'),
      messageCount: sql<number>`sum(${dailyStats.messageCount})`.as('total_messages'),
      toolCallCount: sql<number>`sum(${dailyStats.toolCallCount})`.as('total_tools'),
      commitCount: sql<number>`sum(${dailyStats.commitCount})`.as('total_commits'),
      sessionCount: sql<number>`sum(${dailyStats.sessionCount})`.as('total_sessions'),
    })
    .from(dailyStats)
    .innerJoin(users, eq(dailyStats.userId, users.id))
    .where(baseQuery)
    .groupBy(users.id, users.githubUsername, users.avatarUrl, users.badges, users.currentStreak, users.totalCostCents, users.updatedAt)
    .orderBy(desc(sql.raw(sortColumn)))
    .limit(limit)
    .offset(offset);

  // Get yesterday's rankings for rank change (simplified - just get prompt totals)
  const yesterdayRanks = new Map<string, number>();
  if (period === 'all') {
    try {
      const yesterdayData = await db
        .select({
          userId: dailyStats.userId,
          total: sql<number>`sum(${dailyStats.promptCount})`.as('total'),
        })
        .from(dailyStats)
        .where(yesterdayQuery)
        .groupBy(dailyStats.userId)
        .orderBy(desc(sql`total`));

      yesterdayData.forEach((row, idx) => {
        yesterdayRanks.set(row.userId, idx + 1);
      });
    } catch (e) {
      // Ignore errors, just won't show rank change
    }
  }

  // Transform results
  const entries: LeaderboardEntry[] = results.map((row, index) => {
    const currentRank = offset + index + 1;
    const yesterdayRank = yesterdayRanks.get(row.userId);
    const rankChange = yesterdayRank ? yesterdayRank - currentRank : 0;

    let badges: string[] = [];
    try {
      badges = row.badges ? JSON.parse(row.badges) : [];
    } catch (e) {
      badges = [];
    }

    return {
      rank: currentRank,
      userId: row.userId,
      githubUsername: row.githubUsername,
      avatarUrl: row.avatarUrl,
      promptCount: row.promptCount || 0,
      tokenCount: row.tokenCount || 0,
      linesWritten: row.linesWritten || 0,
      commitCount: row.commitCount || 0,
      messageCount: row.messageCount || 0,
      toolCallCount: row.toolCallCount || 0,
      sessionCount: row.sessionCount || 0,
      badges,
      currentStreak: row.currentStreak || 0,
      costUsdCents: row.totalCostCents || 0,
      rankChange,
      lastActive: row.updatedAt ? new Date(row.updatedAt) : null,
    };
  });

  // Get total count
  const countResult = await db
    .select({ count: sql<number>`count(distinct ${dailyStats.userId})` })
    .from(dailyStats)
    .where(baseQuery);
  const total = countResult[0]?.count || 0;

  return { entries, total };
}

// ═══════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════

// HTMX endpoint for loading more rows
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
            hx-get={`/rows?period=${period}&sort=${sort}&offset=${nextOffset}`}
            hx-target="#leaderboard-rows"
            hx-swap="beforeend"
            class="px-6 py-2 text-cyan-400 hover:text-cyan-300 border border-cyan-500/30 hover:border-cyan-500/50 rounded-lg font-mono text-sm transition-all load-more-btn"
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

  // Aggregate stats for hero
  const aggregateStats = await db
    .select({
      totalPrompts: sql<number>`sum(${dailyStats.promptCount})`,
      totalTokens: sql<number>`sum(${dailyStats.tokenCount})`,
    })
    .from(dailyStats);

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
      // User not in top entries, calculate their rank
      const userTotalResult = await db
        .select({ total: sql<number>`sum(${dailyStats.promptCount})` })
        .from(dailyStats)
        .where(eq(dailyStats.userId, user.id));
      const userTotal = userTotalResult[0]?.total || 0;

      const higherCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(
          db.select({ userId: dailyStats.userId, total: sql<number>`sum(${dailyStats.promptCount})`.as('total') })
            .from(dailyStats)
            .groupBy(dailyStats.userId)
            .having(sql`total > ${userTotal}`)
            .as('higher')
        );
      currentUserRank = (higherCount[0]?.count || 0) + 1;
    }
  }

  const isUserInPreview = user && entries.some(e => e.userId === user.id);
  const showYourRankPill = currentUserRank && !isUserInPreview && currentUserRank > 0;
  const hasMore = total > initialSize;

  const sortConfig = SORT_OPTIONS[sort];

  return c.html(
    <html lang="en" class="dark">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>clawd.gg - Claude Code Leaderboard</title>
        <meta name="description" content="The leaderboard for Claude Code power users. Track your prompts, tokens, and lines of code." />

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

        <script src="https://cdn.tailwindcss.com"></script>
        <script dangerouslySetInnerHTML={{
          __html: `
            tailwind.config = {
              darkMode: 'class',
              theme: {
                extend: {
                  colors: {
                    cyan: { 400: '#00ff9f', 500: '#00d884' },
                    magenta: { 400: '#ff00ff', 500: '#cc00cc' },
                  },
                  fontFamily: {
                    mono: ['JetBrains Mono', 'monospace'],
                    sans: ['Inter', 'sans-serif'],
                  },
                },
              },
            }
          `
        }} />

        {/* HTMX */}
        <script src="https://unpkg.com/htmx.org@1.9.10"></script>
        <script dangerouslySetInnerHTML={{
          __html: `
            // Remove load more button container after HTMX request
            document.addEventListener('htmx:afterRequest', function(e) {
              if (e.target.classList.contains('load-more-btn')) {
                e.target.parentElement.remove();
              }
            });
          `
        }} />

        <link rel="stylesheet" href="/public/styles.css" />
      </head>
      <body class="bg-black text-gray-100 font-mono min-h-screen antialiased">
        <div class="scanlines pointer-events-none fixed inset-0 z-[100]"></div>
        <div class="grid-bg fixed inset-0 z-0 pointer-events-none"></div>

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

              {/* Load more button (HTMX) */}
              {hasMore && entries.length > 0 && (
                <div class="text-center mt-6" id="load-more-container">
                  <button
                    hx-get={`/rows?period=${period}&sort=${sort}&offset=${initialSize}`}
                    hx-target="#leaderboard-rows"
                    hx-swap="beforeend"
                    class="px-6 py-3 text-cyan-400 hover:text-cyan-300 border border-cyan-500/30 hover:border-cyan-500/50 rounded-lg font-mono text-sm transition-all hover:shadow-lg hover:shadow-cyan-500/10 load-more-btn"
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
      </body>
    </html>
  );
});

export default app;
