/**
 * ClickHouse is the single source for every number the site shows.
 *
 * This is the guard that keeps it that way. Every total, rank and chart on
 * every surface used to be assembled from TWO stores — ClickHouse for OTEL
 * users and SQLite `daily_stats` / `users.legacy_total_*` for everyone else,
 * stitched together at display time — and the stitching is where the data
 * drifted: the same user's prompt count differed between the homepage and
 * their profile, the OTEL setup day was counted twice in the chart, and
 * re-running `clawdgg setup` re-snapshotted the legacy totals on top of
 * figures that already included them.
 *
 * The pre-OTEL history is ClickHouse rows now
 * (docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts), so a
 * reintroduced read of either store does not just add a second code path — it
 * DOUBLE COUNTS. A grep is a blunt test, but this is a property of the whole
 * read layer rather than of any one function, and nothing else would notice
 * the regression until the numbers were already wrong in public.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

/** Every file that serves a displayed number. */
const READ_PATHS = [
  'routes/api.ts',
  'routes/index.tsx',
  'routes/profile.tsx',
  'jobs/sync-clickhouse.ts',
  'db/clickhouse.ts',
  'lib/chart-buckets.ts',
];

function sourceOf(relPath: string): string {
  return readFileSync(join(SRC, relPath), 'utf8');
}

/** Code lines only — the comments in these files explain what was removed. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .filter(line => {
      const t = line.trimStart();
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

describe('no read path touches SQLite daily_stats', () => {
  it.each(READ_PATHS)('%s does not reference the dailyStats table', relPath => {
    const offenders = codeLines(sourceOf(relPath)).filter(line => line.includes('dailyStats'));
    expect(offenders).toEqual([]);
  });

  it.each(READ_PATHS)('%s does not query daily_stats in raw SQL', relPath => {
    const offenders = codeLines(sourceOf(relPath)).filter(line => line.includes('daily_stats'));
    expect(offenders).toEqual([]);
  });
});

describe('no read path adds the frozen users.legacy_total_* snapshot', () => {
  it.each(READ_PATHS)('%s does not reference a legacy total column', relPath => {
    const offenders = codeLines(sourceOf(relPath)).filter(
      line => line.includes('legacyTotal') || line.includes('legacy_total')
    );
    expect(offenders).toEqual([]);
  });

  it.each(READ_PATHS)('%s does not reference legacyHourCounts', relPath => {
    const offenders = codeLines(sourceOf(relPath)).filter(
      line => line.includes('legacyHourCounts') || line.includes('legacy_hour_counts')
    );
    expect(offenders).toEqual([]);
  });
});

describe('the legacy chart builders are gone, not merely unused', () => {
  it('clickhouse.ts exports neither getLegacyChartData nor mergeChartData', async () => {
    const mod = await import('./clickhouse');
    expect('getLegacyChartData' in mod).toBe(false);
    expect('mergeChartData' in mod).toBe(false);
  });

  it('no file imports them', () => {
    for (const relPath of READ_PATHS) {
      const source = sourceOf(relPath);
      expect(source).not.toContain('getLegacyChartData');
      expect(source.includes('mergeChartData(')).toBe(false);
    }
  });
});

describe('the retired CLI upload endpoint answers 410', () => {
  const api = sourceOf('routes/api.ts');

  it('does not insert into daily_stats any more', () => {
    expect(api).not.toContain('.insert(dailyStats)');
    expect(api).not.toContain('onConflictDoUpdate');
  });

  it('answers POST /api/stats with 410 Gone and an upgrade message', () => {
    expect(api).toContain("api.post('/stats'");
    expect(api).toContain('410');
    expect(api).toMatch(/Upgrade the CLI/i);
  });
});

describe('/api/otel/enable is idempotent', () => {
  const api = sourceOf('routes/api.ts');

  // Re-running `clawdgg setup` used to move otel_setup_date to today, which
  // re-classifies days OTEL already covers as pre-OTEL — the exact condition
  // under which the daily_stats import imports the same history twice.
  it('returns early when a setup date already exists', () => {
    expect(api).toContain('alreadyEnabled: true');
    expect(api).toMatch(/if \(existing\?\.otelSetupAt \|\| existing\?\.otelSetupDate\)/);
  });

  it('never writes a legacy snapshot', () => {
    const enableBlock = api.slice(
      api.indexOf("api.post('/otel/enable'"),
      api.indexOf("api.post('/otel/disable'")
    );
    expect(enableBlock).not.toContain('legacyTotal');
    expect(enableBlock).not.toContain('legacyHourCounts');
  });
});

describe('legacy rows are excluded where their shape is fabricated', () => {
  const clickhouse = sourceOf('db/clickhouse.ts');

  it('defines the exclusion once', () => {
    expect(clickhouse).toContain(`export const NO_LEGACY_SQL = \`provenance != 'legacy'\``);
  });

  // Every imported row sits at 12:00 UTC with tool_success = 1 and no
  // session_id, so a query that reads the SHAPE of a day has to leave them out
  // or it reports a noon spike and a 100% tool success rate nobody lived.
  it.each([
    ['getUserHourlyActivity', 'hour-of-day'],
    ['getActivityHeatmap', 'heatmap'],
    ['getUserToolBreakdown', 'tool success rate'],
    ['getUserAgenticStats', 'api-calls-per-prompt'],
  ])('%s excludes legacy rows (%s)', fnName => {
    const start = clickhouse.indexOf(`export async function ${fnName}(`);
    expect(start).toBeGreaterThan(-1);
    const body = clickhouse.slice(start, clickhouse.indexOf('\n}\n', start));
    expect(body).toContain('${NO_LEGACY_SQL}');
  });

  it('excludes modelless rows from the cache-savings estimate', () => {
    const start = clickhouse.indexOf('export async function getUserCacheStats(');
    const body = clickhouse.slice(start, clickhouse.indexOf('\n}\n', start));
    expect(body).toContain("AND model != ''");
  });

  it('counts sessions from the session.count metric, not uniqExact(session_id)', () => {
    const start = clickhouse.indexOf('export async function getUserDailyMetrics(');
    const body = clickhouse.slice(start, clickhouse.indexOf('\n}\n', start));
    expect(body).toContain("sumIf(value, metric_name = 'claude_code.session.count') as sessions");
    expect(body).not.toContain('uniqExact(session_id)');
  });

  it('averages prompt length only over prompts that have one', () => {
    // Imported prompts carry length 0; including them drags the average down.
    expect(clickhouse).toContain('total_measured_prompts');
    expect(clickhouse).not.toContain(
      'sumIf(prompt_length, ${PROMPT_EVENT_SQL}) as total_prompt_chars'
    );
  });
});

/**
 * A UTC hour is not an hour anyone worked. Read in UTC, a Berlin user's 23:00
 * peak reads as 21:00 and an Auckland user's Monday morning falls in the
 * previous week — the figure is not approximate, it is in the wrong bucket. So
 * every read of an hour, a weekday or a week boundary converts with the user's
 * own zone, and the conversion is defined in exactly one place.
 */
describe('hour-of-day and weekday reads use the user\'s own clock', () => {
  const clickhouse = sourceOf('db/clickhouse.ts');

  it('defines the conversion once', () => {
    expect(clickhouse).toContain(
      'export const LOCAL_TS_SQL = `toTimeZone(timestamp, {tz:String})`'
    );
  });

  it.each(['db/clickhouse.ts', 'jobs/sync-clickhouse.ts'])(
    '%s never buckets a bare UTC timestamp by hour or weekday',
    relPath => {
      const offenders = codeLines(sourceOf(relPath)).filter(
        line => /\btoHour\(timestamp\)|\btoDayOfWeek\(timestamp\)/.test(line)
      );
      expect(offenders).toEqual([]);
    }
  );
});

describe('one prompt predicate everywhere', () => {
  it.each(['db/clickhouse.ts', 'jobs/sync-clickhouse.ts'])(
    '%s never checks the user_prompt event name by hand',
    relPath => {
      const offenders = codeLines(sourceOf(relPath)).filter(
        line =>
          line.includes("'claude_code.user_prompt'") &&
          !line.includes('export const PROMPT_EVENT_SQL') &&
          !line.includes("event_name = 'claude_code.user_prompt' AND command_source != 'builtin'")
      );
      expect(offenders).toEqual([]);
    }
  );
});
