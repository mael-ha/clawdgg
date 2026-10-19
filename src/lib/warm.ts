/**
 * The profile warmer — rebuild the public surface before anyone asks for it.
 *
 * WHY THERE IS A JOB AND NOT JUST A LONGER TTL. The caches in src/routes/ now
 * serve a stale entry while they rebuild (src/lib/ttl-cache.ts), which takes
 * the 12.6 s off the reader but only once there is something to serve. The
 * first view of a profile after a restart, and every view of a profile nobody
 * has opened inside the stale window, still pays for the whole `... FINAL`
 * fan-out. For the share card that is not a slow page, it is a BROKEN UNFURL:
 * X's crawler fetches og:image once, with a timeout far under the 8.1 s a cold
 * card.png takes, and what it caches is the failure. The card has to be warm
 * before the link is posted, which means somebody has to build it who is not a
 * visitor.
 *
 * So: every five minutes, walk the users worth warming and rebuild what a
 * visitor and a crawler hit — the shared public fingerprint, the public page
 * payload, and the card (SVG and PNG). Through the same build functions and
 * the same cache keys the routes themselves use, which is the whole trick: a
 * warmed entry under a key the route does not read is a second cache
 * pretending to be the first.
 *
 * ONE USER AT A TIME. Not Promise.all over users. ClickHouse reads go through
 * a 4-permit semaphore (src/db/clickhouse.ts) that exists because ~30
 * concurrent FINAL reads OOM the server, and a background job is exactly the
 * thing that must not be holding all four permits while somebody is waiting
 * for a page. Sequential, the warmer is one user's fan-out deep at any moment
 * and competes with readers on equal terms.
 *
 * A CYCLE NEVER OVERLAPS ITSELF, and never aborts on one user. If the previous
 * cycle is still running the next tick is skipped — the same guard the sync
 * job uses, for the same reason. A user whose build throws is counted and the
 * walk continues: one broken profile must not stop the other hundred being
 * warmed, and the throw was never going to be cached anyway.
 *
 * CHEAP TO TURN OFF: `WARM_PROFILES=0` and nothing is scheduled. This job's
 * whole value is a latency improvement, so it must be possible to take out of
 * the picture without a deploy that changes anything else.
 *
 * It warms the PUBLIC view only. An owner's payload carries the sections they
 * have hidden, and nothing but their own request should ever build one.
 */

import { desc, sql } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { fetchProfileUser } from './profile-data';
import { hiddenFor } from './profile-settings';
import { refreshPublicFingerprint } from './public-fingerprint';
import { warmProfilePayload } from '../routes/profile';
import { warmCard } from '../routes/og';

const INTERVAL_MS = 5 * 60_000;

/**
 * Half a minute after boot, not immediately. A fresh process is answering its
 * first requests and running the sync job's first pass; the warmer is the one
 * thing here with no deadline, so it goes last.
 */
const FIRST_RUN_DELAY_MS = 30_000;

/**
 * How many users one cycle will walk.
 *
 * A ceiling, not a target. One user is one ClickHouse fan-out (see warmUser)
 * plus a rasterisation, so a cycle is still minutes rather than seconds for a
 * heavy list and the overlap guard will skip ticks. The cap is what keeps "we
 * signed up 500 users" from turning this into a job that never finishes.
 */
const MAX_USERS = 100;

let timer: ReturnType<typeof setInterval> | null = null;
let isWarming = false;

export interface WarmReport {
  /** Users the cycle set out to warm. */
  users: number;
  warmed: number;
  failed: number;
  ms: number;
}

export interface WarmOptions {
  /** Who to warm. Defaults to the SQLite read below. */
  listUsers?: () => Promise<string[]>;
  /** What warming one user means. Defaults to warmUser. */
  warmUser?: (username: string) => Promise<void>;
  log?: (line: string) => void;
}

/** `WARM_PROFILES=0` and the job is not scheduled at all. */
export function warmingEnabled(): boolean {
  return process.env.WARM_PROFILES !== '0';
}

/**
 * Who to warm, cheaply.
 *
 * SQLite only. Nothing here reads ClickHouse, and nothing here has a FINAL in
 * it: `users` already carries the totals the sync job writes every five
 * minutes, so "has any data" is a scan over a few hundred rows.
 *
 * THE ORDER IS THE HONEST PART. There is no "active in the last 30 days"
 * column to filter on — `users.updated_at` is touched for EVERY user on every
 * sync pass, so it says nothing about activity — so recency is not a filter
 * here, it is the SORT: users with a live streak first (which the sync job
 * computes from ClickHouse days, so it means active today or yesterday), then
 * by spend, cut at MAX_USERS. A cycle that cannot get through the whole list
 * therefore warms the profiles that are actually being looked at, and the tail
 * falls back to paying for its own first view — which is what happens today
 * for everyone.
 */
async function usersToWarm(): Promise<string[]> {
  const rows = await db
    .select({ username: users.githubUsername })
    .from(users)
    .where(sql`(COALESCE(${users.totalPrompts}, 0) > 0 OR COALESCE(${users.totalTokens}, 0) > 0)`)
    .orderBy(
      sql`CASE WHEN COALESCE(${users.currentStreak}, 0) > 0 THEN 0 ELSE 1 END`,
      desc(users.totalCostCents)
    )
    .limit(MAX_USERS);

  return rows.map((row) => row.username);
}

/**
 * Everything a visitor and a crawler hit, for one user — and ONE fan-out.
 *
 * The ORDER is the point. The public fingerprint goes first and is the only
 * ClickHouse fan-out in here: the page payload and the card are both built
 * from it (src/lib/public-fingerprint.ts), so by the time they are warmed they
 * find it fresh and cost only what is their own — the year, the curve and the
 * plan for the page, the rasterisation for the card. The fingerprint endpoint
 * needs no warming of its own at all any more; it reads that same entry.
 *
 * Sequentially, for the reason the users are sequential: concurrent fan-outs
 * are concurrent pressure on a 4-permit limiter that readers also need.
 */
async function warmUser(username: string): Promise<void> {
  const user = await fetchProfileUser(username);
  if (!user) return;

  await refreshPublicFingerprint(user, await hiddenFor(user.id));
  await warmProfilePayload(user);
  await warmCard(username);
}

/**
 * One pass. Returns null if a previous pass is still running.
 *
 * Exported so the tests can drive a cycle without a timer, and so a cycle can
 * be triggered by hand from a REPL.
 */
export async function warmCycle(options: WarmOptions = {}): Promise<WarmReport | null> {
  if (isWarming) return null;
  isWarming = true;

  const log = options.log ?? ((line: string) => console.log(line));
  const started = Date.now();
  let warmed = 0;
  let failed = 0;
  let list: string[] = [];

  try {
    list = await (options.listUsers ?? usersToWarm)();
    const one = options.warmUser ?? warmUser;

    for (const username of list) {
      try {
        await one(username);
        warmed++;
      } catch (error) {
        failed++;
        console.error(`[warm] ${username}:`, error);
      }
    }
  } catch (error) {
    // The user list itself failed. Nothing was warmed; the next tick retries.
    console.error('[warm] could not list users:', error);
  } finally {
    isWarming = false;
  }

  const report: WarmReport = { users: list.length, warmed, failed, ms: Date.now() - started };
  log(
    `[warm] cycle: ${report.warmed}/${report.users} warmed, ${report.failed} failed, ${report.ms}ms` +
      (report.users > 0 ? ` (${Math.round(report.ms / report.users)}ms/user)` : '')
  );
  return report;
}

/** Schedules the cycle. Returns false when WARM_PROFILES=0. */
export function startWarmJob(): boolean {
  if (!warmingEnabled()) {
    console.log('[warm] WARM_PROFILES=0 — profile warming disabled');
    return false;
  }
  if (timer) return true;

  console.log(
    `[warm] warming up to ${MAX_USERS} profiles every ${INTERVAL_MS / 60_000}min, first pass in ${FIRST_RUN_DELAY_MS / 1000}s`
  );

  timer = setInterval(() => {
    void warmCycle();
  }, INTERVAL_MS);

  // The first pass is early, so a restart does not leave every profile cold
  // for five minutes. It reads `timer` rather than holding its own handle: a
  // stop inside the first half-minute leaves this timeout to fire and do
  // nothing, which is cheaper than a second handle to track and clear.
  setTimeout(() => {
    if (timer) void warmCycle();
  }, FIRST_RUN_DELAY_MS);

  return true;
}

export function stopWarmJob(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log('[warm] stopped');
}
