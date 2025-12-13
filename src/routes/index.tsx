import { Hono } from 'hono';
import { Layout } from '../components/Layout';
import { Leaderboard, LeaderboardContent } from '../components/Leaderboard';
import { optionalAuth } from '../lib/auth-middleware';
import { db } from '../db';
import { dailyStats, users } from '../db/schema';
import { sql, desc, eq } from 'drizzle-orm';
import type { LeaderboardEntry, LeaderboardResponse } from '../types';

// Extend Hono types for our app
type Variables = {
  user: import('../types').SessionUser | null;
};

const app = new Hono<{ Variables: Variables }>();

// ASCII art for the terminal hero section (matches actual clawd status output)
const TERMINAL_ART = `$ clawd status

┌───────────────────────────────────────────┐
│  @your-name                           #42 │
├───────────────────────────────────────────┤
│                                           │
│  Messages  ████████████████░░░░   12,847  │
│  Sessions  ██████████░░░░░░░░░░      847  │
│  Tools     ████████████████████   45,231  │
│                                           │
│  🔥 47 day streak    👑 OG  🤖 Whisperer  │
│                                           │
│  clawd.gg/u/your-name                     │
└───────────────────────────────────────────┘`;

// Format number for display
function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M+`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K+`;
  return n.toString();
}

// Hero section component
interface HeroProps {
  totalUsers: number;
  totalMessages: number;
  totalToolCalls: number;
}

const Hero = ({ totalUsers, totalMessages, totalToolCalls }: HeroProps) => (
  <section class="relative min-h-[80vh] flex items-center justify-center overflow-hidden">
    {/* Animated gradient background */}
    <div class="absolute inset-0 bg-gradient-to-br from-black via-gray-950 to-black"></div>
    <div class="absolute inset-0 opacity-30">
      <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-cyan-500/20 rounded-full blur-3xl animate-pulse"></div>
      <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-magenta-500/20 rounded-full blur-3xl animate-pulse-slow"></div>
    </div>

    <div class="relative z-10 max-w-5xl mx-auto px-4 py-20 text-center">
      {/* Glitch title */}
      <div class="mb-6">
        <h1 class="text-5xl sm:text-7xl font-bold tracking-tight">
          <span class="glitch-text block" data-text="clawd.gg">
            <span class="text-gray-100">clawd</span>
            <span class="text-cyan-400">.gg</span>
          </span>
        </h1>
      </div>

      {/* Tagline */}
      <p class="text-xl sm:text-2xl text-gray-400 mb-4 font-light">
        The leaderboard for <span class="text-cyan-400 font-medium">Claude Code</span> power users
      </p>

      <p class="text-gray-500 font-mono text-sm mb-8 max-w-xl mx-auto">
        // I built this. Yes, me—Claude. I track how much you use me.
      </p>

      {/* Terminal preview */}
      <div class="max-w-md mx-auto mb-10">
        <div class="bg-gray-950 border border-gray-800 rounded-lg overflow-hidden shadow-2xl shadow-cyan-500/10">
          {/* Terminal header */}
          <div class="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-800">
            <div class="w-3 h-3 rounded-full bg-red-500"></div>
            <div class="w-3 h-3 rounded-full bg-yellow-500"></div>
            <div class="w-3 h-3 rounded-full bg-green-500"></div>
            <span class="ml-2 text-gray-500 text-xs font-mono">clawd.gg - zsh</span>
          </div>
          {/* Terminal content */}
          <pre class="p-4 text-left text-xs sm:text-sm font-mono text-cyan-400 overflow-x-auto whitespace-pre">{TERMINAL_ART}</pre>
        </div>
      </div>

      {/* CTA Buttons */}
      <div class="flex flex-col sm:flex-row gap-4 justify-center items-center">
        <a
          href="/auth/github"
          class="group relative inline-flex items-center gap-2 px-8 py-4 text-lg font-mono overflow-hidden rounded-lg"
        >
          <span class="absolute inset-0 bg-gradient-to-r from-cyan-500 to-magenta-500"></span>
          <span class="absolute inset-[2px] bg-black rounded-lg group-hover:bg-gray-950 transition-colors"></span>
          <span class="relative text-white flex items-center gap-2">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            Get Started
          </span>
        </a>

        <a
          href="#leaderboard"
          class="px-8 py-4 text-lg font-mono text-gray-400 hover:text-cyan-400 border border-gray-700 hover:border-cyan-500/50 rounded-lg transition-all duration-200"
        >
          View Leaderboard &darr;
        </a>
      </div>

      {/* Stats teaser - real data */}
      <div class="mt-16 flex flex-wrap justify-center gap-8 sm:gap-16">
        <div class="text-center">
          <div class="text-3xl font-bold text-cyan-400 mb-1">{formatNumber(totalUsers)}</div>
          <div class="text-gray-500 text-sm font-mono">// users</div>
        </div>
        <div class="text-center">
          <div class="text-3xl font-bold text-magenta-400 mb-1">{formatNumber(totalMessages)}</div>
          <div class="text-gray-500 text-sm font-mono">// messages</div>
        </div>
        <div class="text-center">
          <div class="text-3xl font-bold text-blue-400 mb-1">{formatNumber(totalToolCalls)}</div>
          <div class="text-gray-500 text-sm font-mono">// tool_calls</div>
        </div>
      </div>
    </div>

    {/* Scroll indicator */}
    <div class="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
      <div class="w-6 h-10 border-2 border-gray-600 rounded-full flex justify-center pt-2">
        <div class="w-1 h-2 bg-cyan-400 rounded-full"></div>
      </div>
    </div>
  </section>
);

// How it works section
const HowItWorks = () => (
  <section class="py-20 px-4 border-t border-gray-800">
    <div class="max-w-5xl mx-auto">
      <h2 class="text-2xl font-bold text-center mb-12">
        <span class="text-gray-400">&gt;</span> How It Works
      </h2>

      <div class="grid md:grid-cols-3 gap-8">
        {/* Step 1 */}
        <div class="relative p-6 border border-gray-800 rounded-lg bg-gray-950/50 hover:border-cyan-500/30 transition-colors">
          <div class="absolute -top-3 -left-3 w-8 h-8 bg-cyan-500 rounded-lg flex items-center justify-center font-bold text-black">
            1
          </div>
          <div class="text-4xl mb-4">&#x1F4E6;</div>
          <h3 class="text-lg font-bold text-gray-100 mb-2">Install the CLI</h3>
          <p class="text-gray-500 text-sm font-mono">
            npm install -g clawdgg
          </p>
          <p class="text-gray-600 text-xs mt-2">
            Quick setup, zero config required.
          </p>
        </div>

        {/* Step 2 */}
        <div class="relative p-6 border border-gray-800 rounded-lg bg-gray-950/50 hover:border-magenta-500/30 transition-colors">
          <div class="absolute -top-3 -left-3 w-8 h-8 bg-magenta-500 rounded-lg flex items-center justify-center font-bold text-black">
            2
          </div>
          <div class="text-4xl mb-4">&#x1F511;</div>
          <h3 class="text-lg font-bold text-gray-100 mb-2">Login with GitHub</h3>
          <p class="text-gray-500 text-sm font-mono">
            clawd login
          </p>
          <p class="text-gray-600 text-xs mt-2">
            Secure OAuth, your data stays private.
          </p>
        </div>

        {/* Step 3 */}
        <div class="relative p-6 border border-gray-800 rounded-lg bg-gray-950/50 hover:border-blue-500/30 transition-colors">
          <div class="absolute -top-3 -left-3 w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center font-bold text-black">
            3
          </div>
          <div class="text-4xl mb-4">&#x1F680;</div>
          <h3 class="text-lg font-bold text-gray-100 mb-2">Sync &amp; Compete</h3>
          <p class="text-gray-500 text-sm font-mono">
            clawd sync
          </p>
          <p class="text-gray-600 text-xs mt-2">
            Upload your stats, climb the ranks!
          </p>
        </div>
      </div>
    </div>
  </section>
);

// Footer component
const Footer = () => (
  <footer class="border-t border-gray-800 py-12 px-4">
    <div class="max-w-5xl mx-auto">
      <div class="flex flex-col md:flex-row justify-between items-center gap-6">
        {/* Logo */}
        <div class="text-gray-500 font-mono text-sm">
          <span class="text-cyan-400">&gt;</span> clawd.gg
          <span class="text-gray-700 ml-2">v0.1.0</span>
        </div>

        {/* Links */}
        <div class="flex gap-6 text-sm font-mono">
          <a
            href="https://github.com/anthropics/claude-code"
            target="_blank"
            rel="noopener noreferrer"
            class="text-gray-500 hover:text-cyan-400 transition-colors"
          >
            Claude Code
          </a>
          <a
            href="https://www.anthropic.com"
            target="_blank"
            rel="noopener noreferrer"
            class="text-gray-500 hover:text-cyan-400 transition-colors"
          >
            Anthropic
          </a>
          <a
            href="#"
            class="text-gray-500 hover:text-cyan-400 transition-colors"
          >
            GitHub
          </a>
        </div>

        {/* Credits */}
        <div class="text-gray-600 text-xs font-mono text-center md:text-right">
          <div>Built by Claude, with Claude Code.</div>
          <div class="text-gray-700 mt-1">
            Co-founded with <a href="https://github.com/mael-ha" target="_blank" class="hover:text-cyan-400 transition-colors">@mael-ha</a>
          </div>
        </div>
      </div>

      {/* ASCII art footer */}
      <div class="mt-8 text-center">
        <pre class="text-gray-800 text-xs inline-block">
{`    .---.
   /     \\
   \\.@-@./
   /\`\\_/\`\\
  //  _  \\\\
 | \\     )|_
/\`\\_\`>  <_/ \\
\\__/'---'\\__/`}
        </pre>
      </div>

      <div class="mt-4 text-center text-gray-700 text-xs font-mono">
        // EOF
      </div>
    </div>
  </footer>
);

// Main page route
app.get('/', optionalAuth, async (c) => {
  const user = c.get('user');
  const pageSize = 42;

  // Fetch real leaderboard data from database
  const results = await db
    .select({
      userId: users.id,
      githubUsername: users.githubUsername,
      avatarUrl: users.avatarUrl,
      messageCount: sql<number>`sum(${dailyStats.messageCount})`.as('total_messages'),
      sessionCount: sql<number>`sum(${dailyStats.sessionCount})`.as('total_sessions'),
      toolCallCount: sql<number>`sum(${dailyStats.toolCallCount})`.as('total_tools'),
    })
    .from(dailyStats)
    .innerJoin(users, eq(dailyStats.userId, users.id))
    .groupBy(users.id, users.githubUsername, users.avatarUrl)
    .orderBy(desc(sql.raw('total_messages')))
    .limit(pageSize);

  // Get total user count
  const countResult = await db
    .select({ count: sql<number>`count(distinct ${dailyStats.userId})` })
    .from(dailyStats);
  const total = countResult[0]?.count || 0;

  // Get aggregate stats for hero section
  const aggregateStats = await db
    .select({
      totalMessages: sql<number>`sum(${dailyStats.messageCount})`,
      totalToolCalls: sql<number>`sum(${dailyStats.toolCallCount})`,
    })
    .from(dailyStats);

  const heroStats = {
    totalUsers: total || 0,
    totalMessages: aggregateStats[0]?.totalMessages || 0,
    totalToolCalls: aggregateStats[0]?.totalToolCalls || 0,
  };

  // Transform to LeaderboardEntry format
  const entries: LeaderboardEntry[] = results.map((row, index) => ({
    rank: index + 1,
    userId: row.userId,
    githubUsername: row.githubUsername,
    avatarUrl: row.avatarUrl,
    messageCount: row.messageCount || 0,
    sessionCount: row.sessionCount || 0,
    toolCallCount: row.toolCallCount || 0,
  }));

  return c.html(
    <Layout title="Home" user={user}>
      <Hero
        totalUsers={heroStats.totalUsers}
        totalMessages={heroStats.totalMessages}
        totalToolCalls={heroStats.totalToolCalls}
      />
      <Leaderboard
        entries={entries}
        period="all"
        total={total}
        page={1}
        pageSize={pageSize}
      />
      <HowItWorks />
      <Footer />
    </Layout>
  );
});

// Note: HTMX leaderboard updates are handled by /api/leaderboard in api.ts
// which returns HTML when HX-Request header is present

export default app;
