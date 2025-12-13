import type { FC } from 'hono/jsx';
import type { LeaderboardEntry } from '../types';
import { formatBadgesCompact } from '../lib/badges';

type Period = 'today' | 'week' | 'month' | 'all';

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  period: Period;
  total: number;
  page: number;
  pageSize: number;
}

// Rank badge component with special styling for top 3
const RankBadge: FC<{ rank: number }> = ({ rank }) => {
  if (rank === 1) {
    return (
      <div class="relative flex items-center justify-center w-10 h-10">
        <div class="absolute inset-0 bg-gradient-to-br from-yellow-400 to-amber-600 rounded-lg animate-pulse-slow"></div>
        <div class="absolute inset-[2px] bg-black rounded-lg flex items-center justify-center">
          <span class="text-yellow-400 font-bold text-lg">1</span>
        </div>
        <span class="absolute -top-1 -right-1 text-xs">&#x1F451;</span>
      </div>
    );
  }
  if (rank === 2) {
    return (
      <div class="relative flex items-center justify-center w-10 h-10">
        <div class="absolute inset-0 bg-gradient-to-br from-gray-300 to-gray-500 rounded-lg"></div>
        <div class="absolute inset-[2px] bg-black rounded-lg flex items-center justify-center">
          <span class="text-gray-300 font-bold text-lg">2</span>
        </div>
      </div>
    );
  }
  if (rank === 3) {
    return (
      <div class="relative flex items-center justify-center w-10 h-10">
        <div class="absolute inset-0 bg-gradient-to-br from-amber-600 to-amber-800 rounded-lg"></div>
        <div class="absolute inset-[2px] bg-black rounded-lg flex items-center justify-center">
          <span class="text-amber-600 font-bold text-lg">3</span>
        </div>
      </div>
    );
  }
  return (
    <div class="flex items-center justify-center w-10 h-10 border border-gray-700 rounded-lg">
      <span class="text-gray-500 font-mono text-sm">{rank}</span>
    </div>
  );
};

// User avatar with glow effect for top rankers
const UserAvatar: FC<{ url: string | null; username: string; rank: number }> = ({ url, username, rank }) => {
  const glowClass = rank === 1 ? 'ring-yellow-400/50 shadow-yellow-400/30' :
                    rank === 2 ? 'ring-gray-400/50' :
                    rank === 3 ? 'ring-amber-600/50' : 'ring-gray-700';

  return (
    <div class={`relative w-10 h-10 rounded-full ring-2 ${glowClass} overflow-hidden bg-gray-800`}>
      {url ? (
        <img src={url} alt={username} class="w-full h-full object-cover" loading="lazy" />
      ) : (
        <div class="w-full h-full flex items-center justify-center text-gray-500 font-mono text-sm">
          {username.slice(0, 2).toUpperCase()}
        </div>
      )}
      {rank <= 3 && (
        <div class="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent"></div>
      )}
    </div>
  );
};

// Stat pill component
const StatPill: FC<{ label: string; value: number; icon: string; color: string }> = ({ label, value, icon, color }) => (
  <div class={`flex items-center gap-1.5 px-2 py-1 rounded ${color} text-xs font-mono`} title={label}>
    <span>{icon}</span>
    <span>{value.toLocaleString()}</span>
  </div>
);

// Period tab component
const PeriodTab: FC<{ period: Period; currentPeriod: Period; label: string; pageSize: number }> = ({ period, currentPeriod, label, pageSize }) => {
  const isActive = period === currentPeriod;
  return (
    <button
      hx-get={`/api/leaderboard?period=${period}&limit=${pageSize}`}
      hx-target="#leaderboard-content"
      hx-swap="innerHTML"
      hx-indicator="#loading-indicator"
      class={`px-4 py-2 font-mono text-sm transition-all duration-200 border-b-2 ${
        isActive
          ? 'text-cyan-400 border-cyan-400 bg-cyan-400/10'
          : 'text-gray-500 border-transparent hover:text-gray-300 hover:border-gray-600'
      }`}
    >
      {label}
    </button>
  );
};

// Single leaderboard row
const LeaderboardRow: FC<{ entry: LeaderboardEntry; index: number }> = ({ entry, index }) => {
  const isTopThree = entry.rank <= 3;
  const rowClass = isTopThree
    ? 'bg-gradient-to-r from-gray-900/80 via-gray-900/50 to-transparent border-l-2 ' +
      (entry.rank === 1 ? 'border-l-yellow-400' : entry.rank === 2 ? 'border-l-gray-400' : 'border-l-amber-600')
    : 'hover:bg-gray-900/50';

  return (
    <div
      class={`group flex items-center gap-4 p-4 rounded-lg transition-all duration-200 ${rowClass}`}
      style={`animation-delay: ${index * 50}ms`}
    >
      {/* Rank */}
      <RankBadge rank={entry.rank} />

      {/* User info */}
      <div class="flex items-center gap-3 flex-1 min-w-0">
        <UserAvatar url={entry.avatarUrl} username={entry.githubUsername} rank={entry.rank} />
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <a
              href={`https://github.com/${entry.githubUsername}`}
              target="_blank"
              rel="noopener noreferrer"
              class="text-gray-100 font-medium hover:text-cyan-400 transition-colors truncate"
            >
              @{entry.githubUsername}
            </a>
            {entry.badges && entry.badges.length > 0 && (
              <span class="text-sm" title={`${entry.badges.length} badge${entry.badges.length > 1 ? 's' : ''}`}>
                {formatBadgesCompact(entry.badges)}
              </span>
            )}
          </div>
          <div class="text-gray-600 text-xs font-mono">
            ID: {entry.userId.slice(0, 8)}...
          </div>
        </div>
      </div>

      {/* Stats */}
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <StatPill
          label="Messages"
          value={entry.messageCount}
          icon="&gt;_"
          color="bg-cyan-500/20 text-cyan-400"
        />
        <StatPill
          label="Sessions"
          value={entry.sessionCount}
          icon="[]"
          color="bg-magenta-500/20 text-magenta-400"
        />
        <StatPill
          label="Tool Calls"
          value={entry.toolCallCount}
          icon="()"
          color="bg-blue-500/20 text-blue-400"
        />
      </div>

      {/* Score visualization */}
      <div class="hidden lg:block w-32">
        <div class="h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            class="h-full bg-gradient-to-r from-cyan-500 to-magenta-500 rounded-full transition-all duration-500"
            style={`width: ${Math.min(100, (entry.messageCount / 10000) * 100)}%`}
          ></div>
        </div>
      </div>
    </div>
  );
};

// Empty state component
const EmptyState: FC = () => (
  <div class="text-center py-16">
    <div class="text-6xl mb-4">&#x1F916;</div>
    <h3 class="text-xl font-bold text-gray-400 mb-2">No data yet...</h3>
    <p class="text-gray-600 font-mono text-sm mb-6">
      Be the first to climb the leaderboard!
    </p>
    <pre class="text-cyan-400/60 text-xs inline-block text-left">
{`  _____
 /     \\
| () () |
 \\  ^  /
  |||||
  |||||`}
    </pre>
  </div>
);

// Loading indicator
const LoadingIndicator: FC = () => (
  <div id="loading-indicator" class="htmx-indicator fixed top-20 left-1/2 -translate-x-1/2 z-50">
    <div class="flex items-center gap-2 px-4 py-2 bg-gray-900 border border-cyan-500/30 rounded-full">
      <div class="w-2 h-2 bg-cyan-400 rounded-full animate-ping"></div>
      <span class="text-cyan-400 text-sm font-mono">Loading...</span>
    </div>
  </div>
);

// Main Leaderboard component
export const Leaderboard: FC<LeaderboardProps> = ({ entries, period, total, page, pageSize }) => {
  const hasEntries = entries.length > 0;
  const totalPages = Math.ceil(total / pageSize);

  return (
    <section id="leaderboard" class="py-16 px-4">
      <div class="max-w-5xl mx-auto">
        {/* Header */}
        <div class="text-center mb-8">
          <h2 class="text-3xl font-bold mb-2">
            <span class="text-gray-400">[</span>
            <span class="text-cyan-400">Leaderboard</span>
            <span class="text-gray-400">]</span>
          </h2>
          <p class="text-gray-500 font-mono text-sm">
            // Top Claude Code power users ranked by activity
          </p>
        </div>

        {/* Period tabs */}
        <div class="flex justify-center gap-1 mb-8 border-b border-gray-800">
          <PeriodTab period="today" currentPeriod={period} label="Today" pageSize={pageSize} />
          <PeriodTab period="week" currentPeriod={period} label="This Week" pageSize={pageSize} />
          <PeriodTab period="month" currentPeriod={period} label="This Month" pageSize={pageSize} />
          <PeriodTab period="all" currentPeriod={period} label="All Time" pageSize={pageSize} />
        </div>

        {/* Loading indicator */}
        <LoadingIndicator />

        {/* Leaderboard content */}
        <div id="leaderboard-content" class="space-y-2">
          {hasEntries ? (
            <>
              {/* Table header */}
              <div class="flex items-center gap-4 px-4 py-2 text-gray-500 text-xs font-mono uppercase tracking-wider">
                <div class="w-10">Rank</div>
                <div class="flex-1">User</div>
                <div class="flex items-center gap-2">
                  <span class="hidden sm:inline">Stats</span>
                </div>
                <div class="hidden lg:block w-32">Progress</div>
              </div>

              {/* Entries */}
              <div class="space-y-1">
                {entries.map((entry, index) => (
                  <LeaderboardRow key={entry.userId} entry={entry} index={index} />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div class="flex justify-center gap-2 mt-8 pt-4 border-t border-gray-800">
                  {page > 1 && (
                    <button
                      hx-get={`/api/leaderboard?period=${period}&page=${page - 1}&limit=${pageSize}`}
                      hx-target="#leaderboard-content"
                      hx-swap="innerHTML"
                      class="px-3 py-1 text-gray-400 hover:text-cyan-400 font-mono text-sm border border-gray-700 hover:border-cyan-500/50 rounded transition-colors"
                    >
                      &lt; Prev
                    </button>
                  )}
                  <span class="px-3 py-1 text-gray-500 font-mono text-sm">
                    Page {page} of {totalPages}
                  </span>
                  {page < totalPages && (
                    <button
                      hx-get={`/api/leaderboard?period=${period}&page=${page + 1}&limit=${pageSize}`}
                      hx-target="#leaderboard-content"
                      hx-swap="innerHTML"
                      class="px-3 py-1 text-gray-400 hover:text-cyan-400 font-mono text-sm border border-gray-700 hover:border-cyan-500/50 rounded transition-colors"
                    >
                      Next &gt;
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <EmptyState />
          )}
        </div>

        {/* Stats footer */}
        {hasEntries && (
          <div class="mt-8 pt-6 border-t border-gray-800 flex justify-center gap-8 text-gray-500 text-sm font-mono">
            <div>
              Total Users: <span class="text-cyan-400">{total}</span>
            </div>
            <div>
              Period: <span class="text-magenta-400">{period}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

// Partial component for HTMX updates (just the content, no wrapper)
export const LeaderboardContent: FC<LeaderboardProps> = ({ entries, period, total, page, pageSize }) => {
  const hasEntries = entries.length > 0;
  const totalPages = Math.ceil(total / pageSize);

  if (!hasEntries) {
    return <EmptyState />;
  }

  return (
    <>
      {/* Table header */}
      <div class="flex items-center gap-4 px-4 py-2 text-gray-500 text-xs font-mono uppercase tracking-wider">
        <div class="w-10">Rank</div>
        <div class="flex-1">User</div>
        <div class="flex items-center gap-2">
          <span class="hidden sm:inline">Stats</span>
        </div>
        <div class="hidden lg:block w-32">Progress</div>
      </div>

      {/* Entries */}
      <div class="space-y-1">
        {entries.map((entry, index) => (
          <LeaderboardRow key={entry.userId} entry={entry} index={index} />
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div class="flex justify-center gap-2 mt-8 pt-4 border-t border-gray-800">
          {page > 1 && (
            <button
              hx-get={`/api/leaderboard?period=${period}&page=${page - 1}&limit=${pageSize}`}
              hx-target="#leaderboard-content"
              hx-swap="innerHTML"
              class="px-3 py-1 text-gray-400 hover:text-cyan-400 font-mono text-sm border border-gray-700 hover:border-cyan-500/50 rounded transition-colors"
            >
              &lt; Prev
            </button>
          )}
          <span class="px-3 py-1 text-gray-500 font-mono text-sm">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <button
              hx-get={`/api/leaderboard?period=${period}&page=${page + 1}&limit=${pageSize}`}
              hx-target="#leaderboard-content"
              hx-swap="innerHTML"
              class="px-3 py-1 text-gray-400 hover:text-cyan-400 font-mono text-sm border border-gray-700 hover:border-cyan-500/50 rounded transition-colors"
            >
              Next &gt;
            </button>
          )}
        </div>
      )}
    </>
  );
};

export default Leaderboard;
