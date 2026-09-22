import { Hono } from 'hono';
import { db } from '../db';
import { dailyStats, users, planUsageSnapshots } from '../db/schema';
import { eq, sql, desc, and, gte, asc } from 'drizzle-orm';
import { requireAuth, optionalAuth } from '../lib/auth-middleware';
import type { StatsSubmission, LeaderboardEntry, LeaderboardResponse } from '../types';
import { computeBadges, formatBadgesCompact, type BadgeInput } from '../lib/badges';
import { normalizeEpochSeconds, parseRateLimits, shouldInsertSnapshot } from '../lib/plan-usage';

const api = new Hono();

// Helper to calculate streak from sorted dates
// Uses day-numbers (integer days since epoch) for reliable calculation
// avoiding timezone/DST edge cases with millisecond division
function calculateStreaks(dates: string[]): { currentStreak: number; longestStreak: number } {
  if (dates.length === 0) return { currentStreak: 0, longestStreak: 0 };

  // Deduplicate and sort dates chronologically
  const sorted = [...new Set(dates)].sort();

  // Convert to day numbers (days since epoch) - more reliable than date string comparison
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const dayNumbers = sorted.map((dateStr) => Math.floor(new Date(dateStr).getTime() / MS_PER_DAY));

  // Calculate longest streak
  let longestStreak = 1;
  let currentRun = 1;

  for (let i = 1; i < dayNumbers.length; i++) {
    if (dayNumbers[i] === dayNumbers[i - 1]! + 1) {
      currentRun++;
      longestStreak = Math.max(longestStreak, currentRun);
    } else {
      currentRun = 1;
    }
  }

  // Calculate current streak (must include today or yesterday)
  const today = Math.floor(Date.now() / MS_PER_DAY);
  const lastActiveDay = dayNumbers[dayNumbers.length - 1]!;

  let currentStreak = 0;
  if (lastActiveDay === today || lastActiveDay === today - 1) {
    currentStreak = 1;
    for (let i = dayNumbers.length - 2; i >= 0; i--) {
      if (dayNumbers[i] === dayNumbers[i + 1]! - 1) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  return { currentStreak, longestStreak };
}

// POST /api/stats - Submit daily stats (requires auth)
// NOTE: This endpoint is for CLI sync (legacy). OTEL users should NOT use this.
api.post('/stats', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CRITICAL: Block CLI sync for OTEL users to prevent data corruption
    // OTEL users have real-time streaming; CLI sync would overwrite merged data
    // ═══════════════════════════════════════════════════════════════════════
    const userData = await db
      .select({ otelEnabled: users.otelEnabled })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    if (userData?.otelEnabled) {
      return c.json({
        error: 'CLI sync disabled for OTEL users',
        message: 'Your stats are streaming automatically via OTEL. No manual sync needed.',
        otelEnabled: true,
      }, 400);
    }

    const body = await c.req.json<StatsSubmission>();

    // Validate the submission
    if (!body.dailyActivity || !Array.isArray(body.dailyActivity)) {
      return c.json({ error: 'Invalid request: dailyActivity is required' }, 400);
    }

    // Update user's firstSessionDate if provided
    if (body.firstSessionDate) {
      await db
        .update(users)
        .set({
          firstSessionDate: body.firstSessionDate,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
    }

    // Build a map of token counts by date from dailyModelTokens
    const tokensByDate = new Map<string, number>();
    if (body.dailyModelTokens) {
      for (const tokenDay of body.dailyModelTokens) {
        const totalTokens = Object.values(tokenDay.tokensByModel).reduce((a, b) => a + b, 0);
        tokensByDate.set(tokenDay.date, totalTokens);
      }
    }

    // UPSERT daily stats for each day in dailyActivity
    let lastDate: string | null = null;
    let daysSubmitted = 0;

    for (const day of body.dailyActivity) {
      // Validate date format (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
        continue; // Skip invalid dates
      }

      // V3: Use detailed token breakdown if available, fall back to legacy tokensByModel
      const inputTokens = day.inputTokens || 0;
      const outputTokens = day.outputTokens || 0;
      const cacheReadTokens = day.cacheReadTokens || 0;
      const cacheCreationTokens = day.cacheCreationTokens || 0;
      const costUsdCents = day.costUsdCents || 0;

      // Legacy: Calculate tokenCount from detailed breakdown or fallback to tokensByDate
      const tokenCount = (inputTokens + outputTokens) || tokensByDate.get(day.date) || 0;

      await db
        .insert(dailyStats)
        .values({
          userId: user.id,
          date: day.date,
          promptCount: day.promptCount || 0,
          messageCount: day.messageCount || 0,
          toolCallCount: day.toolCallCount || 0,
          tokenCount,
          // V3: Full token breakdown
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          costUsdCents,
          // Code metrics
          linesWritten: day.linesWritten || 0,
          commitCount: day.commitCount || 0,
          sessionCount: day.sessionCount || 0,
        })
        .onConflictDoUpdate({
          target: [dailyStats.userId, dailyStats.date],
          set: {
            promptCount: sql`excluded.prompt_count`,
            messageCount: sql`excluded.message_count`,
            toolCallCount: sql`excluded.tool_call_count`,
            tokenCount: sql`excluded.token_count`,
            // V3: Full token breakdown
            inputTokens: sql`excluded.input_tokens`,
            outputTokens: sql`excluded.output_tokens`,
            cacheReadTokens: sql`excluded.cache_read_tokens`,
            cacheCreationTokens: sql`excluded.cache_creation_tokens`,
            costUsdCents: sql`excluded.cost_usd_cents`,
            // Code metrics
            linesWritten: sql`excluded.lines_written`,
            commitCount: sql`excluded.commit_count`,
            sessionCount: sql`excluded.session_count`,
            submittedAt: sql`(unixepoch())`,
          },
        });

      daysSubmitted++;
      // Track the latest date submitted
      if (!lastDate || day.date > lastDate) {
        lastDate = day.date;
      }
    }

    // Compute badges based on all user stats
    const userStats = await db
      .select({
        totalMessages: sql<number>`sum(${dailyStats.messageCount})`,
        totalToolCalls: sql<number>`sum(${dailyStats.toolCallCount})`,
      })
      .from(dailyStats)
      .where(eq(dailyStats.userId, user.id));

    // Calculate streaks
    // Priority: Use official stats-cache.json values if provided (matches Claude Code's /stats)
    // Fallback: Calculate from our dailyStats table (may differ due to agent sessions)
    let currentStreak: number;
    let longestStreak: number;

    if (body.officialCurrentStreak !== undefined && body.officialLongestStreak !== undefined) {
      // Use CLI-calculated values from stats-cache.json (matches Claude Code exactly)
      currentStreak = body.officialCurrentStreak;
      longestStreak = body.officialLongestStreak;
    } else {
      // Fallback: Calculate from our database (legacy behavior)
      const allDates = await db
        .select({ date: dailyStats.date })
        .from(dailyStats)
        .where(eq(dailyStats.userId, user.id))
        .orderBy(asc(dailyStats.date));

      const calculated = calculateStreaks(allDates.map((d) => d.date));
      currentStreak = calculated.currentStreak;
      longestStreak = calculated.longestStreak;
    }

    // Get user count for OG badge
    const userCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    const totalUsers = userCountResult[0]?.count || 0;

    // Get this user's rank (by signup order)
    const userRankResult = await db
      .select({ rank: sql<number>`(SELECT COUNT(*) FROM users u2 WHERE u2.created_at <= users.created_at)` })
      .from(users)
      .where(eq(users.id, user.id));
    const userRank = userRankResult[0]?.rank || totalUsers;

    // Compute badges
    const badgeInput: BadgeInput = {
      totalMessages: userStats[0]?.totalMessages || 0,
      totalToolCalls: userStats[0]?.totalToolCalls || 0,
      currentStreak,
      longestStreak,
      longestSessionMessages: body.longestSessionMessages || 0,
      hourCounts: body.hourCounts || {},
      userRank,
    };

    const badges = computeBadges(badgeInput);

    // Update user with badge data
    await db
      .update(users)
      .set({
        badges: JSON.stringify(badges),
        hourCounts: body.hourCounts ? JSON.stringify(body.hourCounts) : null,
        longestSessionMessages: body.longestSessionMessages || 0,
        currentStreak,
        longestStreak,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return c.json({
      success: true,
      message: `Submitted stats for ${daysSubmitted} days`,
      lastDate,
      daysSubmitted,
      badges,
    });
  } catch (error) {
    console.error('Error submitting stats:', error);
    return c.json({ error: 'Failed to submit stats' }, 500);
  }
});

// GET /api/leaderboard - Get leaderboard data
// V2: Supports both OTel users (users.total_*) and legacy users (daily_stats)
api.get('/leaderboard', optionalAuth, async (c) => {
  try {
    // Parse query parameters
    const period = (c.req.query('period') || 'all') as 'today' | 'week' | 'month' | 'all';
    const sort = (c.req.query('sort') || 'prompts') as 'prompts' | 'tokens' | 'lines' | 'messages' | 'sessions' | 'tools';
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '42', 10)));
    const offset = (page - 1) * limit;

    // Validate sort parameter with whitelist
    const VALID_SORT_COLUMNS: Record<string, string> = {
      prompts: 'promptCount',
      tokens: 'tokenCount',
      lines: 'linesWritten',
      messages: 'messageCount',
      sessions: 'sessionCount',
      tools: 'toolCallCount',
    };

    const sortColumn = VALID_SORT_COLUMNS[sort];
    if (!sortColumn) {
      return c.json({ error: 'Invalid sort parameter' }, 400);
    }

    // Calculate date filter based on period
    let dateFilter: string | null = null;
    const today = new Date();

    switch (period) {
      case 'today':
        dateFilter = today.toISOString().split('T')[0];
        break;
      case 'week': {
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        dateFilter = weekAgo.toISOString().split('T')[0];
        break;
      }
      case 'month': {
        const monthAgo = new Date(today);
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        dateFilter = monthAgo.toISOString().split('T')[0];
        break;
      }
      case 'all':
      default:
        dateFilter = null;
    }

    // For "all" period, we can use the optimized users.total_* columns
    // For other periods, we still need to query daily_stats or ClickHouse
    if (period === 'all') {
      // V2 optimized query: Use users.total_* for OTel users, sum daily_stats for legacy
      // This is a unified query that handles both data sources
      const results = await db.all(sql`
        SELECT
          u.id as userId,
          u.github_username as githubUsername,
          u.avatar_url as avatarUrl,
          u.badges,
          u.otel_enabled as otelEnabled,
          -- For OTel users, use cached totals. For legacy, sum daily_stats.
          CASE
            WHEN u.otel_enabled = 1 THEN u.total_prompts
            ELSE COALESCE((SELECT SUM(prompt_count) FROM daily_stats WHERE user_id = u.id), 0)
          END as promptCount,
          CASE
            WHEN u.otel_enabled = 1 THEN u.total_tokens
            ELSE COALESCE((SELECT SUM(token_count) FROM daily_stats WHERE user_id = u.id), 0)
          END as tokenCount,
          CASE
            WHEN u.otel_enabled = 1 THEN u.total_lines_added
            ELSE COALESCE((SELECT SUM(lines_written) FROM daily_stats WHERE user_id = u.id), 0)
          END as linesWritten,
          CASE
            WHEN u.otel_enabled = 1 THEN u.total_commits
            ELSE COALESCE((SELECT SUM(commit_count) FROM daily_stats WHERE user_id = u.id), 0)
          END as commitCount,
          CASE
            WHEN u.otel_enabled = 1 THEN u.total_cost_cents
            ELSE COALESCE((SELECT SUM(cost_usd_cents) FROM daily_stats WHERE user_id = u.id), 0)
          END as costUsdCents,
          -- Legacy fields (for backward compat)
          COALESCE((SELECT SUM(message_count) FROM daily_stats WHERE user_id = u.id), 0) as messageCount,
          COALESCE((SELECT SUM(tool_call_count) FROM daily_stats WHERE user_id = u.id), 0) as toolCallCount,
          COALESCE((SELECT SUM(session_count) FROM daily_stats WHERE user_id = u.id), 0) as sessionCount
        FROM users u
        WHERE u.otel_enabled = 1
           OR EXISTS (SELECT 1 FROM daily_stats WHERE user_id = u.id)
        ORDER BY ${sql.raw(sortColumn)} DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `) as any[];

      // Get total count
      const countResult = await db.all(sql`
        SELECT COUNT(*) as count
        FROM users u
        WHERE u.otel_enabled = 1
           OR EXISTS (SELECT 1 FROM daily_stats WHERE user_id = u.id)
      `) as any[];
      const total = countResult[0]?.count || 0;

      // Transform results
      const entries: LeaderboardEntry[] = results.map((row: any, index: number) => {
        let badges: string[] = [];
        try {
          badges = row.badges ? JSON.parse(row.badges) : [];
        } catch {
          badges = [];
        }
        return {
          rank: offset + index + 1,
          userId: row.userId,
          githubUsername: row.githubUsername,
          avatarUrl: row.avatarUrl,
          promptCount: Number(row.promptCount) || 0,
          tokenCount: Number(row.tokenCount) || 0,
          linesWritten: Number(row.linesWritten) || 0,
          commitCount: Number(row.commitCount) || 0,
          costUsdCents: Number(row.costUsdCents) || 0,
          messageCount: Number(row.messageCount) || 0,
          toolCallCount: Number(row.toolCallCount) || 0,
          sessionCount: Number(row.sessionCount) || 0,
          badges,
        };
      });

      const response: LeaderboardResponse = {
        entries,
        period,
        total,
        page,
        pageSize: limit,
      };

      // Check if this is an HTMX request
      const isHtmxRequest = c.req.header('HX-Request') === 'true';
      if (isHtmxRequest) {
        return c.html(renderLeaderboardHtml(entries, period, page, total, limit));
      }
      return c.json(response);
    }

    // For period-based queries, we need to merge:
    // 1. Legacy users from dailyStats
    // 2. OTEL users from ClickHouse
    //
    // Strategy: Query both, merge results, sort by the requested column

    // 1. Get legacy users from dailyStats (non-OTEL users)
    const legacyResults = await db
      .select({
        userId: users.id,
        githubUsername: users.githubUsername,
        avatarUrl: users.avatarUrl,
        badges: users.badges,
        otelEnabled: users.otelEnabled,
        promptCount: sql<number>`sum(${dailyStats.promptCount})`.as('total_prompts'),
        messageCount: sql<number>`sum(${dailyStats.messageCount})`.as('total_messages'),
        toolCallCount: sql<number>`sum(${dailyStats.toolCallCount})`.as('total_tools'),
        tokenCount: sql<number>`sum(${dailyStats.tokenCount})`.as('total_tokens'),
        linesWritten: sql<number>`sum(${dailyStats.linesWritten})`.as('total_lines'),
        commitCount: sql<number>`sum(${dailyStats.commitCount})`.as('total_commits'),
        sessionCount: sql<number>`sum(${dailyStats.sessionCount})`.as('total_sessions'),
      })
      .from(dailyStats)
      .innerJoin(users, eq(dailyStats.userId, users.id))
      .where(and(
        dateFilter ? gte(dailyStats.date, dateFilter) : undefined,
        eq(users.otelEnabled, false), // Only non-OTEL users
      ))
      .groupBy(users.id, users.githubUsername, users.avatarUrl, users.badges, users.otelEnabled);

    // 2. Get OTEL users from ClickHouse
    let otelResults: Array<{
      userId: string;
      githubUsername: string;
      avatarUrl: string | null;
      badges: string | null;
      promptCount: number;
      tokenCount: number;
      linesWritten: number;
      commitCount: number;
    }> = [];

    try {
      const { clickhouse } = await import('../db/clickhouse');
      const chPeriod = period as 'today' | 'week' | 'month';
      const chResults = await clickhouse.getLeaderboard(chPeriod, 'prompts', 1000, 0);

      // Get user info for ClickHouse results
      const otelUserIds = chResults.entries.map(e => e.user_id);
      if (otelUserIds.length > 0) {
        const userInfos = await db
          .select({
            id: users.id,
            githubUsername: users.githubUsername,
            avatarUrl: users.avatarUrl,
            badges: users.badges,
            legacyPrompts: users.legacyTotalPrompts,
            legacyCost: users.legacyTotalCostUsdCents,
            legacyLines: users.legacyTotalLinesAdded,
            legacyCommits: users.legacyTotalCommits,
          })
          .from(users)
          .where(eq(users.otelEnabled, true));

        const userMap = new Map(userInfos.map(u => [u.id, u]));

        otelResults = chResults.entries
          .filter(e => userMap.has(e.user_id))
          .map(e => {
            const u = userMap.get(e.user_id)!;
            return {
              userId: e.user_id,
              githubUsername: u.githubUsername,
              avatarUrl: u.avatarUrl,
              badges: u.badges,
              // For period queries, only show OTEL data (not legacy - that's historical)
              promptCount: e.total_prompts,
              tokenCount: e.total_tokens,
              linesWritten: e.total_lines_added,
              commitCount: e.total_commits,
            };
          });
      }
    } catch (error) {
      console.error('[Leaderboard] ClickHouse query failed, using legacy only:', error);
    }

    // 3. Merge results
    const merged = [
      ...legacyResults.map(row => ({
        userId: row.userId,
        githubUsername: row.githubUsername,
        avatarUrl: row.avatarUrl,
        badges: row.badges,
        promptCount: row.promptCount || 0,
        tokenCount: row.tokenCount || 0,
        linesWritten: row.linesWritten || 0,
        commitCount: row.commitCount || 0,
        messageCount: row.messageCount || 0,
        toolCallCount: row.toolCallCount || 0,
        sessionCount: row.sessionCount || 0,
      })),
      ...otelResults.map(row => ({
        userId: row.userId,
        githubUsername: row.githubUsername,
        avatarUrl: row.avatarUrl,
        badges: row.badges,
        promptCount: row.promptCount,
        tokenCount: row.tokenCount,
        linesWritten: row.linesWritten,
        commitCount: row.commitCount,
        messageCount: 0,
        toolCallCount: 0,
        sessionCount: 0,
      })),
    ];

    // 4. Sort by requested column
    const sortKey = sortColumn === 'promptCount' ? 'promptCount' :
      sortColumn === 'tokenCount' ? 'tokenCount' :
      sortColumn === 'linesWritten' ? 'linesWritten' :
      sortColumn === 'commitCount' ? 'commitCount' : 'promptCount';

    merged.sort((a, b) => (b[sortKey as keyof typeof b] as number) - (a[sortKey as keyof typeof a] as number));

    // 5. Paginate
    const total = merged.length;
    const paginatedResults = merged.slice(offset, offset + limit);

    // Transform results
    const entries: LeaderboardEntry[] = paginatedResults.map((row, index) => {
      let badges: string[] = [];
      try {
        badges = row.badges ? JSON.parse(row.badges) : [];
      } catch {
        badges = [];
      }
      return {
        rank: offset + index + 1,
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
      };
    });

    const response: LeaderboardResponse = {
      entries,
      period,
      total,
      page,
      pageSize: limit,
    };

    const isHtmxRequest = c.req.header('HX-Request') === 'true';
    if (isHtmxRequest) {
      return c.html(renderLeaderboardHtml(entries, period, page, total, limit));
    }
    return c.json(response);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return c.json({ error: 'Failed to fetch leaderboard' }, 500);
  }
});

// Helper function to render leaderboard HTML for HTMX
function renderLeaderboardHtml(
  entries: LeaderboardEntry[],
  period: string,
  page: number,
  total: number,
  pageSize: number
): string {
  if (entries.length === 0) {
    return `
      <div class="text-center py-8 text-gray-500">
        <p>No data available for this period.</p>
      </div>
    `;
  }

  const rows = entries.map((entry) => {
    const badgeEmojis = entry.badges ? formatBadgesCompact(entry.badges) : '';
    const formattedTokens = formatTokensCompact(entry.tokenCount);
    const formattedLines = entry.linesWritten > 0 ? formatTokensCompact(entry.linesWritten) : '—';
    return `
    <tr class="border-b border-gray-100 hover:bg-gray-50">
      <td class="py-3 px-4 text-center font-medium">${entry.rank}</td>
      <td class="py-3 px-4">
        <div class="flex items-center gap-3">
          ${entry.avatarUrl
            ? `<img src="${escapeHtml(entry.avatarUrl)}" alt="" class="w-8 h-8 rounded-full" />`
            : `<div class="w-8 h-8 rounded-full bg-gray-200"></div>`
          }
          <a href="/u/${escapeHtml(entry.githubUsername)}"
             class="font-medium text-blue-600 hover:underline">
            ${escapeHtml(entry.githubUsername)}
          </a>
          ${badgeEmojis ? `<span class="text-sm" title="Badges">${badgeEmojis}</span>` : ''}
        </div>
      </td>
      <td class="py-3 px-4 text-center">${entry.promptCount.toLocaleString()}</td>
      <td class="py-3 px-4 text-center">${formattedLines}</td>
      <td class="py-3 px-4 text-center">${formattedTokens}</td>
    </tr>
  `;
  }).join('');

  const totalPages = Math.ceil(total / pageSize);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return `
    <table class="w-full">
      <thead>
        <tr class="border-b-2 border-gray-200 text-left">
          <th class="py-3 px-4 text-center w-16">#</th>
          <th class="py-3 px-4">User</th>
          <th class="py-3 px-4 text-center">Prompts</th>
          <th class="py-3 px-4 text-center">Lines</th>
          <th class="py-3 px-4 text-center">Tokens</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <div class="flex justify-between items-center mt-4 px-4">
      <span class="text-sm text-gray-500">
        Showing ${((page - 1) * pageSize) + 1}-${Math.min(page * pageSize, total)} of ${total}
      </span>
      <div class="flex gap-2">
        ${hasPrev
          ? `<button hx-get="/api/leaderboard?period=${period}&page=${page - 1}&limit=${pageSize}"
                     hx-target="#leaderboard-content"
                     hx-swap="innerHTML"
                     class="px-3 py-1 border rounded hover:bg-gray-100">
               Previous
             </button>`
          : `<button disabled class="px-3 py-1 border rounded text-gray-300 cursor-not-allowed">
               Previous
             </button>`
        }
        ${hasNext
          ? `<button hx-get="/api/leaderboard?period=${period}&page=${page + 1}&limit=${pageSize}"
                     hx-target="#leaderboard-content"
                     hx-swap="innerHTML"
                     class="px-3 py-1 border rounded hover:bg-gray-100">
               Next
             </button>`
          : `<button disabled class="px-3 py-1 border rounded text-gray-300 cursor-not-allowed">
               Next
             </button>`
        }
      </div>
    </div>
  `;
}

// Helper function to escape HTML
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char] || char);
}

// Helper function to format tokens with K/M/B suffix
function formatTokensCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toString();
}

// GET /api/me - Get current user's profile data (requires auth)
// Dashboard V2: Now includes archetype, cost, and derived metrics
api.get('/me', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Get user data
    const userData = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    if (userData.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    const profile = userData[0]!;

    // Get aggregate stats with V3 token breakdown
    const statsResult = await db
      .select({
        totalPrompts: sql<number>`sum(${dailyStats.promptCount})`,
        totalMessages: sql<number>`sum(${dailyStats.messageCount})`,
        totalToolCalls: sql<number>`sum(${dailyStats.toolCallCount})`,
        totalTokens: sql<number>`sum(${dailyStats.tokenCount})`,
        totalLines: sql<number>`sum(${dailyStats.linesWritten})`,
        totalCommits: sql<number>`sum(${dailyStats.commitCount})`,
        totalSessions: sql<number>`sum(${dailyStats.sessionCount})`,
        // V3: Full token breakdown
        totalInputTokens: sql<number>`sum(${dailyStats.inputTokens})`,
        totalOutputTokens: sql<number>`sum(${dailyStats.outputTokens})`,
        totalCacheReadTokens: sql<number>`sum(${dailyStats.cacheReadTokens})`,
        totalCacheCreationTokens: sql<number>`sum(${dailyStats.cacheCreationTokens})`,
        totalCostCents: sql<number>`sum(${dailyStats.costUsdCents})`,
      })
      .from(dailyStats)
      .where(eq(dailyStats.userId, user.id));

    const stats = statsResult[0];
    const totalPrompts = stats?.totalPrompts || 0;

    // Get user rank (by total prompts - V2)
    const rankResult = await db.all(sql`
      SELECT (
        SELECT COUNT(*) + 1 FROM (
          SELECT subq.id FROM (
            SELECT u.id,
              CASE
                WHEN u.otel_enabled = 1 THEN u.total_prompts
                ELSE COALESCE((SELECT SUM(prompt_count) FROM daily_stats WHERE user_id = u.id), 0)
              END as total_prompts
            FROM users u
            WHERE u.otel_enabled = 1
               OR EXISTS (SELECT 1 FROM daily_stats WHERE user_id = u.id)
          ) subq
          WHERE subq.total_prompts > ${totalPrompts}
        )
      ) as rank
    `) as { rank: number }[];

    // Get total users count
    const totalUsersResult = await db.all(sql`
      SELECT COUNT(*) as count
      FROM users u
      WHERE u.otel_enabled = 1
         OR EXISTS (SELECT 1 FROM daily_stats WHERE user_id = u.id)
    `) as { count: number }[];

    // Parse badges and hourCounts
    let badges: string[] = [];
    let hourCounts: Record<string, number> | null = null;
    try {
      badges = profile.badges ? JSON.parse(profile.badges) : [];
      hourCounts = profile.hourCounts ? JSON.parse(profile.hourCounts) : null;
    } catch {
      badges = [];
    }

    // Calculate derived metrics
    const totalInputTokens = stats?.totalInputTokens || 0;
    const totalOutputTokens = stats?.totalOutputTokens || 0;
    const totalCacheReadTokens = stats?.totalCacheReadTokens || 0;
    const totalCacheCreationTokens = stats?.totalCacheCreationTokens || 0;
    const totalCostCents = stats?.totalCostCents || 0;
    const totalLines = stats?.totalLines || 0;
    const totalCommits = stats?.totalCommits || 0;

    // Simple archetype calculation for API
    let archetype = 'Claude Code User';
    let archetypeDescription = '';

    // Night owl check
    if (hourCounts) {
      const nightHours = ['20', '21', '22', '23', '0', '1', '2', '3', '4'];
      const nightActivity = nightHours.reduce((sum, h) => sum + (hourCounts![h] || 0), 0);
      const totalActivity = Object.values(hourCounts).reduce((a, b) => a + b, 0);
      if (totalActivity > 0 && nightActivity / totalActivity >= 0.5) {
        archetype = 'Night Owl';
        archetypeDescription = `${Math.round((nightActivity / totalActivity) * 100)}% activity after 8pm`;
      }
    }

    // Context maximizer check (overrides if stronger)
    const freshInput = totalInputTokens + totalCacheCreationTokens;
    if (freshInput > 0) {
      const cacheRatio = totalCacheReadTokens / freshInput;
      if (cacheRatio >= 10) {
        archetype = 'Context Maximizer';
        archetypeDescription = `${Math.round(cacheRatio)}x cache reuse ratio`;
      }
    }

    // Derived metrics
    const outputLeverage = totalInputTokens > 0
      ? Math.round(totalOutputTokens / totalInputTokens)
      : 0;
    const cacheEfficiency = freshInput > 0
      ? Math.round((totalCacheReadTokens / freshInput) * 100)
      : 0;

    const rank = rankResult[0]?.rank || 1;
    const totalUsers = totalUsersResult[0]?.count || 1;
    const percentile = totalUsers > 0
      ? Math.max(0.1, Math.ceil((rank / totalUsers) * 1000) / 10)
      : 100;

    return c.json({
      username: profile.githubUsername,
      avatarUrl: profile.avatarUrl,
      rank,
      totalUsers,
      percentile,
      // Dashboard V2: Archetype
      archetype,
      archetypeDescription,
      // Primary metrics
      totalPrompts,
      totalTokens: stats?.totalTokens || 0,
      totalCostCents,
      // Token breakdown (V3)
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      // Code metrics
      totalLines,
      totalCommits,
      // Derived metrics
      outputLeverage,
      cacheEfficiency,
      // Legacy (kept for backward compat)
      totalMessages: stats?.totalMessages || 0,
      totalToolCalls: stats?.totalToolCalls || 0,
      totalSessions: stats?.totalSessions || 0,
      // Streaks and badges
      currentStreak: profile.currentStreak || 0,
      longestStreak: profile.longestStreak || 0,
      badges,
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return c.json({ error: 'Failed to fetch profile' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// OTel Enable/Disable - Mark user as OTel-enabled
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/otel/enable - Mark user as OTel-enabled
// CRITICAL: Snapshots historical data from dailyStats before switching to OTEL
api.post('/otel/enable', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Get today's date as YYYY-MM-DD for the cutoff point
    const today = new Date().toISOString().split('T')[0]!;

    // Get the user's current hourCounts before switching to OTEL
    const existingUser = await db
      .select({ hourCounts: users.hourCounts })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    // CRITICAL: Snapshot all historical data from dailyStats
    // This preserves the user's complete history when transitioning to OTEL
    const legacyTotals = await db
      .select({
        prompts: sql<number>`COALESCE(SUM(${dailyStats.promptCount}), 0)`,
        tokens: sql<number>`COALESCE(SUM(${dailyStats.tokenCount}), 0)`,
        inputTokens: sql<number>`COALESCE(SUM(${dailyStats.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${dailyStats.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`COALESCE(SUM(${dailyStats.cacheReadTokens}), 0)`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${dailyStats.cacheCreationTokens}), 0)`,
        costUsdCents: sql<number>`COALESCE(SUM(${dailyStats.costUsdCents}), 0)`,
        linesAdded: sql<number>`COALESCE(SUM(${dailyStats.linesWritten}), 0)`,
        commits: sql<number>`COALESCE(SUM(${dailyStats.commitCount}), 0)`,
        toolCalls: sql<number>`COALESCE(SUM(${dailyStats.toolCallCount}), 0)`,
      })
      .from(dailyStats)
      .where(eq(dailyStats.userId, user.id));

    const legacy = legacyTotals[0] || {
      prompts: 0, tokens: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, costUsdCents: 0,
      linesAdded: 0, commits: 0, toolCalls: 0,
    };

    console.log(`[OTel Enable] Snapshotting legacy data for ${user.id}:`, legacy);

    await db
      .update(users)
      .set({
        otelEnabled: true,
        otelSetupAt: new Date(),
        otelSetupDate: today,
        // Snapshot historical totals - these are frozen and added to OTEL totals
        legacyTotalPrompts: legacy.prompts,
        legacyTotalTokens: legacy.tokens,
        legacyTotalInputTokens: legacy.inputTokens,
        legacyTotalOutputTokens: legacy.outputTokens,
        legacyTotalCacheReadTokens: legacy.cacheReadTokens,
        legacyTotalCacheCreationTokens: legacy.cacheCreationTokens,
        legacyTotalCostUsdCents: legacy.costUsdCents,
        legacyTotalLinesAdded: legacy.linesAdded,
        legacyTotalCommits: legacy.commits,
        legacyTotalToolCalls: legacy.toolCalls,
        // Snapshot hourCounts - preserves pre-OTEL activity patterns for badges
        legacyHourCounts: existingUser?.hourCounts || null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return c.json({
      success: true,
      otelEnabled: true,
      legacySnapshot: {
        prompts: legacy.prompts,
        tokens: legacy.tokens,
        costCents: legacy.costUsdCents,
        message: 'Historical data preserved. OTEL will add to these totals.',
      },
    });
  } catch (error) {
    console.error('Error enabling OTel:', error);
    return c.json({ error: 'Failed to enable OTel' }, 500);
  }
});

// POST /api/otel/disable - Mark user as OTel-disabled
api.post('/otel/disable', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await db
      .update(users)
      .set({
        otelEnabled: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return c.json({ success: true, otelEnabled: false });
  } catch (error) {
    console.error('Error disabling OTel:', error);
    return c.json({ error: 'Failed to disable OTel' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Plan Usage - Pro/Max rate-limit windows pushed by the CLI statusLine hook
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/plan-usage - Record a snapshot per rate-limit window
// Body: { rate_limits?: {...}, capturedAt?: <epoch seconds>, sessionId?: string }
//
// Claude Code re-renders the status line many times per minute, so this endpoint
// is deliberately forgiving AND deliberately stingy about writes:
//   - a payload with no usable window is a 200 no-op, never an error
//   - a window is only written when it actually moved (see shouldInsertSnapshot)
// sessionId is accepted but not stored — the table is keyed on user + window.
api.post('/plan-usage', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { rate_limits?: unknown; capturedAt?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { windows, rejected } = parseRateLimits(body?.rate_limits);

    // Trust the client's capture time only when it's a plausible epoch that
    // isn't in the future — the statusLine hook runs on the user's machine.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claimedAt = normalizeEpochSeconds(body?.capturedAt);
    const capturedAt = claimedAt !== null && claimedAt <= nowSeconds + 60 ? claimedAt : nowSeconds;

    let inserted = 0;
    for (const window of windows) {
      const latest = await db
        .select({
          usedPercentage: planUsageSnapshots.usedPercentage,
          resetsAt: planUsageSnapshots.resetsAt,
          capturedAt: planUsageSnapshots.capturedAt,
        })
        .from(planUsageSnapshots)
        .where(
          and(
            eq(planUsageSnapshots.userId, user.id),
            eq(planUsageSnapshots.windowType, window.windowType)
          )
        )
        .orderBy(desc(planUsageSnapshots.capturedAt))
        .limit(1)
        .get();

      if (!shouldInsertSnapshot(latest, window, capturedAt)) continue;

      await db.insert(planUsageSnapshots).values({
        userId: user.id,
        windowType: window.windowType,
        usedPercentage: window.usedPercentage,
        resetsAt: window.resetsAt,
        capturedAt,
      });
      inserted++;
    }

    return c.json({
      success: true,
      inserted,
      skipped: windows.length - inserted,
      rejected,
    });
  } catch (error) {
    console.error('Error recording plan usage:', error);
    return c.json({ error: 'Failed to record plan usage' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// OTEL Insights Endpoints (Full Potential)
// Real-time data and rich metrics for OTEL-enabled users
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/me/today - Real-time today's metrics (OTEL users only)
api.get('/me/today', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Check if OTEL is enabled
    const userData = await db
      .select({ otelEnabled: users.otelEnabled })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    if (!userData?.otelEnabled) {
      return c.json({
        error: 'OTEL not enabled',
        message: 'Run `clawdgg setup` to enable real-time metrics',
      }, 400);
    }

    // Dynamic import to avoid issues if ClickHouse not configured
    const { clickhouse } = await import('../db/clickhouse');
    const today = await clickhouse.getUserTodayMetrics(user.id);

    if (!today) {
      return c.json({
        prompts: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        linesAdded: 0,
        linesRemoved: 0,
        commits: 0,
        activeSeconds: 0,
        activeMinutes: 0,
        lastActivity: null,
        message: 'No activity today yet',
      });
    }

    return c.json({
      ...today,
      activeMinutes: Math.round(today.activeSeconds / 60),
      costFormatted: `$${today.costUsd.toFixed(2)}`,
    });
  } catch (error) {
    console.error('Error fetching today metrics:', error);
    return c.json({ error: 'Failed to fetch today metrics' }, 500);
  }
});

// GET /api/me/insights - Rich metrics for OTEL users
api.get('/me/insights', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Get user data including totals
    const userData = await db
      .select({
        otelEnabled: users.otelEnabled,
        totalPrompts: users.totalPrompts,
        totalTokens: users.totalTokens,
        totalCostCents: users.totalCostCents,
        totalLinesAdded: users.totalLinesAdded,
        totalCommits: users.totalCommits,
        totalActiveSeconds: users.totalActiveSeconds,
        legacyPrompts: users.legacyTotalPrompts,
        legacyCost: users.legacyTotalCostUsdCents,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    if (!userData?.otelEnabled) {
      return c.json({
        error: 'OTEL not enabled',
        message: 'Run `clawdgg setup` to enable insights',
      }, 400);
    }

    const { clickhouse } = await import('../db/clickhouse');

    // Fetch all insights in parallel
    const [modelUsage, cacheStats, toolBreakdown, sessionStats, velocityTrend] = await Promise.all([
      clickhouse.getUserModelUsage(user.id),
      clickhouse.getUserCacheStats(user.id),
      clickhouse.getUserToolBreakdown(user.id, 30),
      clickhouse.getUserSessionStats(user.id, 30),
      clickhouse.getUserVelocityTrend(user.id, 30),
    ]);

    // Calculate ROI metrics
    const totalCostDollars = (userData.totalCostCents || 0) / 100;
    const totalLines = userData.totalLinesAdded || 0;
    const totalPrompts = userData.totalPrompts || 0;

    const roiMetrics = {
      linesPerDollar: totalCostDollars > 0 ? Math.round(totalLines / totalCostDollars) : 0,
      linesPerPrompt: totalPrompts > 0 ? (totalLines / totalPrompts).toFixed(1) : '0',
      costPerCommit: userData.totalCommits && userData.totalCommits > 0
        ? (totalCostDollars / userData.totalCommits).toFixed(2)
        : '0',
      tokensPerLine: totalLines > 0
        ? Math.round((userData.totalTokens || 0) / totalLines)
        : 0,
    };

    // Format model diet
    const modelDiet = modelUsage.map(m => ({
      model: m.model,
      displayName: m.model.includes('fable') ? 'Fable' :
                   m.model.includes('mythos') ? 'Mythos' :
                   m.model.includes('opus') ? 'Opus' :
                   m.model.includes('sonnet') ? 'Sonnet' :
                   m.model.includes('haiku') ? 'Haiku' : m.model,
      inputTokens: m.input_tokens,
      outputTokens: m.output_tokens,
      totalTokens: m.input_tokens + m.output_tokens,
      costUsd: m.cost_usd,
      percentage: userData.totalTokens && userData.totalTokens > 0
        ? ((m.input_tokens + m.output_tokens) / userData.totalTokens * 100).toFixed(1)
        : '0',
    }));

    // Calculate average daily metrics from velocity trend
    const avgDaily = velocityTrend.length > 0 ? {
      avgPromptsPerDay: Math.round(velocityTrend.reduce((s, d) => s + d.prompts, 0) / velocityTrend.length),
      avgLinesPerDay: Math.round(velocityTrend.reduce((s, d) => s + d.lines, 0) / velocityTrend.length),
      avgCostPerDay: (velocityTrend.reduce((s, d) => s + d.costUsd, 0) / velocityTrend.length).toFixed(2),
    } : { avgPromptsPerDay: 0, avgLinesPerDay: 0, avgCostPerDay: '0' };

    return c.json({
      // Model diet (which Claudes you use)
      modelDiet,

      // Cache efficiency
      cacheStats: cacheStats ? {
        cacheHitRate: cacheStats.cacheHitRate.toFixed(1),
        estimatedSavingsUsd: cacheStats.estimatedSavingsUsd.toFixed(2),
        totalCacheReadTokens: cacheStats.totalCacheReadTokens,
      } : null,

      // Tool mastery
      toolBreakdown: toolBreakdown.slice(0, 10), // Top 10 tools

      // Session analytics
      sessionStats: sessionStats ? {
        totalSessions: sessionStats.totalSessions,
        avgSessionMinutes: Math.round(sessionStats.avgSessionMinutes),
        avgPromptsPerSession: Math.round(sessionStats.avgPromptsPerSession),
        longestSessionMinutes: Math.round(sessionStats.longestSessionMinutes),
      } : null,

      // ROI metrics
      roi: roiMetrics,

      // Average daily metrics
      averageDaily: avgDaily,

      // Velocity trend (for sparklines)
      velocityTrend,

      // Active time
      activeTime: {
        totalSeconds: userData.totalActiveSeconds || 0,
        totalMinutes: Math.round((userData.totalActiveSeconds || 0) / 60),
        totalHours: ((userData.totalActiveSeconds || 0) / 3600).toFixed(1),
      },

      // Data sources breakdown
      dataSources: {
        legacyPrompts: userData.legacyPrompts || 0,
        legacyCostCents: userData.legacyCost || 0,
        otelPrompts: (userData.totalPrompts || 0) - (userData.legacyPrompts || 0),
        otelCostCents: (userData.totalCostCents || 0) - (userData.legacyCost || 0),
      },
    });
  } catch (error) {
    console.error('Error fetching insights:', error);
    return c.json({ error: 'Failed to fetch insights' }, 500);
  }
});

// GET /api/me/heatmap - Activity heatmap (GitHub-style)
api.get('/me/heatmap', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const userData = await db
      .select({ otelEnabled: users.otelEnabled })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    if (!userData?.otelEnabled) {
      return c.json({
        error: 'OTEL not enabled',
        message: 'Run `clawdgg setup` to enable heatmap',
      }, 400);
    }

    const days = parseInt(c.req.query('days') || '90', 10);
    const { clickhouse } = await import('../db/clickhouse');
    const heatmap = await clickhouse.getActivityHeatmap(user.id, days);

    // Transform to a matrix format for easier frontend rendering
    // Initialize 7x24 matrix (days x hours)
    const matrix: number[][] = Array(7).fill(null).map(() => Array(24).fill(0));
    let maxActivity = 0;

    for (const cell of heatmap) {
      const dayIndex = cell.dayOfWeek - 1; // Convert 1-7 to 0-6
      if (dayIndex >= 0 && dayIndex < 7 && cell.hour >= 0 && cell.hour < 24) {
        matrix[dayIndex][cell.hour] = cell.activity;
        maxActivity = Math.max(maxActivity, cell.activity);
      }
    }

    // Find peak hour
    let peakHour = 0;
    let peakDay = 0;
    let peakValue = 0;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (matrix[d][h] > peakValue) {
          peakValue = matrix[d][h];
          peakHour = h;
          peakDay = d;
        }
      }
    }

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    return c.json({
      matrix,
      maxActivity,
      peak: {
        day: dayNames[peakDay],
        hour: peakHour,
        formatted: `${dayNames[peakDay]} ${peakHour}:00-${peakHour + 1}:00`,
      },
      days,
      raw: heatmap,
    });
  } catch (error) {
    console.error('Error fetching heatmap:', error);
    return c.json({ error: 'Failed to fetch heatmap' }, 500);
  }
});

// GET /api/me/chart - Flexible analytics chart data
// Supports both OTEL (ClickHouse) and legacy (SQLite) data sources
api.get('/me/chart', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const userData = await db
      .select({
        otelEnabled: users.otelEnabled,
        otelSetupDate: users.otelSetupDate,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    // Parse query params
    const metricParam = c.req.query('metric') || 'tokens';
    const periodParam = c.req.query('period') || '30d';
    const groupByParam = c.req.query('groupBy') || 'day';

    // Validate metric
    const validMetrics = ['tokens', 'cost', 'prompts', 'lines', 'commits'] as const;
    type ChartMetric = typeof validMetrics[number];
    const metric: ChartMetric = validMetrics.includes(metricParam as ChartMetric)
      ? (metricParam as ChartMetric)
      : 'tokens';

    // Validate period
    const validPeriods = ['1d', '7d', '30d', '90d', 'all'] as const;
    type ChartPeriod = typeof validPeriods[number];
    const period: ChartPeriod = validPeriods.includes(periodParam as ChartPeriod)
      ? (periodParam as ChartPeriod)
      : '30d';

    // Validate groupBy — ignored for '1d', which is always hourly
    const validGroupBys = ['day', 'week', 'month'] as const;
    type ChartGroupBy = typeof validGroupBys[number];
    const groupBy: ChartGroupBy = validGroupBys.includes(groupByParam as ChartGroupBy)
      ? (groupByParam as ChartGroupBy)
      : 'day';

    const { clickhouse, getLegacyChartData, mergeChartData } = await import('../db/clickhouse');

    // ═══════════════════════════════════════════════════════════════════════
    // Case 1: Non-OTEL user requesting "Today" (hourly view)
    // Hourly granularity requires OTEL - show friendly message
    // ═══════════════════════════════════════════════════════════════════════
    if (!userData?.otelEnabled && period === '1d') {
      return c.json({
        noData: true,
        reason: 'otel_required',
        message: 'Hourly breakdown requires OTEL telemetry',
        action: 'Run clawdgg otel to enable',
        fallbackPeriod: '7d',
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 2: Non-OTEL user requesting daily data
    // Use legacy SQLite data only
    // ═══════════════════════════════════════════════════════════════════════
    if (!userData?.otelEnabled) {
      const legacyData = await getLegacyChartData(user.id, metric, period, groupBy);
      if (!legacyData) {
        return c.json({
          noData: true,
          reason: 'no_data',
          message: 'No data available for this period',
        });
      }
      return c.json(legacyData);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 3: OTEL user - get ClickHouse data and optionally merge with legacy
    // ═══════════════════════════════════════════════════════════════════════
    const otelData = await clickhouse.getChartData(user.id, metric, period, groupBy);

    // For hourly view, no legacy data to merge
    if (period === '1d') {
      return c.json(otelData);
    }

    // Check if period extends before OTEL setup date
    const otelSetupDate = userData.otelSetupDate;
    if (otelSetupDate && period !== '1d') {
      // Calculate the start date of the requested period. Week/month grouping
      // doesn't widen it — buckets partition exactly the days the daily view
      // covers — so the same day math still decides whether legacy is needed.
      const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365 * 10;
      const periodStartDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;

      // If period starts before OTEL setup, fetch and merge legacy data
      if (periodStartDate < otelSetupDate) {
        // Get legacy data for dates BEFORE otelSetupDate
        const legacyData = await getLegacyChartData(user.id, metric, period, groupBy, otelSetupDate);

        if (legacyData && legacyData.labels.length > 0) {
          // Merge legacy + OTEL data
          const mergedData = mergeChartData(legacyData, otelData);
          return c.json(mergedData);
        }
      }
    }

    // No legacy data to merge, return OTEL data as-is
    return c.json(otelData);
  } catch (error) {
    console.error('Error fetching chart data:', error);
    return c.json({ error: 'Failed to fetch chart data' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin Endpoints
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/admin/sync - Manually trigger ClickHouse → SQLite sync
// Only works if ADMIN_TOKEN env var is set and matches
api.post('/admin/sync', async (c) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return c.json({ error: 'Admin endpoint disabled' }, 403);
  }

  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${adminToken}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    // Dynamic import to avoid circular dependencies
    const { triggerSync } = await import('../jobs/sync-clickhouse');
    const result = await triggerSync();
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error('Error triggering sync:', error);
    return c.json({ error: 'Sync failed', details: String(error) }, 500);
  }
});

export default api;
