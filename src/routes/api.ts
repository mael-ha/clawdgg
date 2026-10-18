import { Hono } from 'hono';
import { db } from '../db';
import { users, planUsageSnapshots } from '../db/schema';
import { eq, sql, desc, and, gte, inArray } from 'drizzle-orm';
import { requireAuth, optionalAuth } from '../lib/auth-middleware';
import type { LeaderboardEntry, LeaderboardResponse } from '../types';
import { normalizeEpochSeconds, parseRateLimits, shouldInsertSnapshot } from '../lib/plan-usage';
import { getModelDisplayName } from '../lib/pricing';
import { isValidTimezone, normalizeTimezone } from '../lib/timezone';
import { getFingerprint, type FingerprintData, type FingerprintSection } from '../lib/fingerprint';
import { TtlCache } from '../lib/ttl-cache';

const api = new Hono();

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/stats — RETIRED
//
// This was the pre-OTEL CLI's upload endpoint: the old `clawdgg sync` posted a
// day-by-day summary and the server UPSERTed it into SQLite `daily_stats`.
// Every read of that table is gone — ClickHouse is the single source for every
// number the site shows — so an accepted submission would write to a table
// nobody reads, and look to the user like it worked.
//
// 410 Gone, not 404: the endpoint existed, it is deliberately withdrawn, and
// the response says what to do instead. A 4xx also stops an old CLI retrying
// forever, which a 5xx would not.
// ═══════════════════════════════════════════════════════════════════════════
api.post('/stats', (c) =>
  c.json(
    {
      error: 'Endpoint retired',
      message:
        'clawd.gg no longer accepts uploaded daily summaries. Upgrade the CLI ' +
        '(`clawdgg upgrade`, then `clawdgg setup`) to stream usage over OTEL, ' +
        'and `clawdgg import` to load your local history.',
      upgrade: 'https://clawd.gg',
    },
    410
  )
);

// GET /api/leaderboard - Get leaderboard data
//
// ONE source. `users.total_*` is ClickHouse's answer, cached every 5 minutes by
// src/jobs/sync-clickhouse.ts, and period queries go straight to ClickHouse.
// This endpoint used to UNION SQLite daily_stats sums for non-OTEL users with
// ClickHouse figures for OTEL ones, which meant the same column on the same
// page could be two different measurements. The pre-OTEL history now lives in
// ClickHouse too, so there is nothing left to union.
api.get('/leaderboard', optionalAuth, async (c) => {
  try {
    const period = (c.req.query('period') || 'all') as 'today' | 'week' | 'month' | 'all';
    const sort = (c.req.query('sort') || 'prompts') as string;
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '42', 10)));
    const offset = (page - 1) * limit;

    // Only metrics ClickHouse actually answers. `messages`, `sessions` and
    // `tools` used to be sortable off daily_stats columns; sorting by a number
    // we can no longer compute would silently order by nothing, so they are a
    // 400 rather than a lie.
    const SORTABLE = {
      prompts: { sqlite: 'total_prompts', ch: 'prompts' },
      tokens: { sqlite: 'total_tokens', ch: 'tokens' },
      lines: { sqlite: 'total_lines_added', ch: 'lines' },
      commits: { sqlite: 'total_commits', ch: 'commits' },
      cost: { sqlite: 'total_cost_cents', ch: 'cost' },
    } as const;

    const sortSpec = SORTABLE[sort as keyof typeof SORTABLE];
    if (!sortSpec) {
      return c.json(
        { error: `Invalid sort parameter. Valid: ${Object.keys(SORTABLE).join(', ')}` },
        400
      );
    }

    const toEntry = (
      row: { userId: string; githubUsername: string; avatarUrl: string | null; badges: string | null },
      metrics: Omit<LeaderboardEntry, 'rank' | 'userId' | 'githubUsername' | 'avatarUrl' | 'badges'>,
      index: number
    ): LeaderboardEntry => {
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
        ...metrics,
        badges,
      };
    };

    // ═══════════════════════════════════════════════════════════════════════
    // All-time: the synced totals, which is what the homepage renders too.
    //
    // Membership rule: a user is on the leaderboard when ClickHouse has usage
    // for them. `users.total_*` IS that answer, so a non-zero total is exactly
    // the condition — no `otel_enabled` flag, no `EXISTS (daily_stats)`.
    // ═══════════════════════════════════════════════════════════════════════
    if (period === 'all') {
      const HAS_USAGE = sql`(COALESCE(u.total_prompts, 0) > 0 OR COALESCE(u.total_tokens, 0) > 0)`;

      const results = (await db.all(sql`
        SELECT
          u.id as userId,
          u.github_username as githubUsername,
          u.avatar_url as avatarUrl,
          u.badges,
          COALESCE(u.total_prompts, 0) as promptCount,
          COALESCE(u.total_tokens, 0) as tokenCount,
          COALESCE(u.total_lines_added, 0) as linesWritten,
          COALESCE(u.total_commits, 0) as commitCount,
          COALESCE(u.total_cost_cents, 0) as costUsdCents
        FROM users u
        WHERE ${HAS_USAGE}
        ORDER BY ${sql.raw(sortSpec.sqlite)} DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `)) as any[];

      const countResult = (await db.all(sql`
        SELECT COUNT(*) as count FROM users u WHERE ${HAS_USAGE}
      `)) as any[];

      const response: LeaderboardResponse = {
        entries: results.map((row, index) =>
          toEntry(row, {
            promptCount: Number(row.promptCount) || 0,
            tokenCount: Number(row.tokenCount) || 0,
            linesWritten: Number(row.linesWritten) || 0,
            commitCount: Number(row.commitCount) || 0,
            costUsdCents: Number(row.costUsdCents) || 0,
          }, index)
        ),
        period,
        total: countResult[0]?.count || 0,
        page,
        pageSize: limit,
      };
      return c.json(response);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Period views: ClickHouse directly. There is no SQLite fallback on
    // purpose — a leaderboard that silently drops to a different measurement
    // when ClickHouse is unreachable is worse than one that says it is down.
    // ═══════════════════════════════════════════════════════════════════════
    const { clickhouse } = await import('../db/clickhouse');
    const chResults = await clickhouse.getLeaderboard(period, sortSpec.ch, limit, offset);

    const userIds = chResults.entries.map((e) => e.user_id);
    const userInfos = userIds.length
      ? await db
          .select({
            id: users.id,
            githubUsername: users.githubUsername,
            avatarUrl: users.avatarUrl,
            badges: users.badges,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const userMap = new Map(userInfos.map((u) => [u.id, u]));

    const entries = chResults.entries
      .filter((e) => userMap.has(e.user_id))
      .map((e, index) => {
        const u = userMap.get(e.user_id)!;
        return toEntry(
          { userId: e.user_id, githubUsername: u.githubUsername, avatarUrl: u.avatarUrl, badges: u.badges },
          {
            promptCount: e.total_prompts,
            tokenCount: e.total_tokens,
            linesWritten: e.total_lines_added,
            commitCount: e.total_commits,
            costUsdCents: Math.round(e.total_cost_usd * 100),
          },
          index
        );
      });

    const response: LeaderboardResponse = {
      entries,
      period,
      total: chResults.total,
      page,
      pageSize: limit,
    };
    return c.json(response);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return c.json({ error: 'Failed to fetch leaderboard' }, 500);
  }
});

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

    // Totals come from users.total_*, which src/jobs/sync-clickhouse.ts fills
    // from ClickHouse — the same numbers the leaderboard and the profile page
    // render. This used to sum SQLite daily_stats, so /api/me and the profile
    // could disagree about the same user's prompt count.
    const totalPrompts = profile.totalPrompts || 0;

    const rankResult = await db.all(sql`
      SELECT COUNT(*) + 1 as rank
      FROM users u
      WHERE COALESCE(u.total_prompts, 0) > ${totalPrompts}
    `) as { rank: number }[];

    const totalUsersResult = await db.all(sql`
      SELECT COUNT(*) as count
      FROM users u
      WHERE COALESCE(u.total_prompts, 0) > 0 OR COALESCE(u.total_tokens, 0) > 0
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
    const totalInputTokens = profile.totalInputTokens || 0;
    const totalOutputTokens = profile.totalOutputTokens || 0;
    const totalCacheReadTokens = profile.totalCacheReadTokens || 0;
    const totalCacheCreationTokens = profile.totalCacheCreationTokens || 0;
    const totalCostCents = profile.totalCostCents || 0;
    const totalLines = profile.totalLinesAdded || 0;
    const totalCommits = profile.totalCommits || 0;

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
      totalTokens: profile.totalTokens || 0,
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
//
// IDEMPOTENT. `clawdgg setup` is re-run routinely — after a reinstall, on a
// second machine, or just because the user is unsure it worked — and this used
// to re-snapshot SQLite daily_stats into users.legacy_total_* and move
// otel_setup_date to today on every call. Both were destructive:
//
//   - otel_setup_date is the cutoff the daily_stats import uses to decide which
//     days are "before OTEL". Moving it forward re-classifies days that OTEL
//     already covers as legacy, which is how history gets imported twice.
//   - the legacy_total_* snapshot was ADDED to the ClickHouse totals, so
//     re-snapshotting silently inflated every all-time number.
//
// Nothing reads legacy_total_* any more, so it is no longer written at all. The
// existing column values are left untouched for forensics; see
// docker/clickhouse/migrations/README-2026-10.md.
api.post('/otel/enable', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const existing = await db
      .select({
        otelEnabled: users.otelEnabled,
        otelSetupAt: users.otelSetupAt,
        otelSetupDate: users.otelSetupDate,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    // Already set up: report the ORIGINAL date and change nothing.
    if (existing?.otelSetupAt || existing?.otelSetupDate) {
      return c.json({
        success: true,
        otelEnabled: true,
        alreadyEnabled: true,
        otelSetupDate: existing.otelSetupDate,
      });
    }

    const today = new Date().toISOString().split('T')[0]!;

    await db
      .update(users)
      .set({
        otelEnabled: true,
        otelSetupAt: new Date(),
        otelSetupDate: today,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    console.log(`[OTel Enable] ${user.id} enabled, cutoff ${today}`);

    return c.json({
      success: true,
      otelEnabled: true,
      alreadyEnabled: false,
      otelSetupDate: today,
    });
  } catch (error) {
    console.error('Error enabling OTel:', error);
    return c.json({ error: 'Failed to enable OTel' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/u/:username/fingerprint — the profile's data layer
// ═══════════════════════════════════════════════════════════════════════════
//
// PUBLIC, because a profile is. Sections the owner has hidden are left OUT of
// the payload for everyone else rather than zeroed, and `sections` / `hidden`
// name which is which — a viewer sees a gap, never a wrong number.
//
// The cache is short and never holds a failure: `getFingerprint` throws if
// ClickHouse is unreachable, and the throw never reaches the cache, so the next
// request retries instead of serving an empty fingerprint for a whole minute.
// An all-zero fingerprint is indistinguishable from "this person has never
// used Claude Code", which is the one thing it must not be able to say wrongly.
const FINGERPRINT_TTL_MS = 60_000;
const fingerprintCache = new TtlCache<FingerprintData>(FINGERPRINT_TTL_MS);

api.get('/u/:username/fingerprint', optionalAuth, async (c) => {
  const username = c.req.param('username');

  const row = await db
    .select({ id: users.id, githubUsername: users.githubUsername, timezone: users.timezone })
    .from(users)
    .where(eq(users.githubUsername, username))
    .get();

  if (!row) return c.json({ error: 'No such user' }, 404);

  const isOwner = c.get('user')?.githubUsername === row.githubUsername;

  try {
    // F6 replaces the empty list with the owner's profile_settings. Until the
    // settings exist there is nothing anyone can have hidden, so an empty list
    // is the truth rather than a placeholder.
    const hidden: FingerprintSection[] = isOwner ? [] : [];

    const data = await fingerprintCache.remember(
      `${row.id}|${isOwner ? 'owner' : 'public'}`,
      () =>
        getFingerprint(row.id, {
          username: row.githubUsername,
          timezone: row.timezone,
          hidden,
        })
    );
    return c.json(data);
  } catch (error) {
    console.error(`[fingerprint] ${username}:`, error);
    return c.json({ error: 'Failed to build fingerprint' }, 503);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Timezone — the wall clock every "when" on the profile is read in
// ═══════════════════════════════════════════════════════════════════════════
//
// GET /api/me/timezone  → { timezone }
// PUT /api/me/timezone  ← { timezone: 'Europe/Paris' }
//
// One endpoint, two callers: `clawdgg setup` posts the zone Intl resolves on
// the machine, and the settings UI posts whatever the user picks. requireAuth
// takes either a bearer or the session cookie, so neither needs its own route.
//
// An unknown zone is a 400 rather than a silent fallback to UTC: writing UTC
// after being told 'Europe/Pariss' would leave the user looking at the wrong
// peak hour with nothing to tell them why.
api.get('/me/timezone', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, user.id))
    .get();

  return c.json({ timezone: normalizeTimezone(row?.timezone) });
});

api.put('/me/timezone', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { timezone?: unknown };
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!isValidTimezone(body.timezone)) {
    return c.json(
      { error: 'Not an IANA timezone name', example: 'Europe/Paris' },
      400
    );
  }

  await db
    .update(users)
    .set({ timezone: body.timezone, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json({ success: true, timezone: body.timezone });
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
    const [modelUsage, cacheStats, toolBreakdown, sessionStats, velocityTrend, provenance] =
      await Promise.all([
        clickhouse.getUserModelUsage(user.id),
        clickhouse.getUserCacheStats(user.id),
        clickhouse.getUserToolBreakdown(user.id, 30),
        clickhouse.getUserSessionStats(user.id, 30),
        clickhouse.getUserVelocityTrend(user.id, 30),
        clickhouse.getUserProvenanceBreakdown(user.id),
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

    // Format model diet. getModelDisplayName, not a second label chain: the
    // label has to name the tier the cost was actually priced at, and it has to
    // be the same label the profile page shows for the same model.
    const modelDiet = modelUsage.map(m => ({
      model: m.model,
      displayName: getModelDisplayName(m.model),
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

      // Where the numbers came from, straight from ClickHouse. Every row has a
      // provenance, so these parts sum to the whole — no subtraction, nothing
      // that can go negative when one of the two inputs moves.
      dataSources: provenance.map(p => ({
        provenance: p.provenance,
        prompts: p.prompts,
        tokens: p.tokens,
        costCents: Math.round(p.costUsd * 100),
        firstDay: p.firstDay,
        lastDay: p.lastDay,
      })),
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
      .select({ otelEnabled: users.otelEnabled, timezone: users.timezone })
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
    // The grid is hour-of-day by weekday, so it has to be the user's own clock.
    const heatmap = await clickhouse.getActivityHeatmap(user.id, days, userData.timezone);

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
//
// ClickHouse only. There used to be a second chart builder reading SQLite
// daily_stats, plus a merge that aligned the two series by bucket key — and a
// boundary bug in it: the legacy side selected `date <= otelSetupDate` while
// the ClickHouse side started AT otelSetupDate, so the setup day was counted
// twice. The pre-OTEL days are ClickHouse rows now, so one query answers every
// period for every user and there is no boundary to get wrong.
api.get('/me/chart', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const userData = await db
      .select({ otelEnabled: users.otelEnabled, timezone: users.timezone })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    // Parse query params
    const metricParam = c.req.query('metric') || 'tokens';
    const periodParam = c.req.query('period') || '30d';
    const groupByParam = c.req.query('groupBy') || 'day';

    const validMetrics = ['tokens', 'cost', 'prompts', 'lines', 'commits'] as const;
    type ChartMetric = typeof validMetrics[number];
    const metric: ChartMetric = validMetrics.includes(metricParam as ChartMetric)
      ? (metricParam as ChartMetric)
      : 'tokens';

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

    // The one period imported history cannot answer: daily_stats held a day at
    // a time, so every imported row sits at 12:00 UTC. An hourly chart off
    // those rows would be a single noon spike presented as a daily rhythm.
    if (!userData?.otelEnabled && period === '1d') {
      return c.json({
        noData: true,
        reason: 'otel_required',
        message: 'Hourly breakdown requires OTEL telemetry',
        action: 'Run clawdgg setup to enable',
        fallbackPeriod: '7d',
      });
    }

    const { clickhouse } = await import('../db/clickhouse');
    return c.json(
      await clickhouse.getChartData(user.id, metric, period, groupBy, userData?.timezone)
    );
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
