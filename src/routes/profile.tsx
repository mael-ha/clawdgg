import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { Layout } from '../components/Layout';
import { db } from '../db';
import { dailyStats, users } from '../db/schema';
import { eq, sql, asc, desc } from 'drizzle-orm';
import { getBadges, BADGES } from '../lib/badges';
import { getTokenComparison, getPromptsComparison, getLinesComparison } from '../lib/comparisons';
import type { SessionUser } from '../types';

type Variables = {
  user: SessionUser | null;
};

const app = new Hono<{ Variables: Variables }>();

// Contribution graph component (GitHub-style, 365 days)
interface ContributionDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

const ContributionGraph: FC<{ days: ContributionDay[] }> = ({ days }) => {
  // Build a map for quick lookup
  const dayMap = new Map(days.map(d => [d.date, d]));

  // Generate all dates for the last 365 days
  const allDays: ContributionDay[] = [];
  const today = new Date();
  for (let i = 364; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const existing = dayMap.get(dateStr);
    allDays.push(existing || { date: dateStr, count: 0, level: 0 });
  }

  // Group by weeks (columns)
  const weeks: ContributionDay[][] = [];
  let currentWeek: ContributionDay[] = [];

  // Pad first week to start on Sunday
  const firstDayOfWeek = new Date(allDays[0].date).getDay();
  for (let i = 0; i < firstDayOfWeek; i++) {
    currentWeek.push({ date: '', count: 0, level: 0 });
  }

  for (const day of allDays) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    weeks.push(currentWeek);
  }

  const levelColors = [
    'bg-gray-800',           // 0 - no activity
    'bg-cyan-900',           // 1 - low
    'bg-cyan-700',           // 2 - medium
    'bg-cyan-500',           // 3 - high
    'bg-cyan-300',           // 4 - very high
  ];

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return (
    <div class="overflow-x-auto">
      <div class="inline-block min-w-max">
        {/* Month labels */}
        <div class="flex mb-1 ml-8">
          {weeks.map((week, i) => {
            if (i === 0 || i % 4 === 0) {
              const firstValidDay = week.find(d => d.date);
              if (firstValidDay) {
                const month = new Date(firstValidDay.date).getMonth();
                return <span class="text-xs text-gray-500 w-12">{months[month]}</span>;
              }
            }
            return null;
          })}
        </div>

        <div class="flex gap-[2px]">
          {/* Day labels */}
          <div class="flex flex-col gap-[2px] mr-2 text-xs text-gray-500">
            <span class="h-[10px]"></span>
            <span class="h-[10px]">Mon</span>
            <span class="h-[10px]"></span>
            <span class="h-[10px]">Wed</span>
            <span class="h-[10px]"></span>
            <span class="h-[10px]">Fri</span>
            <span class="h-[10px]"></span>
          </div>

          {/* Grid */}
          {weeks.map((week, weekIdx) => (
            <div key={weekIdx} class="flex flex-col gap-[2px]">
              {week.map((day, dayIdx) => (
                <div
                  key={dayIdx}
                  class={`w-[10px] h-[10px] rounded-sm ${day.date ? levelColors[day.level] : 'bg-transparent'} ${day.date ? 'hover:ring-1 hover:ring-gray-600' : ''}`}
                  title={day.date ? `${day.date}: ${day.count} messages` : ''}
                ></div>
              ))}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div class="flex items-center gap-1 mt-2 justify-end text-xs text-gray-500">
          <span>Less</span>
          {levelColors.map((color, i) => (
            <div key={i} class={`w-[10px] h-[10px] rounded-sm ${color}`}></div>
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
};

// Badge showcase component
interface BadgeShowcaseProps {
  badgeIds: string[];
}

const BadgeShowcase: FC<BadgeShowcaseProps> = ({ badgeIds }) => {
  const badges = getBadges(badgeIds);

  if (badges.length === 0) {
    return (
      <div class="text-center py-8 text-gray-500">
        <div class="text-4xl mb-2">🏆</div>
        <p class="font-mono text-sm">No badges yet. Keep coding!</p>
      </div>
    );
  }

  return (
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {badges.map((badge) => (
        <div
          key={badge.id}
          class="flex items-center gap-4 p-4 bg-gray-900/50 border border-gray-800 rounded-lg hover:border-cyan-500/30 transition-colors"
        >
          <div class="text-3xl">{badge.emoji}</div>
          <div>
            <div class="font-bold text-gray-100">{badge.name}</div>
            <div class="text-sm text-gray-500">{badge.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

// Stat card component
const StatCard: FC<{ label: string; value: string | number; icon: string; color: string }> = ({ label, value, icon, color }) => (
  <div class="p-4 bg-gray-900/50 border border-gray-800 rounded-lg">
    <div class="flex items-center gap-2 mb-2">
      <span class={`text-lg ${color}`}>{icon}</span>
      <span class="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
    </div>
    <div class={`text-2xl font-bold ${color}`}>
      {typeof value === 'number' ? value.toLocaleString() : value}
    </div>
  </div>
);

// Format tokens with K/M/B suffix
function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toString();
}

// Profile page component
interface ProfileProps {
  profile: {
    username: string;
    avatarUrl: string | null;
    firstSessionDate: string | null;
    badges: string[];
    currentStreak: number;
    longestStreak: number;
    // New primary metrics
    totalPrompts: number;
    totalLinesWritten: number;
    totalCommits: number;
    totalTokens: number;
    // Legacy (kept for backward compat)
    totalMessages: number;
    totalSessions: number;
    totalToolCalls: number;
    rank: number;
    totalUsers: number;
  };
  contributions: ContributionDay[];
  currentUser: SessionUser | null;
}

const Profile: FC<ProfileProps> = ({ profile, contributions, currentUser }) => {
  const isOwnProfile = currentUser?.githubUsername === profile.username;
  const memberSince = profile.firstSessionDate
    ? new Date(profile.firstSessionDate).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : 'Unknown';

  // Calculate percentile (rank 1 / 100 = top 1%)
  const percentile = profile.totalUsers > 0
    ? Math.max(1, Math.ceil((profile.rank / profile.totalUsers) * 100))
    : 100;

  // Get fun comparison
  const funComparison = getTokenComparison(profile.totalTokens);

  // Generate share text with new metrics
  const shareText = `I'm #${profile.rank} on clawd.gg — Top ${percentile}% of Claude Code users 🤖

📨 ${profile.totalPrompts.toLocaleString()} prompts sent
📝 ${formatTokens(profile.totalLinesWritten)} lines written
⚡ ${formatTokens(profile.totalTokens)} tokens
🔥 ${profile.currentStreak} day streak

${funComparison}

clawd.gg/u/${profile.username}`;

  return (
    <div class="min-h-screen bg-black">
      {/* Header */}
      <header class="border-b border-gray-800 py-6 px-4">
        <div class="max-w-5xl mx-auto flex justify-between items-center">
          <a href="/" class="text-gray-500 hover:text-cyan-400 font-mono text-sm transition-colors">
            &larr; Back to Leaderboard
          </a>
          {isOwnProfile && (
            <button
              onclick={`navigator.clipboard.writeText(\`${shareText.replace(/`/g, '\\`')}\`).then(() => { this.textContent = '✓ Copied!'; setTimeout(() => this.textContent = '📋 Share Stats', 2000); })`}
              class="flex items-center gap-2 px-4 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg text-cyan-400 font-mono text-sm transition-colors"
            >
              📋 Share Stats
            </button>
          )}
        </div>
      </header>

      <main class="max-w-5xl mx-auto px-4 py-12">
        {/* HERO: The Big Flex */}
        <div class="text-center py-12 mb-12 relative">
          {/* Glowing background effect */}
          <div class="absolute inset-0 flex items-center justify-center opacity-20">
            <div class="w-64 h-64 bg-cyan-500 rounded-full blur-3xl"></div>
          </div>

          {/* Crown for #1 */}
          {profile.rank === 1 && (
            <div class="text-6xl mb-4 animate-bounce">👑</div>
          )}

          {/* Giant percentile */}
          <div class="relative">
            <div class="text-7xl sm:text-8xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-cyan-200 mb-4"
                 style="text-shadow: 0 0 40px rgba(34, 211, 238, 0.4), 0 0 80px rgba(34, 211, 238, 0.2);">
              TOP {percentile}%
            </div>
          </div>

          {/* Rank context */}
          <div class="text-xl sm:text-2xl text-gray-400 mb-8">
            #{profile.rank.toLocaleString()} of {profile.totalUsers.toLocaleString()} Claude Code users
          </div>

          {/* User identity */}
          <div class="flex items-center justify-center gap-4">
            {profile.avatarUrl ? (
              <img
                src={profile.avatarUrl}
                alt={profile.username}
                class="w-16 h-16 rounded-full ring-2 ring-gray-700"
              />
            ) : (
              <div class="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center text-xl font-bold text-gray-500">
                {profile.username.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div class="text-left">
              <div class="flex items-center gap-2">
                <h1 class="text-2xl font-bold text-gray-100">@{profile.username}</h1>
                {profile.badges.length > 0 && (
                  <span class="text-lg">
                    {getBadges(profile.badges).slice(0, 3).map(b => b.emoji).join('')}
                  </span>
                )}
              </div>
              <div class="text-gray-500 font-mono text-sm flex items-center gap-3">
                <span>Since {memberSince}</span>
                {profile.currentStreak > 0 && (
                  <span class="text-orange-400">🔥 {profile.currentStreak}d streak</span>
                )}
              </div>
            </div>
          </div>

          {/* GitHub link */}
          <div class="mt-6">
            <a
              href={`https://github.com/${profile.username}`}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 px-4 py-2 border border-gray-700 hover:border-gray-600 rounded-lg text-gray-400 hover:text-gray-300 transition-colors text-sm"
            >
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              View on GitHub
            </a>
          </div>
        </div>

        {/* Stats cards - New metrics */}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Prompts Sent"
            value={profile.totalPrompts}
            icon="📨"
            color="text-cyan-400"
          />
          <StatCard
            label="Lines Written"
            value={profile.totalLinesWritten}
            icon="📝"
            color="text-green-400"
          />
          <StatCard
            label="Tokens"
            value={formatTokens(profile.totalTokens)}
            icon="⚡"
            color="text-yellow-400"
          />
          <StatCard
            label="Commits"
            value={profile.totalCommits}
            icon="📦"
            color="text-purple-400"
          />
        </div>

        {/* Fun comparison */}
        <div class="mb-12 p-4 bg-gray-900/50 border border-gray-800 rounded-lg text-center">
          <p class="text-gray-400 font-mono text-sm">
            <span class="text-cyan-400">// fun fact:</span> You've exchanged {funComparison}
          </p>
        </div>

        {/* Additional stats row */}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
          <StatCard
            label="Current Streak"
            value={`${profile.currentStreak} days`}
            icon="🔥"
            color="text-orange-400"
          />
          <StatCard
            label="Best Streak"
            value={`${profile.longestStreak} days`}
            icon="🏆"
            color="text-amber-400"
          />
          <StatCard
            label="Messages"
            value={profile.totalMessages}
            icon=">_"
            color="text-gray-400"
          />
          <StatCard
            label="Tool Calls"
            value={profile.totalToolCalls}
            icon="()"
            color="text-gray-400"
          />
        </div>

        {/* Contribution graph */}
        <section class="mb-12">
          <h2 class="text-xl font-bold text-gray-100 mb-4 flex items-center gap-2">
            <span class="text-gray-500">//</span> Activity
          </h2>
          <div class="p-6 bg-gray-950 border border-gray-800 rounded-lg">
            <ContributionGraph days={contributions} />
          </div>
        </section>

        {/* Badges */}
        <section>
          <h2 class="text-xl font-bold text-gray-100 mb-4 flex items-center gap-2">
            <span class="text-gray-500">//</span> Badges Earned
            <span class="text-gray-500 text-sm font-normal">({profile.badges.length}/{Object.keys(BADGES).length})</span>
          </h2>
          <div class="p-6 bg-gray-950 border border-gray-800 rounded-lg">
            <BadgeShowcase badgeIds={profile.badges} />
          </div>
        </section>
      </main>
    </div>
  );
};

// 404 component
const NotFound: FC<{ username: string }> = ({ username }) => (
  <div class="min-h-screen bg-black flex items-center justify-center px-4">
    <div class="text-center">
      <div class="text-6xl mb-4">🤔</div>
      <h1 class="text-2xl font-bold text-gray-100 mb-2">User not found</h1>
      <p class="text-gray-500 font-mono text-sm mb-6">
        @{username} hasn't joined clawd.gg yet
      </p>
      <a
        href="/"
        class="inline-flex items-center gap-2 px-4 py-2 text-cyan-400 hover:text-cyan-300 font-mono transition-colors"
      >
        &larr; Back to Leaderboard
      </a>
    </div>
  </div>
);

// Profile route
app.get('/:username', async (c) => {
  const username = c.req.param('username');
  const currentUser = c.get('user');

  // Fetch user
  const user = await db
    .select()
    .from(users)
    .where(eq(users.githubUsername, username))
    .limit(1);

  if (user.length === 0) {
    return c.html(
      <Layout title={`@${username} - Not Found`} user={currentUser}>
        <NotFound username={username} />
      </Layout>,
      404
    );
  }

  const userData = user[0];

  // Fetch aggregate stats
  const statsResult = await db
    .select({
      totalPrompts: sql<number>`sum(${dailyStats.promptCount})`,
      totalLinesWritten: sql<number>`sum(${dailyStats.linesWritten})`,
      totalCommits: sql<number>`sum(${dailyStats.commitCount})`,
      totalMessages: sql<number>`sum(${dailyStats.messageCount})`,
      totalSessions: sql<number>`sum(${dailyStats.sessionCount})`,
      totalToolCalls: sql<number>`sum(${dailyStats.toolCallCount})`,
      totalTokens: sql<number>`sum(${dailyStats.tokenCount})`,
    })
    .from(dailyStats)
    .where(eq(dailyStats.userId, userData.id));

  // Fetch daily activity for contribution graph (uses prompts for activity level)
  const dailyActivity = await db
    .select({
      date: dailyStats.date,
      count: dailyStats.promptCount,
    })
    .from(dailyStats)
    .where(eq(dailyStats.userId, userData.id))
    .orderBy(asc(dailyStats.date));

  // Calculate contribution levels (0-4 based on message count)
  const maxCount = Math.max(...dailyActivity.map(d => d.count), 1);
  const contributions: ContributionDay[] = dailyActivity.map(d => {
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (d.count > 0) {
      const ratio = d.count / maxCount;
      if (ratio >= 0.75) level = 4;
      else if (ratio >= 0.5) level = 3;
      else if (ratio >= 0.25) level = 2;
      else level = 1;
    }
    return { date: d.date, count: d.count, level };
  });

  // Get user rank (by prompts now, not messages)
  const rankResult = await db
    .select({
      rank: sql<number>`(
        SELECT COUNT(*) + 1 FROM (
          SELECT user_id, SUM(prompt_count) as total
          FROM daily_stats
          GROUP BY user_id
          HAVING total > (
            SELECT COALESCE(SUM(prompt_count), 0)
            FROM daily_stats
            WHERE user_id = ${userData.id}
          )
        )
      )`,
    })
    .from(users)
    .where(eq(users.id, userData.id));

  // Get total users count
  const totalUsersResult = await db
    .select({ count: sql<number>`count(distinct user_id)` })
    .from(dailyStats);

  // Parse badges
  let badges: string[] = [];
  try {
    badges = userData.badges ? JSON.parse(userData.badges) : [];
  } catch {
    badges = [];
  }

  const profile = {
    username: userData.githubUsername,
    avatarUrl: userData.avatarUrl,
    firstSessionDate: userData.firstSessionDate,
    badges,
    currentStreak: userData.currentStreak || 0,
    longestStreak: userData.longestStreak || 0,
    // New primary metrics
    totalPrompts: statsResult[0]?.totalPrompts || 0,
    totalLinesWritten: statsResult[0]?.totalLinesWritten || 0,
    totalCommits: statsResult[0]?.totalCommits || 0,
    totalTokens: statsResult[0]?.totalTokens || 0,
    // Legacy metrics
    totalMessages: statsResult[0]?.totalMessages || 0,
    totalSessions: statsResult[0]?.totalSessions || 0,
    totalToolCalls: statsResult[0]?.totalToolCalls || 0,
    rank: rankResult[0]?.rank || 1,
    totalUsers: totalUsersResult[0]?.count || 1,
  };

  return c.html(
    <Layout title={`@${username} - clawd.gg`} user={currentUser}>
      <Profile profile={profile} contributions={contributions} currentUser={currentUser} />
    </Layout>
  );
});

export default app;
