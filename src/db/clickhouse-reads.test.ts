/**
 * EVERY ClickHouse read, actually executed, against the engine prod runs.
 *
 * WHY THIS EXISTS. The profile's year graph was broken on prod from the day it
 * shipped: its metrics query named an alias after the column it summed
 * (`sumIf(value, …) AS value`), which ClickHouse 24.3 with the analyzer on
 * answers with Code 184, ILLEGAL_AGGREGATION — every time, for every user. The
 * whole suite was green throughout, because nothing in it sent a single one of
 * these queries to a ClickHouse. A SQL string is not tested by being type
 * checked; the DATABASE is the only authority on whether it parses.
 *
 * So this is a different kind of test from the rest of the repo: it asserts
 * almost nothing about the NUMBERS (the unit tests own that) and everything
 * about the queries RESOLVING. One `it` per exported read, each one allowed to
 * fail only by throwing.
 *
 * HOW TO RUN IT. It needs a server, because src/db/clickhouse.ts speaks HTTP —
 * clickhouse-local, which the migration suites use, has no HTTP interface:
 *
 *   docker run -d --name ch-test -p 18123:8123 \
 *     clickhouse/clickhouse-server:24.3.18.7-alpine
 *   CLICKHOUSE_TEST_URL=http://localhost:18123 \
 *   CLICKHOUSE_URL=http://localhost:18123 \
 *   CLICKHOUSE_DATABASE=clawd_reads_test \
 *   DATABASE_PATH=/tmp/clawd-reads-test.db \
 *     bun test src/db/clickhouse-reads.test.ts
 *
 * Without CLICKHOUSE_TEST_URL the suite SKIPS rather than passing vacuously —
 * the same bargain as docker/clickhouse/migrations. CLICKHOUSE_URL has to be
 * exported as well, not just CLICKHOUSE_TEST_URL: src/db/clickhouse.ts reads it
 * once at import, and bun loads every test file into one process, so this file
 * cannot change it afterwards. The suite refuses to run rather than silently
 * reading some other server.
 *
 * The pinned 24.3.18.7 and the DEFAULT settings are both load-bearing. The
 * alias bug needs `allow_experimental_analyzer = 1` (24.3's default, and
 * prod's) and `prefer_column_name_to_alias = 0` to reproduce; on the old
 * analyzer the same SQL runs fine, which is how it got written.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const TEST_URL = process.env.CLICKHOUSE_TEST_URL;
const DEFAULT_DB_PATH = './data/clawd.db';

/** Rows land under these ids; every assertion below is about user A. */
const USER_A = 'github_ci_reads_a';
const USER_B = 'github_ci_reads_b';
const TZ_A = 'Europe/Paris';
const TZ_B = 'America/Los_Angeles';

const DAY_MS = 86_400_000;
/** Mid-afternoon UTC, so the day is the same date in both seeded zones. */
function at(daysAgo: number, hour: number, minute = 0): string {
  const base = new Date(Date.now() - daysAgo * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base.toISOString().replace('T', ' ').replace('Z', '');
}

/** The days the fixture covers: today, this week, last month, last autumn. */
const DAYS_AGO = [0, 1, 3, 40, 200];

async function ddl(sql: string, database?: string): Promise<void> {
  const url = new URL(TEST_URL!);
  if (database) url.searchParams.set('database', database);
  const response = await fetch(url.toString(), { method: 'POST', body: sql });
  if (!response.ok) throw new Error(`${sql.slice(0, 80)} → ${await response.text()}`);
}

/** The checked-in schema, which IS prod's: 01_schema.sql is the v2 tables. */
function schemaStatements(): string[] {
  const raw = readFileSync(join(import.meta.dir, '../../docker/clickhouse/init/01_schema.sql'), 'utf8');
  return raw
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/CREATE DATABASE[^;]*;/g, '')
    .replace(/USE clawd;/g, '')
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

const suite = TEST_URL ? describe : describe.skip;
if (!TEST_URL) {
  console.log(
    '[clickhouse-reads] no CLICKHOUSE_TEST_URL — SKIPPING the executed-read sweep. See the header of src/db/clickhouse-reads.test.ts'
  );
}

suite('every ClickHouse read resolves against 24.3', () => {
  let clickhouse: typeof import('./clickhouse');
  let profileData: typeof import('../lib/profile-data');
  let fingerprint: typeof import('../lib/fingerprint');
  let boards: typeof import('../lib/boards');
  let sync: typeof import('../jobs/sync-clickhouse');

  beforeAll(async () => {
    if (process.env.CLICKHOUSE_URL !== TEST_URL) {
      throw new Error(
        `export CLICKHOUSE_URL=${TEST_URL} too — src/db/clickhouse.ts reads it at import, so this suite cannot point itself at the test server`
      );
    }
    const database = process.env.CLICKHOUSE_DATABASE;
    if (!database || database === 'clawd') {
      throw new Error(
        'set CLICKHOUSE_DATABASE to a throwaway database (not `clawd`) — this suite truncates the tables it reads'
      );
    }
    if (!process.env.DATABASE_PATH || process.env.DATABASE_PATH === DEFAULT_DB_PATH) {
      throw new Error(
        'set DATABASE_PATH to a throwaway SQLite file — the board reads need users in it, and this suite writes two'
      );
    }

    await ddl(`CREATE DATABASE IF NOT EXISTS ${database}`);
    for (const statement of schemaStatements()) await ddl(statement, database);
    await ddl('TRUNCATE TABLE IF EXISTS metrics_raw', database);
    await ddl('TRUNCATE TABLE IF EXISTS events_raw', database);

    clickhouse = await import('./clickhouse');
    profileData = await import('../lib/profile-data');
    fingerprint = await import('../lib/fingerprint');
    boards = await import('../lib/boards');
    sync = await import('../jobs/sync-clickhouse');

    await seedClickHouse(clickhouse);
    await seedUsers();
    // The schema, ~300 inserted rows and a SQLite migration chain do not fit
    // in bun's 5s default.
  }, 120_000);

  // ─────────────────────────────────────────────────────────────────────────
  // The fixture
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Written through insertMetrics/insertEvents — the REAL insert path, so the
   * rows carry the row_id the sorting key dedups on and every `… FINAL` read
   * below sees what ingestion would have left.
   */
  async function seedClickHouse(ch: typeof import('./clickhouse')) {
    const events: import('./clickhouse').EventRow[] = [];
    const metrics: import('./clickhouse').MetricRow[] = [];

    for (const [index, userId] of [USER_A, USER_B].entries()) {
      for (const daysAgo of DAYS_AGO) {
        const session = `sess-${userId}-${daysAgo}`;
        // The oldest day is RECOVERED, which is the other half of every
        // provenance predicate (ESTIMATED_SQL, NO_LEGACY_SQL).
        const provenance = daysAgo === 200 ? 'backfill' : 'live';
        const hour = 14 + index;

        events.push(
          {
            timestamp: at(daysAgo, hour),
            user_id: userId,
            session_id: session,
            event_name: 'claude_code.user_prompt',
            prompt_length: 120 + index,
            provenance,
            terminal_type: 'ghostty',
            app_version: '2.1.117',
            message_uuid: `msg-${userId}-${daysAgo}-1`,
            event_sequence: 1,
          },
          {
            timestamp: at(daysAgo, hour, 5),
            user_id: userId,
            session_id: session,
            event_name: 'claude_code.user_prompt',
            prompt_length: 1_450,
            provenance,
            terminal_type: 'ghostty',
            app_version: '2.1.117',
            message_uuid: `msg-${userId}-${daysAgo}-2`,
            event_sequence: 2,
          },
          // A builtin slash command: a user_prompt that PROMPT_EVENT_SQL must
          // not count.
          {
            timestamp: at(daysAgo, hour, 7),
            user_id: userId,
            session_id: session,
            event_name: 'claude_code.user_prompt',
            prompt_length: 8,
            command_name: 'clear',
            command_source: 'builtin',
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 10),
            user_id: userId,
            session_id: session,
            event_name: 'claude_code.tool_result',
            tool_name: 'Bash',
            tool_success: 1,
            tool_duration_ms: 1_200,
            decision: 'accept',
            source: 'config',
            tool_source: 'builtin',
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 11),
            user_id: userId,
            session_id: session,
            event_name: 'claude_code.tool_result',
            tool_name: 'Edit',
            tool_success: 0,
            error_type: 'Error:ENOENT',
            error_message: 'no such file <path>',
            decision: 'reject',
            source: 'user_reject',
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 12),
            user_id: userId,
            session_id: session,
            event_name: 'clawdgg.ultrathink',
            provenance: daysAgo === 200 ? 'backfill' : 'hook',
          },
          {
            timestamp: at(daysAgo, hour, 15),
            user_id: userId,
            session_id: session,
            event_name: 'claude_code.api_request',
            model: 'claude-opus-4-5',
            cost_usd: 0.18,
            input_tokens: 4_200,
            output_tokens: 980,
            cache_read_tokens: 31_000,
            cache_write_tokens: 2_100,
            duration_ms: 4_300,
            status_code: 200,
            query_source: index === 0 ? 'main' : 'subagent',
            provenance,
          }
        );

        // The decorated spelling exists on purpose: MODEL_ID_SQL strips it, and
        // a query that groups on the alias `model` has to still see the column.
        for (const [model, querySource] of [
          ['claude-opus-4-5', 'main'],
          ['us.anthropic.claude-sonnet-4-5-v1:0[1m]', 'subagent'],
        ] as const) {
          metrics.push(
            {
              timestamp: at(daysAgo, hour, 20),
              user_id: userId,
              session_id: session,
              metric_name: 'claude_code.cost.usage',
              value: querySource === 'main' ? 0.42 : 0.07,
              model,
              query_source: querySource,
              speed: 'normal',
              effort: 'high',
              // getUserTerminalStats reads terminal_type off metrics_raw, not
              // events_raw — it has to be on both sides of the fixture.
              terminal_type: 'ghostty',
              app_version: '2.1.117',
              provenance,
              // A recovered row was PRICED from the table; a live one carries
              // Claude Code's own measured cost and consults none.
              pricing_source: daysAgo === 200 ? ('family' as const) : undefined,
            },
            {
              timestamp: at(daysAgo, hour, 20),
              user_id: userId,
              session_id: session,
              metric_name: 'claude_code.token.usage',
              value: 4_200,
              model,
              token_type: 'input',
              query_source: querySource,
              provenance,
            },
            {
              timestamp: at(daysAgo, hour, 20),
              user_id: userId,
              session_id: session,
              metric_name: 'claude_code.token.usage',
              value: 980,
              model,
              token_type: 'output',
              query_source: querySource,
              provenance,
            },
            {
              timestamp: at(daysAgo, hour, 20),
              user_id: userId,
              session_id: session,
              metric_name: 'claude_code.token.usage',
              value: 31_000,
              model,
              token_type: 'cacheRead',
              query_source: querySource,
              provenance,
            },
            {
              timestamp: at(daysAgo, hour, 20),
              user_id: userId,
              session_id: session,
              metric_name: 'claude_code.token.usage',
              value: 2_100,
              model,
              token_type: 'cacheCreation',
              query_source: querySource,
              provenance,
            }
          );
        }

        metrics.push(
          {
            timestamp: at(daysAgo, hour, 25),
            user_id: userId,
            session_id: session,
            metric_name: 'claude_code.lines_of_code.count',
            value: 240,
            line_type: 'added',
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 25),
            user_id: userId,
            session_id: session,
            metric_name: 'claude_code.lines_of_code.count',
            value: 65,
            line_type: 'removed',
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 30),
            user_id: userId,
            session_id: session,
            metric_name: 'claude_code.commit.count',
            value: 2,
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 31),
            user_id: userId,
            session_id: session,
            metric_name: 'claude_code.pull_request.count',
            value: 1,
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 32),
            user_id: userId,
            session_id: session,
            metric_name: 'claude_code.session.count',
            value: 1,
            start_type: 'fresh',
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 33),
            user_id: userId,
            session_id: session,
            metric_name: 'claude_code.active_time.total',
            value: 1_850,
            time_type: 'user',
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 35),
            user_id: userId,
            session_id: session,
            metric_name: 'claude_code.code_edit_tool.decision',
            value: 1,
            tool: 'Edit',
            decision: 'accept',
            language: 'TypeScript',
            source: 'config',
            provenance,
          },
          {
            timestamp: at(daysAgo, hour, 36),
            user_id: userId,
            session_id: session,
            metric_name: 'claude_code.code_edit_tool.decision',
            value: 1,
            tool: 'Write',
            decision: 'reject',
            language: 'Python',
            source: 'user_permanent',
            provenance,
          }
        );
      }
    }

    await ch.insertEvents(events);
    await ch.insertMetrics(metrics);
  }

  /**
   * The board reads join ClickHouse figures onto the SQLite user list, so the
   * throwaway database gets the real schema (drizzle's own migrator, the chain
   * scripts/check-migrations.ts proves) and two users.
   */
  async function seedUsers() {
    const { Database } = await import('bun:sqlite');
    const { drizzle } = await import('drizzle-orm/bun-sqlite');
    const { migrate } = await import('drizzle-orm/bun-sqlite/migrator');
    migrate(drizzle(new Database(process.env.DATABASE_PATH!, { create: true })), {
      migrationsFolder: join(import.meta.dir, '../../drizzle'),
    });

    const { db } = await import('./index');
    const { users } = await import('./schema');
    for (const [userId, username, timezone] of [
      [USER_A, 'ci-reads-a', TZ_A],
      [USER_B, 'ci-reads-b', TZ_B],
    ] as const) {
      await db
        .insert(users)
        .values({
          id: userId,
          githubId: userId,
          githubUsername: username,
          timezone,
          currentStreak: 3,
          longestStreak: 9,
          // What the sync job would have written: a board lists only users
          // whose synced totals say they have usage (LISTED in boards.ts).
          totalPrompts: 10,
        })
        .onConflictDoNothing();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Is this engine even able to see the bug?
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * A suite that cannot fail proves nothing, and this one only detects the
   * alias bug on an engine configured the way prod's is. So the settings are
   * asserted, and the PRE-FIX SQL is executed and required to fail: if a
   * future image or a default flips, this goes red here rather than going
   * quietly blind everywhere else.
   */
  describe('the engine under test', () => {
    it('runs the analyzer, like prod', async () => {
      const settings = await clickhouse.query<{ name: string; value: string }>(
        `SELECT name, value FROM system.settings
         WHERE name IN ('allow_experimental_analyzer', 'prefer_column_name_to_alias')`
      );
      const byName = new Map(settings.map(row => [row.name, row.value]));
      expect(byName.get('allow_experimental_analyzer')).toBe('1');
      expect(byName.get('prefer_column_name_to_alias')).toBe('0');
    });

    it('still rejects the alias that broke the year graph', async () => {
      // Verbatim the shape fetchYearSeries used to send: `AS value` over
      // metrics_raw.value, with a second sumIf reading `value`.
      const broken = clickhouse.query(
        `SELECT
           toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage')) AS value,
           toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count')) AS lines
         FROM metrics_raw FINAL
         WHERE user_id = {userId:String}`,
        { userId: USER_A }
      );
      expect(broken).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // src/db/clickhouse.ts — the leaderboard and dashboard reads
  // ─────────────────────────────────────────────────────────────────────────

  describe('src/db/clickhouse.ts', () => {
    it('healthCheck', async () => {
      expect(await clickhouse.healthCheck()).toBe(true);
    });

    it('probeTimezone', async () => {
      expect(await clickhouse.probeTimezone(TZ_A)).toBe(true);
      expect(await clickhouse.probeTimezone('Mars/Olympus')).toBe(false);
    });

    it('getUserTotals, for one user and for everyone', async () => {
      const one = await clickhouse.getUserTotals(USER_A);
      expect(one.length).toBe(1);
      // Two measured prompts a day on five days; the builtin /clear is not one.
      expect(Number(one[0]!.total_prompts)).toBe(10);
      expect(Number(one[0]!.total_lines_added)).toBe(1_200);

      const everyone = await clickhouse.getUserTotals();
      expect(everyone.length).toBeGreaterThanOrEqual(2);
    });

    it('getUserDailyMetrics', async () => {
      const rows = await clickhouse.getUserDailyMetrics(USER_A, 365);
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.every(row => typeof row.date === 'string')).toBe(true);
    });

    it('getUserActiveLocalDays', async () => {
      const days = await clickhouse.getUserActiveLocalDays(USER_A, TZ_A, 365);
      expect(days.length).toBeGreaterThanOrEqual(4);
    });

    it('getUserModelUsage', async () => {
      const all = await clickhouse.getUserModelUsage(USER_A);
      expect(all.length).toBeGreaterThan(0);
      // MODEL_ID_SQL folds `us.anthropic.…-v1:0[1m]` onto the plain id, so two
      // spellings of one model must not come back as two rows.
      expect(all.map(row => row.model)).toContain('claude-sonnet-4-5');
      await clickhouse.getUserModelUsage(USER_A, 30);
    });

    it('getUserHourlyActivity', async () => {
      const rows = await clickhouse.getUserHourlyActivity(USER_A, 90, TZ_A);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('getLeaderboard, every period and every sort', async () => {
      for (const period of ['today', 'week', 'month', 'all'] as const) {
        for (const sortBy of ['prompts', 'tokens', 'cost', 'lines'] as const) {
          const page = await clickhouse.getLeaderboard(period, sortBy, 10, 0);
          expect(Array.isArray(page.entries)).toBe(true);
          expect(typeof page.total).toBe('number');
        }
      }
    }, 120_000);

    it('getUserRank, every period and every sort', async () => {
      for (const period of ['today', 'week', 'month', 'all'] as const) {
        for (const sortBy of ['prompts', 'tokens', 'cost', 'lines'] as const) {
          const rank = await clickhouse.getUserRank(USER_A, period, sortBy);
          if (rank) expect(rank.rank).toBeGreaterThan(0);
        }
      }
    }, 120_000);

    it('getUserTodayMetrics', async () => {
      const today = await clickhouse.getUserTodayMetrics(USER_A);
      expect(today).not.toBeNull();
    });

    it('getUserTodayMetricsEnhanced', async () => {
      expect(await clickhouse.getUserTodayMetricsEnhanced(USER_A)).not.toBeNull();
    });

    it('getUserCacheStats', async () => {
      expect(await clickhouse.getUserCacheStats(USER_A)).not.toBeNull();
      await clickhouse.getUserCacheStats(USER_A, 30);
    });

    it('getUserToolBreakdown', async () => {
      const tools = await clickhouse.getUserToolBreakdown(USER_A, 365);
      expect(tools.map(row => row.toolName)).toContain('Bash');
    });

    it('getUserTotalToolCalls', async () => {
      expect(await clickhouse.getUserTotalToolCalls(USER_A)).toBeGreaterThan(0);
    });

    it('getActivityHeatmap', async () => {
      const cells = await clickhouse.getActivityHeatmap(USER_A, 365, TZ_A);
      expect(cells.length).toBeGreaterThan(0);
    });

    it('getUserVelocityTrend', async () => {
      const trend = await clickhouse.getUserVelocityTrend(USER_A, 365);
      expect(trend.length).toBeGreaterThan(0);
    });

    it('getUserSessionStats', async () => {
      expect(await clickhouse.getUserSessionStats(USER_A, 365)).not.toBeNull();
    });

    it('getUserLanguageStats', async () => {
      const languages = await clickhouse.getUserLanguageStats(USER_A);
      expect(languages.map(row => row.language)).toContain('TypeScript');
      await clickhouse.getUserLanguageStats(USER_A, 30);
    });

    it('getUserTrustStyle', async () => {
      expect(await clickhouse.getUserTrustStyle(USER_A)).not.toBeNull();
      await clickhouse.getUserTrustStyle(USER_A, 30);
    });

    it('getUserAgenticStats', async () => {
      expect(await clickhouse.getUserAgenticStats(USER_A)).not.toBeNull();
      await clickhouse.getUserAgenticStats(USER_A, 30);
    });

    it('getUserPromptLengthStats', async () => {
      expect(await clickhouse.getUserPromptLengthStats(USER_A)).not.toBeNull();
      await clickhouse.getUserPromptLengthStats(USER_A, 30);
    });

    it('getTodayLanguages', async () => {
      expect(Array.isArray(await clickhouse.getTodayLanguages(USER_A))).toBe(true);
    });

    it('getUserTerminalStats', async () => {
      const terminals = await clickhouse.getUserTerminalStats(USER_A);
      expect(terminals.map(row => row.terminalType)).toContain('ghostty');
    });

    it('getUserProvenanceBreakdown', async () => {
      const rows = await clickhouse.getUserProvenanceBreakdown(USER_A);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // src/lib/profile-data.ts — the profile's own reads
  // ─────────────────────────────────────────────────────────────────────────

  describe('src/lib/profile-data.ts', () => {
    it('fetchYearSeries — the query that was failing on prod', async () => {
      const year = await profileData.fetchYearSeries(USER_A, TZ_A);
      expect(year.length).toBeGreaterThanOrEqual(4);

      // The dollars are the half that threw: a green test here means the
      // metrics query resolved, not just the events one.
      const spent = year.reduce((sum, day) => sum + day.value, 0);
      expect(spent).toBeGreaterThan(0);
      const lines = year.reduce((sum, day) => sum + day.lines, 0);
      expect(lines).toBeGreaterThan(0);
      expect(year.some(day => day.ultrathinks > 0)).toBe(true);
    });

    it('fetchCurve, every metric × period × granularity', async () => {
      for (const metric of ['prompts', 'toolCalls', 'ultrathinks', 'value', 'lines'] as const) {
        for (const period of ['30d', '90d', '1y', 'all'] as const) {
          for (const groupBy of ['day', 'week', 'month'] as const) {
            const curve = await profileData.fetchCurve(USER_A, TZ_A, metric, period, groupBy);
            expect(curve.metric).toBe(metric);
            expect(Array.isArray(curve.points)).toBe(true);
          }
        }
      }
    }, 180_000);

    it('fetchToday — the same alias bug, on the never-cached panel', async () => {
      const today = await profileData.fetchToday(USER_A, TZ_A);
      expect(typeof today.prompts).toBe('number');
      expect(typeof today.value).toBe('number');
      expect(typeof today.lines).toBe('number');
    });

    it('fetchPipeline', async () => {
      const pipeline = await profileData.fetchPipeline(USER_A);
      expect(pipeline.lastLiveEventAt).not.toBeNull();
      expect(pipeline.ultrathinkHook).toBe(true);
      expect(pipeline.importedFrom).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // src/lib/fingerprint.ts — one fan-out, ~13 queries
  // ─────────────────────────────────────────────────────────────────────────

  describe('src/lib/fingerprint.ts', () => {
    it('getFingerprint', async () => {
      fingerprint.clearPeerCaches();
      const data = await fingerprint.getFingerprint(USER_A, {
        username: 'ci-reads-a',
        timezone: TZ_A,
        isOwner: true,
      });
      expect(data.sections.length).toBeGreaterThan(0);
      expect(data.anatomy?.allTime.prompts).toBe(10);
      expect(data.anatomy?.topTools.map(tool => tool.name)).toContain('Bash');
      expect(data.value?.allTime).toBeGreaterThan(0);
      expect(data.rings?.languages.length).toBeGreaterThan(0);
      expect(data.ultrathink?.count).toBeGreaterThan(0);
      expect(data.class).toBeTruthy();
    }, 60_000);

    it('getFingerprint, with every section hidden', async () => {
      fingerprint.clearPeerCaches();
      const data = await fingerprint.getFingerprint(USER_A, {
        username: 'ci-reads-a',
        timezone: TZ_A,
        hidden: [...fingerprint.FINGERPRINT_SECTIONS],
      });
      expect(data).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // src/lib/boards.ts — the home page
  // ─────────────────────────────────────────────────────────────────────────

  describe('src/lib/boards.ts', () => {
    it('getBoardPage, every board × scope', async () => {
      // Read off BOARDS rather than listed here, so a new board is swept the
      // moment it exists instead of the day somebody remembers this file.
      for (const board of boards.BOARD_KEYS) {
        for (const scope of boards.BOARDS[board].scopes) {
          const page = await boards.getBoardPage({
            board,
            scope,
            limit: 25,
            offset: 0,
            viewerId: USER_A,
          });
          expect(Array.isArray(page.rows)).toBe(true);
        }
      }
    }, 120_000);

    /**
     * The figures are cached per WINDOW, so once one tab of a window is built
     * every other board in it is served without asking ClickHouse anything —
     * not the figures, not the class evidence, not the pulse.
     */
    it('switches boards within a scope with no ClickHouse query at all', async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
        if (url.startsWith(TEST_URL!)) calls++;
        return original(input, init);
      }) as typeof fetch;
      try {
        boards.clearBoardCaches();
        const page = (board: import('../lib/boards').BoardKey, scope: import('../lib/boards').BoardScope) =>
          boards.getBoardPage({ board, scope, limit: 25, offset: 0, viewerId: null });

        await page('leverage', 'all');
        await boards.getGlobalPulse();
        expect(calls).toBeGreaterThan(0);

        calls = 0;
        await page('value', 'all');
        await page('tokens', 'all');
        await page('ultrathinks', 'all');
        // 🔥's two scopes are lifetime figures: the same 'all' window.
        await page('streak', 'current');
        await page('streak', 'best');
        await boards.getGlobalPulse();
        expect(calls).toBe(0);

        await page('leverage', 'week');
        calls = 0;
        await page('value', 'week');
        await page('tokens', 'week');
        await page('ultrathinks', 'week');
        expect(calls).toBe(0);
      } finally {
        globalThis.fetch = original;
      }
    }, 60_000);

    it('getGlobalPulse', async () => {
      const pulse = await boards.getGlobalPulse();
      expect(typeof pulse.devs).toBe('number');
      expect(typeof pulse.valueUsd).toBe('number');
      expect(typeof pulse.ultrathinks).toBe('number');
    });

    /**
     * ONE TOKEN COUNT, three readers, against real rows.
     *
     * src/db/clickhouse.test.ts asserts they share TOTAL_TOKENS_SQL by reading
     * the source; this asserts the three paths come back with the same NUMBER,
     * which is the claim that matters. They did not: getUserTotals summed
     * input + output (what users.total_tokens and /api/me reported) while the
     * rank query summed every type, about twenty times more.
     *
     * The fixture's per-prompt datapoints are 4,200 input + 980 output +
     * 31,000 cacheRead + 2,100 cacheCreation = 38,280, and the four per-type
     * columns have to add up to the total by construction.
     */
    it('reports the same token total through getUserTotals, the rank query and the 🪙 board', async () => {
      const totals = (await clickhouse.getUserTotals(USER_A))[0]!;
      const total = Number(totals.total_tokens);

      expect(total).toBe(
        Number(totals.total_input_tokens) +
          Number(totals.total_output_tokens) +
          Number(totals.total_cache_read_tokens) +
          Number(totals.total_cache_write_tokens)
      );
      expect(total).toBeGreaterThan(0);

      // The leaderboard's token sort reads the same figure for the same user.
      const { entries } = await clickhouse.getLeaderboard('all', 'tokens', 100, 0);
      const mine = entries.find(entry => entry.user_id === USER_A)!;
      expect(Number(mine.total_tokens)).toBe(total);

      // And the 🪙 board, which is what a reader compares to their own page.
      const page = await boards.getBoardPage({
        board: 'tokens',
        scope: 'all',
        limit: 100,
        offset: 0,
        viewerId: USER_A,
      });
      expect(page.rows.find(row => row.userId === USER_A)!.value).toBe(total);

      // The provenance breakdown's parts add up to it too — that is the
      // "traceable" half of the data-integrity rule.
      const parts = await clickhouse.getUserProvenanceBreakdown(USER_A);
      expect(parts.reduce((sum, part) => sum + Number(part.tokens), 0)).toBe(total);
    }, 120_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // src/jobs/sync-clickhouse.ts — both reads SWALLOW their errors, so a
  // broken query here is invisible in production. Hence the assertions on
  // the VALUES: an empty answer is what the catch returns.
  // ─────────────────────────────────────────────────────────────────────────

  describe('src/jobs/sync-clickhouse.ts', () => {
    it('getUserHourlyCounts', async () => {
      const counts = await sync.getUserHourlyCounts(USER_A, TZ_A);
      expect(Object.keys(counts).length).toBeGreaterThan(0);
    });

    it('getLongestSessionMessages', async () => {
      expect(await sync.getLongestSessionMessages(USER_A)).toBeGreaterThan(0);
    });

    it('fetchSyncWatermarks', async () => {
      const marks = await sync.fetchSyncWatermarks();
      // Seven events and fifteen metrics a day, on five days.
      expect(marks.get(USER_A)).toMatch(/^e=35:\d{4}-\d\d-\d\d [\d:.]+\|m=90:\d{4}-/);
      expect(marks.has(USER_B)).toBe(true);
      expect(await sync.fetchSyncWatermarks()).toEqual(marks);
    });
  });
  // ─────────────────────────────────────────────────────────────────────────
  // Identity at write time: the insert dedup token, and reads without FINAL
  // ─────────────────────────────────────────────────────────────────────────

  describe('insert deduplication', () => {
    const USER_DEDUP = 'github_ci_reads_dedup';

    async function countFor(table: 'events_raw' | 'metrics_raw'): Promise<number> {
      const rows = await clickhouse.query<{ n: number }>(
        `SELECT toUInt64(count()) AS n FROM ${table} WHERE user_id = {userId:String}`,
        { userId: USER_DEDUP }
      );
      return Number(rows[0]?.n) || 0;
    }

    /** Three months, so the batch is split into three parts — three blocks. */
    function batch(tag: string): import('./clickhouse').EventRow[] {
      return [0, 40, 80].map((daysAgo, index) => ({
        timestamp: at(daysAgo, 10),
        user_id: USER_DEDUP,
        session_id: `sess-dedup-${tag}`,
        event_name: 'claude_code.user_prompt',
        prompt_length: 100 + index,
        message_uuid: `msg-dedup-${tag}-${index}`,
        event_sequence: index,
      }));
    }

    it('keeps the window on both tables, as the schema declares', async () => {
      const rows = await clickhouse.query<{ name: string; create: string }>(
        `SELECT name, create_table_query AS create FROM system.tables
         WHERE database = currentDatabase() AND name IN ('events_raw', 'metrics_raw')`
      );
      expect(rows.length).toBe(2);
      for (const row of rows) expect(row.create).toContain('non_replicated_deduplication_window = 10000');
    });

    it('drops a retried batch and keeps a different one', async () => {
      const first = batch('a');
      await clickhouse.insertEvents(first);
      expect(await countFor('events_raw')).toBe(3);

      // The retry: the same rows again, in the same order — dropped whole,
      // across all three partitions.
      await clickhouse.insertEvents(batch('a'));
      expect(await countFor('events_raw')).toBe(3);

      // A retry of a counter that came back with a different VALUE is still
      // the same datapoint: the token is over the row ids, not the body.
      await clickhouse.insertEvents(batch('a').map(row => ({ ...row, prompt_length: 9_999 })));
      expect(await countFor('events_raw')).toBe(3);

      // Different rows, a different token: they land.
      await clickhouse.insertEvents(batch('b'));
      expect(await countFor('events_raw')).toBe(6);

      // The same per-table rule on metrics_raw.
      const metric: import('./clickhouse').MetricRow = {
        timestamp: at(0, 10),
        user_id: USER_DEDUP,
        session_id: 'sess-dedup-m',
        metric_name: 'claude_code.cost.usage',
        value: 0.5,
        model: 'claude-opus-4-5',
      };
      await clickhouse.insertMetrics([metric]);
      await clickhouse.insertMetrics([metric]);
      expect(await countFor('metrics_raw')).toBe(1);

      const duplicates = await clickhouse.query<{ dupes: number }>(
        `SELECT toUInt64(count() - uniqExact(row_id)) AS dupes FROM events_raw`
      );
      expect(Number(duplicates[0]!.dupes)).toBe(0);
    });
  });

  /**
   * THE NUMBERS DO NOT MOVE. With no duplicate in the table, a read without
   * FINAL must answer exactly what it answered with it. `final = 1` is the
   * server setting that applies FINAL to every table in a query, so the same
   * functions run twice, once each way, through a fetch that adds it.
   */
  describe('reads without FINAL', () => {
    async function withFinal<T>(read: () => Promise<T>): Promise<T> {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.origin === new URL(TEST_URL!).origin && !url.searchParams.has('query')) {
          url.searchParams.set('final', '1');
        }
        return original(url.toString(), init);
      }) as typeof fetch;
      try {
        return await read();
      } finally {
        globalThis.fetch = original;
      }
    }

    it('applies FINAL through the setting, so the comparison is real', async () => {
      // A cross-batch duplicate: same rows, a token of its own. Only FINAL —
      // or a merge — collapses it, which is what proves the setting reached
      // the server.
      const row = {
        timestamp: at(0, 11),
        user_id: 'github_ci_reads_final_probe',
        session_id: 'sess-final-probe',
        metric_name: 'claude_code.cost.usage',
        value: 1,
        row_id: 'final-probe-row',
      };
      await clickhouse.insert('metrics_raw', [row]);
      await clickhouse.insert('metrics_raw', [row, { ...row, row_id: 'final-probe-other', value: 0 }]);
      const sql = `SELECT toUInt64(count()) AS n FROM metrics_raw WHERE user_id = 'github_ci_reads_final_probe'`;
      expect(Number((await clickhouse.query<{ n: number }>(sql))[0]!.n)).toBe(3);
      expect(Number((await withFinal(() => clickhouse.query<{ n: number }>(sql)))[0]!.n)).toBe(2);
      await clickhouse.query(
        `ALTER TABLE metrics_raw DELETE WHERE user_id = 'github_ci_reads_final_probe' SETTINGS mutations_sync = 2`
      );
    });

    it('getUserTotals', async () => {
      const without = await clickhouse.getUserTotals();
      const withF = await withFinal(() => clickhouse.getUserTotals());
      expect(without.length).toBeGreaterThanOrEqual(2);
      const byUser = (rows: typeof without) =>
        [...rows].sort((a, b) => a.user_id.localeCompare(b.user_id));
      expect(byUser(without)).toEqual(byUser(withF));
    });

    it('getFingerprint', async () => {
      const read = () => {
        fingerprint.clearPeerCaches();
        return fingerprint.getFingerprint(USER_A, {
          username: 'ci-reads-a',
          timezone: TZ_A,
          isOwner: true,
        });
      };
      const without = await read();
      const withF = await withFinal(read);
      expect(without.anatomy?.allTime.prompts).toBe(10);
      // generatedAt is the clock at build time, the one field that is not data.
      const data = (fp: typeof without) => JSON.parse(JSON.stringify({ ...fp, generatedAt: null }));
      expect(data(without)).toEqual(data(withF));
    }, 60_000);

    it('getBoardPage, every board × scope, and getGlobalPulse', async () => {
      const read = async () => {
        boards.clearBoardCaches();
        const pages: unknown[] = [];
        for (const board of boards.BOARD_KEYS) {
          for (const scope of boards.BOARDS[board].scopes) {
            pages.push(await boards.getBoardPage({ board, scope, limit: 25, offset: 0, viewerId: USER_A }));
          }
        }
        pages.push(await boards.getGlobalPulse());
        return JSON.parse(JSON.stringify(pages));
      };
      const without = await read();
      const withF = await withFinal(read);
      expect(without).toEqual(withF);
    }, 120_000);

    it('the sync reads', async () => {
      const read = async () => [
        await sync.getUserHourlyCounts(USER_A, TZ_A),
        await sync.getLongestSessionMessages(USER_A),
        await clickhouse.getUserActiveLocalDays(USER_A, TZ_A, 365),
        await clickhouse.getUserTotalToolCalls(USER_A),
      ];
      expect(await read()).toEqual(await withFinal(read));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The board and the profile, one number each, in a DST zone and a
  // half-hour zone
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The board used to put each user on their local day by shifting every row
   * by their CURRENT UTC offset, so a row on the far side of a DST change sat
   * an hour off — and around midnight, on the wrong day. The fixture is built
   * to make that visible whatever today's offset is: a pair of rows a minute
   * either side of local midnight, in winter AND in summer, where the earlier
   * day has more flags than prompts. On the real local days each pair caps to
   * one ultrathink; shifted by the wrong hour both rows land on one day and
   * cap to two. And a run of 23:30 prompts straight through the March change,
   * which only counts as consecutive days in the real zone.
   */
  describe('board ↔ profile parity on local days', () => {
    const NY = 'github_ci_parity_ny';
    const KOL = 'github_ci_parity_kol';
    const ZONES = { [NY]: 'America/New_York', [KOL]: 'Asia/Kolkata' } as const;

    const utc = (iso: string) => iso.replace('T', ' ').replace('Z', '');
    const ago = (ms: number) => utc(new Date(Date.now() - ms).toISOString());
    let seq = 0;
    const prompt = (userId: string, timestamp: string): import('./clickhouse').EventRow => ({
      timestamp,
      user_id: userId,
      session_id: `parity-${userId}`,
      event_name: 'claude_code.user_prompt',
      prompt_length: 100,
      provenance: 'live',
      message_uuid: `parity-${userId}-${++seq}`,
    });
    const flag = (userId: string, timestamp: string): import('./clickhouse').EventRow => ({
      timestamp,
      user_id: userId,
      session_id: `parity-${userId}`,
      event_name: 'clawdgg.ultrathink',
      provenance: 'hook',
      message_uuid: `parity-${userId}-${++seq}`,
    });

    beforeAll(async () => {
      const events: import('./clickhouse').EventRow[] = [];

      // New York. Winter: Jan 15 23:30 EST is 04:30Z on the 16th.
      events.push(prompt(NY, '2026-01-16 04:30:00'), flag(NY, '2026-01-16 04:30:00'), flag(NY, '2026-01-16 04:30:00.001'));
      events.push(prompt(NY, '2026-01-16 05:30:00'));
      // Summer: Jul 10 00:30 EDT is 04:30Z; Jul 9 23:30 EDT is 03:30Z.
      events.push(prompt(NY, '2025-07-10 04:30:00'), flag(NY, '2025-07-10 04:30:00'), flag(NY, '2025-07-10 04:30:00.001'));
      events.push(prompt(NY, '2025-07-10 03:30:00'));
      // 23:30 local on Mar 5…11 2026, through the change on the 8th: 04:30Z
      // the next day while on EST, 03:30Z from the 8th on EDT.
      for (const day of [5, 6, 7]) events.push(prompt(NY, `2026-03-${String(day + 1).padStart(2, '0')} 04:30:00`));
      for (const day of [8, 9, 10, 11]) events.push(prompt(NY, `2026-03-${String(day + 1).padStart(2, '0')} 03:30:00`));

      // Kolkata, UTC+05:30. Feb 10 23:50 IST is 18:20Z; Feb 11 00:10 is 18:40Z.
      events.push(prompt(KOL, '2026-02-10 18:20:00'), flag(KOL, '2026-02-10 18:20:00'), flag(KOL, '2026-02-10 18:20:00.001'));
      events.push(prompt(KOL, '2026-02-10 18:40:00'));
      // 00:15 IST on Feb 2, 3 and 4: 18:45Z the day before.
      for (const day of ['01', '02', '03']) events.push(prompt(KOL, `2026-02-${day} 18:45:00`));

      // Both are on a current run: a prompt now and one a day ago.
      for (const userId of [NY, KOL]) {
        events.push(prompt(userId, ago(60_000)), prompt(userId, ago(86_400_000)));
      }

      await clickhouse.insertEvents(events);

      const { db } = await import('./index');
      const { users } = await import('./schema');
      for (const [userId, timezone] of Object.entries(ZONES)) {
        await db
          .insert(users)
          .values({
            id: userId,
            githubId: userId,
            githubUsername: userId.replace(/_/g, '-'),
            timezone,
            // Stale on purpose: the sync recomputes both from the days, and
            // a longest streak of 40 is a run these rows do not contain.
            currentStreak: 0,
            longestStreak: 40,
            totalPrompts: 10,
          })
          .onConflictDoNothing();
      }

      await sync.syncClickHouseToSqlite({ force: true });
      boards.clearBoardCaches();
    }, 120_000);

    const boardValue = async (
      board: import('../lib/boards').BoardKey,
      scope: import('../lib/boards').BoardScope,
      userId: string
    ) => {
      const page = await boards.getBoardPage({ board, scope, limit: 100, offset: 0, viewerId: null });
      return page.rows.find(row => row.userId === userId)?.value;
    };

    for (const [userId, expected] of [
      // Two capped pairs (1 each) — and nothing else carries a flag.
      [NY, { ultrathinks: 2, current: 2, best: 7 }],
      [KOL, { ultrathinks: 1, current: 2, best: 3 }],
    ] as const) {
      const timezone = ZONES[userId];

      it(`🌈 is the profile's count, in ${timezone}`, async () => {
        const data = await fingerprint.getFingerprint(userId, {
          username: userId,
          timezone,
          isOwner: true,
          hidden: [],
        });
        expect(data.ultrathink!.count).toBe(expected.ultrathinks);
        expect(await boardValue('ultrathinks', 'all', userId)).toBe(data.ultrathink!.count);
      });

      it(`🔥 is the profile's streak, in ${timezone}`, async () => {
        const user = (await profileData.fetchProfileUser(userId.replace(/_/g, '-')))!;
        expect(user.currentStreak).toBe(expected.current);
        // Recomputed from the days, so the stale 40 is gone.
        expect(user.longestStreak).toBe(expected.best);
        expect(await boardValue('streak', 'current', userId)).toBe(user.currentStreak);
        expect(await boardValue('streak', 'best', userId)).toBe(user.longestStreak);
      });
    }
  });
});
