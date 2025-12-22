import { Hono } from 'hono';
import { db } from '../db';
import { dailyStats, users } from '../db/schema';
import { eq, sql, desc, and, gte, asc } from 'drizzle-orm';
import { requireAuth, optionalAuth } from '../lib/auth-middleware';
import type { StatsSubmission, LeaderboardEntry, LeaderboardResponse } from '../types';
import { computeBadges, formatBadgesCompact, type BadgeInput } from '../lib/badges';

const api = new Hono();

// Helper to calculate streak from sorted dates
function calculateStreaks(dates: string[]): { currentStreak: number; longestStreak: number } {
  if (dates.length === 0) return { currentStreak: 0, longestStreak: 0 };

  const today = new Date().toISOString().split('T')[0]!;
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]!;

  let currentStreak = 0;
  let longestStreak = 0;
  let streak = 1;

  // Check if the most recent date is today or yesterday (for current streak)
  const lastDate = dates[dates.length - 1]!;
  const isActive = lastDate === today || lastDate === yesterday;

  for (let i = 1; i < dates.length; i++) {
    const prevDateStr = dates[i - 1]!;
    const currDateStr = dates[i]!;
    const prevDate = new Date(prevDateStr);
    const currDate = new Date(currDateStr);
    const diffDays = (currDate.getTime() - prevDate.getTime()) / 86400000;

    if (diffDays === 1) {
      streak++;
    } else {
      longestStreak = Math.max(longestStreak, streak);
      streak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, streak);

  // Current streak: count backwards from today/yesterday
  if (isActive) {
    currentStreak = 1;
    for (let i = dates.length - 2; i >= 0; i--) {
      const currDateStr = dates[i + 1]!;
      const prevDateStr = dates[i]!;
      const currDate = new Date(currDateStr);
      const prevDate = new Date(prevDateStr);
      const diffDays = (currDate.getTime() - prevDate.getTime()) / 86400000;

      if (diffDays === 1) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  return { currentStreak, longestStreak };
}

// POST /api/stats - Submit daily stats (requires auth)
api.post('/stats', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
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

    // Get all dates for streak calculation
    const allDates = await db
      .select({ date: dailyStats.date })
      .from(dailyStats)
      .where(eq(dailyStats.userId, user.id))
      .orderBy(asc(dailyStats.date));

    // Calculate streaks
    const { currentStreak, longestStreak } = calculateStreaks(
      allDates.map((d) => d.date)
    );

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
            WHEN u.otel_enabled = 1 THEN u.total_cost_usd
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

    // For period-based queries (today/week/month), use legacy daily_stats query
    // TODO: When ClickHouse is live, query ClickHouse for period-based data
    const baseQuery = db
      .select({
        userId: users.id,
        githubUsername: users.githubUsername,
        avatarUrl: users.avatarUrl,
        badges: users.badges,
        promptCount: sql<number>`sum(${dailyStats.promptCount})`.as('total_prompts'),
        messageCount: sql<number>`sum(${dailyStats.messageCount})`.as('total_messages'),
        toolCallCount: sql<number>`sum(${dailyStats.toolCallCount})`.as('total_tools'),
        tokenCount: sql<number>`sum(${dailyStats.tokenCount})`.as('total_tokens'),
        linesWritten: sql<number>`sum(${dailyStats.linesWritten})`.as('total_lines'),
        commitCount: sql<number>`sum(${dailyStats.commitCount})`.as('total_commits'),
        sessionCount: sql<number>`sum(${dailyStats.sessionCount})`.as('total_sessions'),
      })
      .from(dailyStats)
      .innerJoin(users, eq(dailyStats.userId, users.id));

    // Apply date filter
    const queryWithFilter = dateFilter
      ? baseQuery.where(gte(dailyStats.date, dateFilter))
      : baseQuery;

    // Group and sort
    // Map validated sort column to the alias used in the query
    const sortColumnAlias =
      sortColumn === 'promptCount' ? 'total_prompts' :
      sortColumn === 'tokenCount' ? 'total_tokens' :
      sortColumn === 'linesWritten' ? 'total_lines' :
      sortColumn === 'messageCount' ? 'total_messages' :
      sortColumn === 'sessionCount' ? 'total_sessions' :
      sortColumn === 'toolCallCount' ? 'total_tools' : 'total_prompts';

    const results = await queryWithFilter
      .groupBy(users.id, users.githubUsername, users.avatarUrl, users.badges)
      .orderBy(desc(sql.raw(sortColumnAlias)))
      .limit(limit)
      .offset(offset);

    // Get total count
    const countQuery = db
      .select({ count: sql<number>`count(distinct ${dailyStats.userId})` })
      .from(dailyStats);

    const countWithFilter = dateFilter
      ? countQuery.where(gte(dailyStats.date, dateFilter))
      : countQuery;

    const countResult = await countWithFilter;
    const total = countResult[0]?.count || 0;

    // Transform results
    const entries: LeaderboardEntry[] = results.map((row, index) => {
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

    const profile = userData[0];

    // Get aggregate stats
    const statsResult = await db
      .select({
        totalPrompts: sql<number>`sum(${dailyStats.promptCount})`,
        totalMessages: sql<number>`sum(${dailyStats.messageCount})`,
        totalToolCalls: sql<number>`sum(${dailyStats.toolCallCount})`,
        totalTokens: sql<number>`sum(${dailyStats.tokenCount})`,
        totalLines: sql<number>`sum(${dailyStats.linesWritten})`,
        totalCommits: sql<number>`sum(${dailyStats.commitCount})`,
        totalSessions: sql<number>`sum(${dailyStats.sessionCount})`,
      })
      .from(dailyStats)
      .where(eq(dailyStats.userId, user.id));

    // Get user rank (by total messages)
    const rankResult = await db
      .select({
        rank: sql<number>`(
          SELECT COUNT(*) + 1 FROM (
            SELECT user_id, SUM(message_count) as total
            FROM daily_stats
            GROUP BY user_id
            HAVING total > (
              SELECT COALESCE(SUM(message_count), 0)
              FROM daily_stats
              WHERE user_id = ${user.id}
            )
          )
        )`,
      })
      .from(users)
      .where(eq(users.id, user.id));

    // Get total users count
    const totalUsersResult = await db
      .select({ count: sql<number>`count(distinct user_id)` })
      .from(dailyStats);

    // Parse badges
    let badges: string[] = [];
    try {
      badges = profile.badges ? JSON.parse(profile.badges) : [];
    } catch {
      badges = [];
    }

    return c.json({
      username: profile.githubUsername,
      avatarUrl: profile.avatarUrl,
      rank: rankResult[0]?.rank || 1,
      totalUsers: totalUsersResult[0]?.count || 1,
      // Primary metrics
      totalPrompts: statsResult[0]?.totalPrompts || 0,
      totalTokens: statsResult[0]?.totalTokens || 0,
      // Code metrics
      totalLines: statsResult[0]?.totalLines || 0,
      totalCommits: statsResult[0]?.totalCommits || 0,
      // Legacy (kept for backward compat)
      totalMessages: statsResult[0]?.totalMessages || 0,
      totalToolCalls: statsResult[0]?.totalToolCalls || 0,
      totalSessions: statsResult[0]?.totalSessions || 0,
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
api.post('/otel/enable', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await db
      .update(users)
      .set({
        otelEnabled: true,
        otelSetupAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return c.json({ success: true, otelEnabled: true });
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
