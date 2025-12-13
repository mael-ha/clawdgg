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

    // UPSERT daily stats for each day in dailyActivity
    let lastDate: string | null = null;
    let daysSubmitted = 0;

    for (const day of body.dailyActivity) {
      // Validate date format (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
        continue; // Skip invalid dates
      }

      await db
        .insert(dailyStats)
        .values({
          userId: user.id,
          date: day.date,
          messageCount: day.messageCount || 0,
          sessionCount: day.sessionCount || 0,
          toolCallCount: day.toolCallCount || 0,
        })
        .onConflictDoUpdate({
          target: [dailyStats.userId, dailyStats.date],
          set: {
            messageCount: sql`excluded.message_count`,
            sessionCount: sql`excluded.session_count`,
            toolCallCount: sql`excluded.tool_call_count`,
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
api.get('/leaderboard', optionalAuth, async (c) => {
  try {
    // Parse query parameters
    const period = (c.req.query('period') || 'all') as 'today' | 'week' | 'month' | 'all';
    const sort = (c.req.query('sort') || 'messages') as 'messages' | 'sessions' | 'tools';
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '42', 10)));
    const offset = (page - 1) * limit;

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

    // Determine sort column
    let sortColumn: typeof dailyStats.messageCount | typeof dailyStats.sessionCount | typeof dailyStats.toolCallCount;
    switch (sort) {
      case 'sessions':
        sortColumn = dailyStats.sessionCount;
        break;
      case 'tools':
        sortColumn = dailyStats.toolCallCount;
        break;
      case 'messages':
      default:
        sortColumn = dailyStats.messageCount;
    }

    // Build the base query with aggregation
    const baseQuery = db
      .select({
        userId: users.id,
        githubUsername: users.githubUsername,
        avatarUrl: users.avatarUrl,
        badges: users.badges,
        messageCount: sql<number>`sum(${dailyStats.messageCount})`.as('total_messages'),
        sessionCount: sql<number>`sum(${dailyStats.sessionCount})`.as('total_sessions'),
        toolCallCount: sql<number>`sum(${dailyStats.toolCallCount})`.as('total_tools'),
      })
      .from(dailyStats)
      .innerJoin(users, eq(dailyStats.userId, users.id));

    // Apply date filter if needed
    const queryWithFilter = dateFilter
      ? baseQuery.where(gte(dailyStats.date, dateFilter))
      : baseQuery;

    // Group by user and order by selected column
    const sortColumnName = sort === 'sessions'
      ? 'total_sessions'
      : sort === 'tools'
        ? 'total_tools'
        : 'total_messages';

    const results = await queryWithFilter
      .groupBy(users.id, users.githubUsername, users.avatarUrl, users.badges)
      .orderBy(desc(sql.raw(sortColumnName)))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination
    const countQuery = db
      .select({ count: sql<number>`count(distinct ${dailyStats.userId})` })
      .from(dailyStats);

    const countWithFilter = dateFilter
      ? countQuery.where(gte(dailyStats.date, dateFilter))
      : countQuery;

    const countResult = await countWithFilter;
    const total = countResult[0]?.count || 0;

    // Transform results to LeaderboardEntry format with ranks
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
        messageCount: row.messageCount || 0,
        sessionCount: row.sessionCount || 0,
        toolCallCount: row.toolCallCount || 0,
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

    // Check if this is an HTMX request - return HTML fragment if so
    const isHtmxRequest = c.req.header('HX-Request') === 'true';

    if (isHtmxRequest) {
      // Return HTML fragment for HTMX partial updates
      const html = renderLeaderboardHtml(entries, period, page, total, limit);
      return c.html(html);
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
    return `
    <tr class="border-b border-gray-100 hover:bg-gray-50">
      <td class="py-3 px-4 text-center font-medium">${entry.rank}</td>
      <td class="py-3 px-4">
        <div class="flex items-center gap-3">
          ${entry.avatarUrl
            ? `<img src="${escapeHtml(entry.avatarUrl)}" alt="" class="w-8 h-8 rounded-full" />`
            : `<div class="w-8 h-8 rounded-full bg-gray-200"></div>`
          }
          <a href="https://github.com/${escapeHtml(entry.githubUsername)}"
             target="_blank"
             rel="noopener noreferrer"
             class="font-medium text-blue-600 hover:underline">
            ${escapeHtml(entry.githubUsername)}
          </a>
          ${badgeEmojis ? `<span class="text-sm" title="Badges">${badgeEmojis}</span>` : ''}
        </div>
      </td>
      <td class="py-3 px-4 text-center">${entry.messageCount.toLocaleString()}</td>
      <td class="py-3 px-4 text-center">${entry.sessionCount.toLocaleString()}</td>
      <td class="py-3 px-4 text-center">${entry.toolCallCount.toLocaleString()}</td>
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
          <th class="py-3 px-4 text-center">Messages</th>
          <th class="py-3 px-4 text-center">Sessions</th>
          <th class="py-3 px-4 text-center">Tool Calls</th>
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

export default api;
