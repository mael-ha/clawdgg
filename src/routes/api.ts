import { Hono } from 'hono';
import { db } from '../db';
import { users, planUsageSnapshots } from '../db/schema';
import { eq, sql, desc, and, gte } from 'drizzle-orm';
import { requireAuth, requireBearerAuth, optionalAuth } from '../lib/auth-middleware';
import { normalizeEpochSeconds, parseRateLimits, shouldInsertSnapshot } from '../lib/plan-usage';
import { getModelDisplayName } from '../lib/pricing';
import { DEFAULT_TIMEZONE, canonicalTimezone, normalizeTimezone } from '../lib/timezone';
import { getFingerprint, type FingerprintData } from '../lib/fingerprint';
import {
  getVisibility,
  hiddenFor,
  parseVisibilityPatch,
  setVisibility,
} from '../lib/profile-settings';
import { evictPublicFingerprint, publicFingerprint } from '../lib/public-fingerprint';
import { TtlCache } from '../lib/ttl-cache';
// Route modules, imported for one thing each: the caches a settings change has
// to evict live next to the data they cache, not in a registry here.
import { evictProfileCaches } from './profile';
import { evictCardCache } from './og';

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
        'clawd.gg no longer accepts uploaded daily summaries. Reinstall the CLI ' +
        '(`curl -fsSL https://clawd.gg/install | sh`), then `clawdgg setup` to ' +
        'stream usage over OTEL and `clawdgg import` to load your local history.',
      // The literal install line. This used to name a `clawdgg` subcommand for
      // upgrading, and there is no such subcommand — an instruction that errors
      // is worse than no instruction, because it reads as the site being
      // broken rather than as the CLI being old.
      install: 'curl -fsSL https://clawd.gg/install | sh',
      upgrade: 'https://clawd.gg/install',
    },
    410
  )
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/leaderboard — RETIRED
//
// It answered with everybody's cost, lines and prompts, and it did it WITHOUT
// reading profile_settings — so a user who hid 💎 value on their profile was
// still listed here with their dollars, by name, to anyone who asked. Nothing
// calls it: the homepage, its load-more fragment and every documented client
// read /api/boards, which ranks on the same figures and leaves a user off the
// board whose section they took down (src/lib/boards.ts).
//
// 410 Gone, like POST /api/stats above and for the same reasons: the endpoint
// existed, it is deliberately withdrawn, the response says what to use instead,
// and a 4xx stops an old client retrying where a 5xx would not. Fixing its
// visibility instead would have meant a second ranking implementation with its
// own answer to the same question — which is what /api/boards exists to be.
// ═══════════════════════════════════════════════════════════════════════════
api.get('/leaderboard', (c) =>
  c.json(
    {
      error: 'Endpoint retired',
      message:
        'GET /api/leaderboard is gone — it published figures profile owners had ' +
        'hidden. Use GET /api/boards (board=value|streak|ultrathinks|leverage, ' +
        'scope, limit, offset), which honours those settings.',
      use: '/api/boards',
    },
    410
  )
);

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
// A VISITOR's payload is not cached here at all. It is the shared public
// fingerprint (src/lib/public-fingerprint.ts), the same object the profile page
// and the share card are built from: three surfaces asking ClickHouse the same
// thirteen questions about the same person used to be three fan-outs, and is
// now one. Everything that cache does — a minute fresh, thirty more of stale
// window, single-flight, the hidden list in the key, never a cached failure —
// is documented there.
//
// What stays here is the OWNER's payload, which is a different payload: it
// carries the sections they have taken down and their zone name. It is kept
// apart from the public cache rather than keyed apart in it, so there is no
// argument any caller could pass to get it served to a visitor.
//
// It never holds a failure either: `getFingerprint` throws if ClickHouse is
// unreachable and the throw never reaches the cache, so the next request
// retries instead of serving an empty fingerprint for a whole minute. An
// all-zero fingerprint is indistinguishable from "this person has never used
// Claude Code", which is the one thing it must not be able to say wrongly.
const OWNER_FINGERPRINT_TTL_MS = 60_000;
const OWNER_FINGERPRINT_STALE_MS = 30 * 60_000;
const ownerFingerprintCache = new TtlCache<FingerprintData>(OWNER_FINGERPRINT_TTL_MS, 500, {
  staleMs: OWNER_FINGERPRINT_STALE_MS,
  name: 'owner-fingerprint',
});

/**
 * The owner's key: the user, and nothing else.
 *
 * The hidden list is NOT in it, and that is not an oversight — the owner's
 * payload is unfiltered, so it does not depend on the list, and keying by it
 * would have cached an identical payload once per setting they ever tried. The
 * list IS still in the public cache's key, where the payload really was
 * filtered by it; see the note there. The `|` is kept so the evictions below
 * can stay prefix matches.
 */
function ownerFingerprintKey(userId: string): string {
  return `${userId}|owner`;
}

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
    const hiddenFromOthers = await hiddenFor(row.id);

    const data = isOwner
      ? await ownerFingerprintCache.remember(ownerFingerprintKey(row.id), () =>
          getFingerprint(row.id, {
            username: row.githubUsername,
            timezone: row.timezone,
            isOwner: true,
            // The owner always sees everything, including what they have hidden.
            hidden: [],
          })
        )
      : await publicFingerprint(row, hiddenFromOthers);

    // `hidden` says what is missing from THIS payload; `hiddenFromOthers` says
    // what a visitor would not get. For a visitor they are the same list, and
    // saying so twice is worth less than the owner being able to render their
    // own profile and its toggles from one response.
    return c.json(isOwner ? { ...data, hiddenFromOthers } : data);
  } catch (error) {
    console.error(`[fingerprint] ${username}:`, error);
    return c.json({ error: 'Failed to build fingerprint' }, 503);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET/PUT /api/me/profile-settings — the owner's section toggles
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, and there is no username in the path: these settings are read
// and written for whoever is authenticated, so there is no way to address
// somebody else's.
api.get('/me/profile-settings', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  return c.json({ sections: await getVisibility(user.id) });
});

api.put('/me/profile-settings', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = parseVisibilityPatch(body);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const sections = await setVisibility(user.id, parsed.patch);

  // Every cache that could be holding the figure they just took down, evicted
  // together — the shared public fingerprint FIRST, because the page and the
  // card are built from it and evicting them without it would only have them
  // rebuild from the same stale payload.
  //
  // The hidden list being part of each key (see the GET above) is what makes
  // the next read a miss by construction and stops an in-flight build
  // re-caching a stale payload under it. This clears the keys the PREVIOUS
  // list made, which would otherwise sit out their window unread — and only
  // this user's, which is why each one is a prefix and not a clear().
  evictPublicFingerprint(user.id);
  ownerFingerprintCache.deletePrefix(`${user.id}|`);
  evictProfileCaches(user.githubUsername, user.id);
  evictCardCache(user.id);

  return c.json({ success: true, sections });
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
// Keeping the cookie here is CSRF-safe, and the reason is the cookie's own
// `SameSite=Lax` (src/lib/session.ts), not this handler: Lax sends the session
// cookie on a cross-site TOP-LEVEL GET NAVIGATION and on nothing else, so a
// cross-site PUT — form, fetch or XHR — arrives with no cookie at all and
// requireAuth answers 401 before any of this runs. That reasoning covers every
// cookie-accepting WRITE in this file (they are all POST or PUT) and fails for
// exactly one shape: a state change on a GET. There is one of those, and it is
// GET /auth/logout, which has its own defence in src/routes/auth.ts.
//
// An unknown zone is a 400 rather than a silent fallback to UTC: writing UTC
// after being told 'Europe/Pariss' would leave the user looking at the wrong
// peak hour with nothing to tell them why.
//
// The GET answers `isDefault` as well as the zone, because 'UTC' is ambiguous
// on its own: the column defaults to it, so a user who has never run `clawdgg
// setup` and a user in Reykjavík who has read identically. `clawdgg setup`
// needs to tell those apart to decide whether to offer to set it, and the only
// thing it can key on is whether the stored value is still the default.
//
// `isDefault` is therefore "the stored value is UTC", not "nobody has ever set
// it" — distinguishing those needs a column that records WHEN it was set, and
// nothing has asked for one. `stored` is given raw beside it so a client can
// make its own call. The web profile reads the same way (`timezoneAssumed`).
api.get('/me/timezone', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, user.id))
    .get();

  return c.json({
    timezone: normalizeTimezone(row?.timezone),
    stored: row?.timezone ?? null,
    isDefault: normalizeTimezone(row?.timezone) === DEFAULT_TIMEZONE,
  });
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

  // The CANONICAL spelling is what gets stored, not what was sent. ClickHouse's
  // toTimeZone is case-sensitive and Intl is not, so 'europe/paris' passes
  // validation and then fails every query that converts a timestamp — see
  // canonicalTimezone().
  const timezone = canonicalTimezone(body.timezone);
  if (!timezone) {
    return c.json(
      { error: 'Not an IANA timezone name', example: 'Europe/Paris' },
      400
    );
  }

  // And then ask the engine that will have to use it. Intl and ClickHouse are
  // two different copies of the zone database, and a name only one of them has
  // is a name that converts nothing: better a 400 here than a 503 on the
  // profile afterwards.
  const { clickhouse } = await import('../db/clickhouse');
  if (!(await clickhouse.probeTimezone(timezone))) {
    return c.json(
      {
        error: 'That zone is not one the analytics engine can load',
        timezone,
        hint: 'Use a current IANA name, e.g. Europe/Paris',
      },
      400
    );
  }

  await db
    .update(users)
    .set({ timezone, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Every cached figure for this user was read in the OLD clock — every hour
  // bucket, weekday and week boundary in the fingerprint converts with it. The
  // page and the card are built from the same payload, so they go too; only
  // the fingerprint endpoint was evicted here before, which left the profile
  // and the share card printing the old zone's figures for their own TTLs.
  evictPublicFingerprint(user.id);
  ownerFingerprintCache.deletePrefix(`${user.id}|`);
  evictProfileCaches(user.githubUsername, user.id);
  evictCardCache(user.id);

  return c.json({ success: true, timezone });
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
//
// BEARER ONLY. The only caller is `clawdgg statusline`, which reads the rate
// limits Claude Code hands it and posts them with the CLI's token. Accepting a
// cookie session here let a logged-in browser write plan-usage snapshots, which
// is not a thing a browser knows anything about — the numbers come from the
// local process, and a page cannot have them. Narrowing it costs no caller and
// removes a write path that could only ever be used by something lying.
api.post('/plan-usage', requireBearerAuth, async (c) => {
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
      // Every token type over lines added, because `tokens` means one thing on
      // this response and it is users.total_tokens (TOTAL_TOKENS_SQL). It got
      // about twenty times larger when that column started counting cache
      // reads, which is the figure it now names.
      tokensPerLine: totalLines > 0
        ? Math.round((userData.totalTokens || 0) / totalLines)
        : 0,
    };

    // Format model diet. getModelDisplayName, not a second label chain: the
    // label has to name the tier the cost was actually priced at, and it has to
    // be the same label the profile page shows for the same model.
    // The share is of the DIET'S OWN total, not of users.total_tokens: the two
    // are different populations (this query reads input + output over rows that
    // name a model, that column is every token type over every row), so the
    // percentages used to add up to a number that was not 100 — and once
    // total_tokens became every token type they would have added up to about 5.
    // A share of the models listed is a figure a reader can check by adding the
    // column up.
    const dietTokens = modelUsage.reduce((sum, m) => sum + m.input_tokens + m.output_tokens, 0);
    const modelDiet = modelUsage.map(m => ({
      model: m.model,
      displayName: getModelDisplayName(m.model),
      inputTokens: m.input_tokens,
      outputTokens: m.output_tokens,
      totalTokens: m.input_tokens + m.output_tokens,
      costUsd: m.cost_usd,
      percentage: dietTokens > 0
        ? ((m.input_tokens + m.output_tokens) / dietTokens * 100).toFixed(1)
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
