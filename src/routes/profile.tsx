import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { Layout } from '../components/Layout';
import { db } from '../db';
import { profileSettings } from '../db/schema';
import { getFingerprint, type FingerprintData } from '../lib/fingerprint';
import { visibilityOf } from '../lib/profile-settings';
import { TtlCache } from '../lib/ttl-cache';
import type { Island } from '../lib/assets';
import type { SessionUser } from '../types';
import {
  fetchCurve,
  fetchPipeline,
  fetchPlan,
  fetchProfileUser,
  fetchToday,
  fetchYearSeries,
  localToday,
  parseCurveGroupBy,
  parseCurveMetric,
  parseCurvePeriod,
  type ProfileUser,
} from '../lib/profile-data';
import { DEFAULT_TIMEZONE } from '../lib/timezone';
import { ProfileNotFound, ProfilePage } from '../components/profile/ProfilePage';
import { className } from '../components/profile/palette';
import { group, money } from '../components/profile/format';
import type { CurveView } from '../components/profile/curve';
import type { PlanData, Visibility, YearData } from '../components/profile/types';
import type { ContributionDay } from '../components/profile/geometry';

/**
 * /u/:username — the fingerprint.
 *
 * Three routes, and the division between them is what a reader notices going
 * stale:
 *
 *   GET /u/:username         the page. Cached for a minute, because the
 *                            fingerprint, the year and the plan are rollups
 *                            and a minute of a 365-day aggregate is invisible.
 *                            The owner's today and pipeline panels are fetched
 *                            OUTSIDE that cache on every request — the whole
 *                            point of "today" is that it just moved.
 *   GET /u/:username/curve   the activity chart's data, per interaction.
 *                            PUBLIC, and it honours the owner's toggle.
 *   GET /u/:username/card.png  mounted separately — see src/routes/og.ts.
 *
 * The chart endpoint lives here rather than in src/routes/api.ts because the
 * one in api.ts (`/api/me/chart`) is `requireAuth` by construction: it answers
 * for whoever is logged in and has no username in its path, so it cannot
 * answer for a profile being viewed by somebody else. This one takes the
 * username, checks that profile's own visibility, and never reads the session
 * for anything but deciding whether the viewer is the owner.
 */

type Variables = {
  user: SessionUser | null;
};

const app = new Hono<{ Variables: Variables }>();

// ═══════════════════════════════════════════════════════════════════════════
// The page's payload
// ═══════════════════════════════════════════════════════════════════════════

interface ProfilePayload {
  fingerprint: FingerprintData;
  /** What a VISITOR may see. The owner's own page shows everything. */
  visibility: Visibility;
  year: YearData | null;
  curve: CurveView | null;
  plan: PlanData | null;
  /**
   * False when a query behind this payload failed. The cache refuses to keep a
   * payload built during an outage, so the next request retries instead of
   * serving a half-empty page for the rest of the minute.
   */
  complete: boolean;
}

/**
 * A minute of the page, keyed by username AND by whether the viewer owns it.
 *
 * The owner's payload is a DIFFERENT payload — it contains the sections they
 * have hidden — so it cannot share a key with the public one. That was the
 * same decision the fingerprint endpoint made, for the same reason.
 */
const pageCache = new TtlCache<ProfilePayload>(60_000);

/** The default view of ⚡ activity: value, by week, over the last year. */
const DEFAULT_CURVE = { metric: 'value', period: '1y', groupBy: 'week' } as const;

async function buildPayload(user: ProfileUser, isOwner: boolean): Promise<ProfilePayload> {
  const settings = await db
    .select()
    .from(profileSettings)
    .where(eq(profileSettings.userId, user.id))
    .get();
  const visibility = visibilityOf(settings);
  const hiddenFromOthers = (Object.keys(visibility) as (keyof Visibility)[]).filter(
    (section) => !visibility[section]
  );

  // Failures are collected per BUILD, not in a module-level flag: two requests
  // for two profiles are in flight at the same time, and a shared flag would
  // let one profile's dead query stop the other's page being cached.
  const failures: string[] = [];
  const failed = <T,>(what: string, fallback: T) => (error: unknown) => {
    console.error(`[profile] ${what}:`, error);
    failures.push(what);
    return fallback;
  };

  // One wave: none of these depend on each other, and the fan-out is the whole
  // cost of the page. Each failure is isolated so one dead query costs its own
  // section rather than the profile. getFingerprint is the exception — it
  // THROWS, and the route lets it, because a profile with no fingerprint is
  // not a degraded profile, it is a page that should say "try again".
  const [fingerprint, year, curve, plan] = await Promise.all([
    getFingerprint(user.id, {
      username: user.githubUsername,
      timezone: user.timezone,
      // The owner always sees everything, including what they have hidden.
      hidden: isOwner ? [] : hiddenFromOthers,
    }),
    isOwner || visibility.year
      ? fetchYearSeries(user.id, user.timezone).catch(failed('year', null as ContributionDay[] | null))
      : Promise.resolve(null),
    isOwner || visibility.curve
      ? fetchCurve(
          user.id,
          DEFAULT_CURVE.metric,
          DEFAULT_CURVE.period,
          DEFAULT_CURVE.groupBy
        ).catch(failed('curve', null as CurveView | null))
      : Promise.resolve(null),
    isOwner || visibility.plan
      ? fetchPlan(user.id).catch(failed('plan', null as PlanData | null))
      : Promise.resolve(null),
  ]);

  return {
    fingerprint,
    visibility,
    year:
      year === null || year.length === 0
        ? null
        : {
            days: year,
            today: localToday(user.timezone),
            currentStreak: user.currentStreak,
            longestStreak: user.longestStreak,
          },
    curve,
    plan,
    complete: failures.length === 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /u/:username/curve — the activity chart's data
// ═══════════════════════════════════════════════════════════════════════════
//
// PUBLIC, like the profile it is drawn on, and it answers 404 for a profile
// whose owner has hidden ⚡ activity rather than returning an empty series: an
// empty series is a claim about the person, and a 404 is a claim about what
// this endpoint will say.
app.get('/:username/curve', async (c) => {
  const user = await fetchProfileUser(c.req.param('username'));
  if (!user) return c.json({ error: 'No such user' }, 404);

  const isOwner = c.get('user')?.githubUsername === user.githubUsername;
  if (!isOwner) {
    const settings = await db
      .select()
      .from(profileSettings)
      .where(eq(profileSettings.userId, user.id))
      .get();
    if (!visibilityOf(settings).curve) return c.json({ error: 'Not public' }, 404);
  }

  try {
    return c.json(
      await fetchCurve(
        user.id,
        parseCurveMetric(c.req.query('metric')),
        parseCurvePeriod(c.req.query('period')),
        parseCurveGroupBy(c.req.query('groupBy'))
      )
    );
  } catch (error) {
    console.error(`[profile/curve] ${user.githubUsername}:`, error);
    return c.json({ error: 'Failed to build the curve' }, 503);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /u/:username — the page
// ═══════════════════════════════════════════════════════════════════════════

app.get('/:username', async (c) => {
  const username = c.req.param('username');
  const currentUser = c.get('user');

  // Outside the cache on purpose: a 404 is one indexed lookup, and a new
  // signup should not have to wait out a TTL to exist.
  const user = await fetchProfileUser(username);

  if (!user) {
    return c.html(
      <Layout
        title={`@${username} - Not Found - clawd.gg`}
        description={`@${username} hasn't joined clawd.gg yet.`}
        user={currentUser}
      >
        <ProfileNotFound username={username} />
      </Layout>,
      404
    );
  }

  // `?as=visitor` lets the owner read their own page as everyone else does.
  // It is a view, not a permission: the payload for it is the public one, so
  // the preview cannot accidentally show something the toggles have hidden.
  const asVisitor = c.req.query('as') === 'visitor';
  const isOwner = currentUser?.githubUsername === user.githubUsername && !asVisitor;

  let payload: ProfilePayload;
  try {
    payload = await pageCache.remember(
      `${user.githubUsername}|${isOwner ? 'own' : 'public'}`,
      () => buildPayload(user, isOwner),
      (built) => built.complete
    );
  } catch (error) {
    console.error(`[profile] ${username}:`, error);
    return c.html(
      <Layout title={`@${username} - clawd.gg`} user={currentUser}>
        <ProfileNotFound username={username} />
      </Layout>,
      503
    );
  }

  // The owner's live panels, never cached — see fetchToday.
  const [today, pipeline] = isOwner
    ? await Promise.all([
        fetchToday(user.id, user.timezone).catch(() => null),
        fetchPipeline(user.id).catch(() => null),
      ])
    : [null, null];

  const islands: Island[] = ['copy-share'];
  if (payload.year) islands.push('contribution-tooltip');
  if (payload.curve) islands.push('profile-curve');
  if (isOwner) islands.push('profile-visibility');

  const appUrl = process.env.APP_URL || 'https://clawd.gg';
  const shareUrl = `${appUrl}/u/${user.githubUsername}`;
  // Always the PUBLIC summary, even on the owner's own page: a <meta> tag is
  // read by crawlers and link unfurlers, and whoever the browser belongs to is
  // not who sees it next.
  const summary = summarise(payload.fingerprint, payload.visibility);

  return c.html(
    <Layout
      title={`@${user.githubUsername} - clawd.gg`}
      description={summary}
      user={currentUser}
      islands={islands}
      og={{
        title: `@${user.githubUsername} on clawd.gg`,
        description: summary,
        image: `${appUrl}/u/${user.githubUsername}/card.png`,
        url: shareUrl,
      }}
    >
      <ProfilePage
        fingerprint={payload.fingerprint}
        identity={{
          username: user.githubUsername,
          avatarUrl: user.avatarUrl,
          joinedOn: user.firstSessionDate,
          // Owner only: a zone name is location data. ?as=visitor drops it too,
          // which is what makes the preview an honest preview.
          timezone: isOwner ? user.timezone : null,
          timezoneAssumed: user.timezone === DEFAULT_TIMEZONE,
        }}
        year={payload.year}
        curve={payload.curve}
        owner={
          isOwner
            ? { visibility: payload.visibility, plan: payload.plan, today, pipeline }
            : null
        }
        publicPlan={isOwner ? null : payload.plan}
        shareUrl={shareUrl}
      />
    </Layout>
  );
});

/**
 * The one sentence a crawler, a link preview and the share card get.
 *
 * Takes `visibility` and not just the payload, and that is the whole point.
 * The OWNER's payload is deliberately unfiltered — they see their own hidden
 * sections — so a summary built from the payload alone would put a hidden
 * figure into a <meta> tag on the owner's page, and from there into whatever
 * they paste the link into. Every section here has to clear BOTH tests: it is
 * in this payload, and its owner has left it public.
 *
 * The old version of this page did not: it put "$X invested · rank #N of M"
 * into og:description unconditionally.
 */
export function summarise(data: FingerprintData, visibility: Visibility): string {
  const parts: string[] = [];
  const show = (section: keyof Visibility) => visibility[section];

  const name = show('class')
    ? className(data.class?.rhythm ?? null, data.class?.style ?? null)
    : null;
  if (name) parts.push(`${name.emoji} ${name.rhythm} ${name.style}`.replace(/\s+/g, ' ').trim());

  if (show('value') && data.value) {
    parts.push(`${money(data.value.allTime)} of API-equivalent value`);
  }
  if (show('anatomy') && data.anatomy && data.anatomy.allTime.prompts > 0) {
    parts.push(`${group(data.anatomy.allTime.prompts)} prompts`);
  }
  if (show('ultrathink') && data.ultrathink && data.ultrathink.count > 0) {
    parts.push(`🌈 ${group(data.ultrathink.count)} ultrathinks`);
  }

  return parts.length > 0
    ? `@${data.username} on clawd.gg · ${parts.join(' · ')}`
    : `@${data.username} on clawd.gg`;
}

export default app;
