#!/usr/bin/env bun
/**
 * Local development fixtures: a handful of users with usage behind them.
 *
 * WHAT CHANGED, AND WHY IT HAD TO. This used to write SQLite `daily_stats` and
 * nothing else. Every read of that table is gone — ClickHouse is the single
 * source for every number the site shows — so `bun run db:seed` produced users
 * whose profiles and leaderboard rows were entirely empty, which looks exactly
 * like a broken checkout. The fixture now goes where the reads are.
 *
 * Rows go in through insertEvents / insertMetrics, the same writers OTLP
 * ingest and the JSONL backfill use, so a seeded row carries a real `row_id`
 * and behaves like a real one on merge. `provenance` is 'backfill': it is
 * reconstructed data, it is not a live measurement, and the read paths that
 * exclude estimates already know what to do with it.
 *
 *   bun run db:seed              # ~6 users, 30 days each
 *   bun run db:seed -- --days 7  # smaller
 *
 * It DELETES the users and the raw rows it owns first, so it is re-runnable.
 * It refuses to run against anything but a local ClickHouse unless
 * SEED_FORCE=1 — the point of a fixture is that it is not production.
 *
 * Afterwards run the sync job (or POST /api/admin/sync) to fill users.total_*,
 * which is what the all-time leaderboard reads.
 */

import { eq } from 'drizzle-orm';
import { db } from './index';
import { users } from './schema';
import { computeCostUsd } from '../lib/session-import';
import {
  insertEvents,
  insertMetrics,
  query,
  type EventRow,
  type MetricRow,
} from './clickhouse';

const SEED_PROVENANCE = 'backfill' as const;

/** Fixture accounts. The id shape is production's — `github_<numeric id>`. */
const PEOPLE = [
  { githubId: '1234567', username: 'claude_master', name: 'Claude Master', weight: 1.0, timezone: 'Europe/Paris' },
  { githubId: '2345678', username: 'code_wizard', name: 'Code Wizard', weight: 0.7, timezone: 'America/New_York' },
  { githubId: '3456789', username: 'dev_ops_pro', name: 'DevOps Pro', weight: 0.5, timezone: 'UTC' },
  { githubId: '4567890', username: 'night_shipper', name: 'Night Shipper', weight: 0.35, timezone: 'Pacific/Auckland' },
  { githubId: '8901234', username: 'frontend_guru', name: 'Frontend Guru', weight: 0.2, timezone: 'Asia/Tokyo' },
  { githubId: '9012345', username: 'quiet_tinkerer', name: 'Quiet Tinkerer', weight: 0.05, timezone: 'Europe/Lisbon' },
];

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(items: readonly T[]): T {
  return items[randomInt(0, items.length - 1)]!;
}

/** 'YYYY-MM-DD HH:MM:SS.sss' in UTC, which is what the raw tables hold. */
function stamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * One user's day: a few prompts, each with api_requests and tool results.
 *
 * Deliberately shaped like real traffic rather than like round numbers — cache
 * reads dominate the token counts (about 95% of them do in practice), so a
 * fixture built on equal token types would make every cache figure on the site
 * look broken.
 */
function seedDay(userId: string, day: Date, weight: number): { events: EventRow[]; metrics: MetricRow[] } {
  const events: EventRow[] = [];
  const metrics: MetricRow[] = [];

  const prompts = Math.max(1, Math.round(randomInt(4, 60) * weight));
  const session = `seed-${userId}-${day.toISOString().slice(0, 10)}`;

  for (let i = 0; i < prompts; i++) {
    // Working hours with a tail, so the hour-of-day ring has a shape.
    const at = new Date(day);
    at.setUTCHours(randomInt(8, 23), randomInt(0, 59), randomInt(0, 59), randomInt(0, 999));

    events.push({
      timestamp: stamp(at),
      user_id: userId,
      session_id: session,
      event_name: 'claude_code.user_prompt',
      prompt_length: randomInt(40, 2400),
      provenance: SEED_PROVENANCE,
    });

    for (let call = 0; call < randomInt(1, 6); call++) {
      const toolAt = new Date(at.getTime() + (call + 1) * randomInt(500, 9000));
      events.push({
        timestamp: stamp(toolAt),
        user_id: userId,
        session_id: session,
        event_name: 'claude_code.tool_result',
        tool_name: pick(['Bash', 'Edit', 'Read', 'Grep', 'Write']),
        tool_use_id: `seed-${userId}-${at.getTime()}-${call}`,
        tool_success: Math.random() < 0.94 ? 1 : 0,
        provenance: SEED_PROVENANCE,
      });

      const model = pick(MODELS);
      const input = randomInt(200, 4000);
      const output = randomInt(100, 3000);
      const cacheRead = randomInt(20_000, 400_000);
      const cacheWrite = randomInt(0, 20_000);
      const { costUsd, pricingSource } = computeCostUsd(model, {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      });

      events.push({
        timestamp: stamp(toolAt),
        user_id: userId,
        session_id: session,
        event_name: 'claude_code.api_request',
        model,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        cost_usd: costUsd,
        pricing_source: pricingSource,
        query_source: Math.random() < 0.3 ? 'subagent' : 'main',
        provenance: SEED_PROVENANCE,
      });

      // One metric row per token type, as the exporter emits them — and as the
      // v2 sorting key keeps them: same timestamp, different token_type.
      for (const [tokenType, value] of [
        ['input', input],
        ['output', output],
        ['cacheRead', cacheRead],
        ['cacheCreation', cacheWrite],
      ] as const) {
        if (value <= 0) continue;
        metrics.push({
          timestamp: stamp(toolAt),
          user_id: userId,
          session_id: session,
          metric_name: 'claude_code.token.usage',
          value,
          model,
          token_type: tokenType,
          provenance: SEED_PROVENANCE,
        });
      }
      metrics.push({
        timestamp: stamp(toolAt),
        user_id: userId,
        session_id: session,
        metric_name: 'claude_code.cost.usage',
        value: costUsd,
        model,
        pricing_source: pricingSource,
        provenance: SEED_PROVENANCE,
      });
    }
  }

  // Per-day rollups the profile and the boards read.
  const noon = new Date(day);
  noon.setUTCHours(12, 0, 0, 0);
  for (const [metric, lineType, value] of [
    ['claude_code.lines_of_code.count', 'added', Math.round(randomInt(80, 2500) * weight)],
    ['claude_code.lines_of_code.count', 'removed', Math.round(randomInt(20, 900) * weight)],
    ['claude_code.commit.count', '', Math.max(0, Math.round(randomInt(0, 9) * weight))],
    ['claude_code.session.count', '', Math.max(1, Math.round(randomInt(1, 6) * weight))],
    ['claude_code.active_time.total', '', Math.round(randomInt(600, 21_600) * weight)],
  ] as const) {
    if (value <= 0) continue;
    metrics.push({
      timestamp: stamp(noon),
      user_id: userId,
      session_id: '',
      metric_name: metric,
      value,
      line_type: lineType,
      provenance: SEED_PROVENANCE,
    });
  }

  return { events, metrics };
}

/** A fixture must not be able to run against production. */
async function assertLocal(): Promise<void> {
  if (process.env.SEED_FORCE === '1') {
    console.warn('SEED_FORCE=1 — skipping the local-only check. Be sure.');
    return;
  }
  const url = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|clickhouse)(:|\/|$)/.test(url)) {
    throw new Error(
      `REFUSING: CLICKHOUSE_URL is ${url}, which is not local. ` +
        'Set SEED_FORCE=1 if you really mean it.'
    );
  }
}

async function seed(): Promise<void> {
  const args = process.argv.slice(2);
  const daysIndex = args.indexOf('--days');
  const days = daysIndex >= 0 ? Math.max(1, Number(args[daysIndex + 1]) || 30) : 30;

  await assertLocal();

  const ids = PEOPLE.map((person) => `github_${person.githubId}`);
  const idList = ids.map((id) => `'${id}'`).join(', ');

  console.log(`Clearing the ${ids.length} fixture users and their rows…`);
  // Re-runnable: only the fixture's own user ids, and the mutation is awaited
  // (mutations_sync = 2) so the insert below cannot race the delete.
  for (const table of ['events_raw', 'metrics_raw'] as const) {
    await query(
      `ALTER TABLE ${table} DELETE WHERE user_id IN (${idList}) SETTINGS mutations_sync = 2`,
      undefined,
      { timeoutMs: 5 * 60 * 1000 }
    );
  }
  for (const id of ids) {
    await db.delete(users).where(eq(users.id, id));
  }

  console.log(`Inserting ${PEOPLE.length} users…`);
  await db.insert(users).values(
    PEOPLE.map((person, index) => ({
      id: `github_${person.githubId}`,
      githubId: person.githubId,
      githubUsername: person.username,
      displayName: person.name,
      avatarUrl: `https://avatars.githubusercontent.com/u/${person.githubId}`,
      timezone: person.timezone,
      firstSessionDate: new Date(Date.now() - (days + index) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      createdAt: new Date(Date.now() - (days + index) * 86_400_000),
      updatedAt: new Date(),
    }))
  );

  let eventCount = 0;
  let metricCount = 0;

  for (const person of PEOPLE) {
    const userId = `github_${person.githubId}`;
    const events: EventRow[] = [];
    const metrics: MetricRow[] = [];

    for (let back = 0; back < days; back++) {
      // Not every day: a fixture with no gaps makes every streak figure max out.
      if (Math.random() > 0.35 + person.weight * 0.5) continue;
      const day = new Date(Date.now() - back * 86_400_000);
      day.setUTCHours(0, 0, 0, 0);
      const generated = seedDay(userId, day, person.weight);
      events.push(...generated.events);
      metrics.push(...generated.metrics);
    }

    for (let i = 0; i < events.length; i += 5000) await insertEvents(events.slice(i, i + 5000));
    for (let i = 0; i < metrics.length; i += 5000) await insertMetrics(metrics.slice(i, i + 5000));
    eventCount += events.length;
    metricCount += metrics.length;
    console.log(`  ${person.username}: ${events.length} events, ${metrics.length} metrics`);
  }

  console.log(`\nSeeded ${eventCount} events and ${metricCount} metric rows.`);
  console.log(
    'users.total_* is a CACHE of those rows and is still empty — run the sync ' +
      'job (or POST /api/admin/sync) before reading the all-time leaderboard.'
  );
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
