/**
 * End-to-end run of the daily_stats import against a real SQLite fixture and a
 * stub ClickHouse, in a subprocess — the same way an operator runs it.
 *
 * The pure row-building is covered by 2026-10-18_import_daily_stats.test.ts.
 * What this file proves is the part that can only go wrong once the script
 * meets actual data:
 *
 *   - users with NO otel_setup_date are imported in full (they used to be
 *     skipped entirely, which left anyone who never ran `clawdgg setup` with a
 *     zeroed profile)
 *   - a user WITH a cutoff imports strictly before it
 *   - a (user, day) that ClickHouse already covers from another provenance is
 *     skipped and NAMED, because that is the double-count guard
 *   - a day that already has legacy rows is NOT skipped — identity is
 *     deterministic, so re-running is how a half-finished import is repaired
 *   - running --apply twice writes the same row_ids, so the second run is a
 *     no-op under ReplacingMergeTree rather than a doubling
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'clawdgg-import-e2e-'));
const DB_PATH = join(WORK, 'clawd.db');
const SCRIPT = join(import.meta.dir, '2026-10-18_import_daily_stats.ts');

/** Every INSERT body the script sent, by table. */
interface Capture {
  inserts: { table: string; rows: Record<string, any>[] }[];
}

let server: ReturnType<typeof Bun.serve>;
let capture: Capture;

/**
 * A stub ClickHouse. It answers the one SELECT the script makes (which days are
 * already covered by another provenance) and records every INSERT.
 */
function startStub(coveredRows: { user_id: string; date: string; provenances: string[] }[]) {
  capture = { inserts: [] };
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const queryParam = url.searchParams.get('query') ?? '';
      const body = await req.text();

      const insertMatch = queryParam.match(/INSERT INTO (\w+)/);
      if (insertMatch) {
        capture.inserts.push({
          table: insertMatch[1]!,
          rows: body.split('\n').filter(Boolean).map(line => JSON.parse(line)),
        });
        return new Response('', { status: 200 });
      }

      // A read. The only one the script issues is the covered-days roll-up.
      if (body.includes("provenance != 'legacy'")) {
        return new Response(coveredRows.map(r => JSON.stringify(r)).join('\n'), { status: 200 });
      }
      return new Response('', { status: 200 });
    },
  });
}

function seedSqlite() {
  const db = new Database(DB_PATH, { create: true });
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      github_username TEXT,
      otel_setup_date TEXT
    );
    CREATE TABLE daily_stats (
      user_id TEXT,
      date TEXT,
      prompt_count INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd_cents INTEGER DEFAULT 0,
      lines_written INTEGER DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      session_count INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
  `);

  // otel_user enabled OTEL on 2026-03-03, so 03-01 and 03-02 import and
  // 03-03 does not.
  db.run(`INSERT INTO users VALUES ('github_otel', 'otelperson', '2026-03-03')`);
  // never_setup has no cutoff at all — every day is pre-OTEL for them. This is
  // the user the previous version of the script dropped on the floor.
  db.run(`INSERT INTO users VALUES ('github_never', 'neverperson', NULL)`);
  // no_days has a user row but no daily_stats, and must not appear at all.
  db.run(`INSERT INTO users VALUES ('github_empty', 'emptyperson', NULL)`);

  const day = db.prepare(
    `INSERT INTO daily_stats
       (user_id, date, prompt_count, tool_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd_cents, lines_written,
        commit_count, session_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  day.run('github_otel', '2026-03-01', 4, 2, 100, 200, 300, 400, 150, 50, 1, 2);
  day.run('github_otel', '2026-03-02', 3, 1, 10, 20, 30, 40, 75, 25, 0, 1);
  day.run('github_otel', '2026-03-03', 9, 9, 999, 999, 999, 999, 999, 999, 9, 9);
  day.run('github_never', '2026-01-10', 2, 1, 5, 6, 7, 8, 20, 10, 1, 1);
  day.run('github_never', '2026-01-11', 5, 3, 50, 60, 70, 80, 200, 100, 2, 3);
  db.close();
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  inserts: Capture['inserts'];
}

/**
 * Async on purpose. Bun.spawnSync blocks this process's event loop, so the stub
 * server above could never answer the subprocess's request and both sides would
 * wait for each other forever.
 */
async function runScript(
  args: string[],
  covered: Parameters<typeof startStub>[0]
): Promise<RunResult> {
  const stub = startStub(covered);
  try {
    const proc = Bun.spawn({
      cmd: ['bun', SCRIPT, ...args],
      env: {
        ...process.env,
        DATABASE_PATH: DB_PATH,
        CLICKHOUSE_URL: `http://localhost:${stub.port}`,
        CLICKHOUSE_DATABASE: 'clawd',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, inserts: capture.inserts };
  } finally {
    stub.stop(true);
  }
}

beforeAll(() => {
  seedSqlite();
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('dry run', () => {
  const result = () => runScript([], []);

  it('exits cleanly and writes nothing', async () => {
    const r = await result();
    expect(r.exitCode).toBe(0);
    expect(r.inserts).toEqual([]);
    expect(r.stdout).toContain('DRY RUN');
    expect(r.stdout).toContain('Dry run — nothing written');
  });

  it('imports a user who never enabled OTEL, in full', async () => {
    const r = await result();
    expect(r.stdout).toContain('neverperson');
    expect(r.stdout).toContain('none — every day is pre-OTEL for this user');
    // 2 days, 2 + 5 prompts, 1 + 3 tool calls
    expect(r.stdout).toMatch(/neverperson[\s\S]*?days {13}2 to import, 0 skipped/);
    expect(r.stdout).toMatch(/neverperson[\s\S]*?prompts {10}7/);
    expect(r.stdout).toMatch(/neverperson[\s\S]*?tool calls {7}4/);
  });

  it('stops strictly before the cutoff for a user who has one', async () => {
    const r = await result();
    expect(r.stdout).toMatch(/otelperson[\s\S]*?cutoff {11}2026-03-03/);
    expect(r.stdout).toMatch(/otelperson[\s\S]*?range {12}2026-03-01 \.\. 2026-03-02/);
    // the 9s on 2026-03-03 belong to OTEL and must not be counted
    expect(r.stdout).toMatch(/otelperson[\s\S]*?prompts {10}7/);
  });

  it('leaves out a user with no daily_stats rows', async () => {
    expect((await result()).stdout).not.toContain('emptyperson');
  });

  it('skips and NAMES a day another provenance already covers', async () => {
    const r = await runScript([], [
      { user_id: 'github_never', date: '2026-01-11', provenances: ['backfill'] },
    ]);
    expect(r.stdout).toContain('SKIPPED (ClickHouse already has these days from another source)');
    expect(r.stdout).toContain('2026-01-11 (backfill)');
    expect(r.stdout).toMatch(/neverperson[\s\S]*?days {13}1 to import, 1 skipped/);
    // only the uncovered day's 2 prompts remain
    expect(r.stdout).toMatch(/neverperson[\s\S]*?prompts {10}2/);
  });

  it('does NOT skip a day that only has legacy rows', async () => {
    // Deterministic identity makes a re-insert a no-op, so a half-finished
    // import is repaired by running it again — skipping would freeze it.
    const r = await runScript([], [
      { user_id: 'github_never', date: '2026-01-10', provenances: ['legacy'] },
    ]);
    // The script's query filters provenance != 'legacy', so a stub row tagged
    // 'legacy' would never reach it; assert the day is imported regardless.
    expect(r.stdout).toMatch(/neverperson[\s\S]*?days {13}2 to import/);
  });

  it('narrows to one user with --user', async () => {
    const r = await runScript(['--user', 'github_otel'], []);
    expect(r.stdout).toContain('otelperson');
    expect(r.stdout).not.toContain('neverperson');
  });
});

describe('apply', () => {
  it('writes the rows a day implies, and nothing for the cutoff day', async () => {
    const r = await runScript(['--apply'], []);
    expect(r.exitCode).toBe(0);

    const events = r.inserts.filter(i => i.table === 'events_raw').flatMap(i => i.rows);
    const metrics = r.inserts.filter(i => i.table === 'metrics_raw').flatMap(i => i.rows);

    // prompts: otel 4+3, never 2+5 = 14 ; tool calls: 2+1 + 1+3 = 7
    expect(events.filter(e => e.event_name === 'claude_code.user_prompt')).toHaveLength(14);
    expect(events.filter(e => e.event_name === 'claude_code.tool_result')).toHaveLength(7);

    // nothing from the cutoff day
    expect(events.some(e => String(e.timestamp).startsWith('2026-03-03'))).toBe(false);
    expect(metrics.some(m => String(m.timestamp).startsWith('2026-03-03'))).toBe(false);

    // every row is tagged, hashed, at noon, and session-less
    for (const row of [...events, ...metrics]) {
      expect(row.provenance).toBe('legacy');
      expect(row.row_id).toMatch(/^[0-9a-f]{32}$/);
      expect(row.session_id).toBe('');
      expect(String(row.timestamp)).toContain(' 12:00:');
    }

    // session counts ride in the metric, not in a fabricated session_id
    const sessionMetrics = metrics.filter(m => m.metric_name === 'claude_code.session.count');
    expect(sessionMetrics.map(m => m.value).reduce((a, b) => a + b, 0)).toBe(2 + 1 + 1 + 3);
  });

  it('is idempotent: a second --apply writes byte-identical row_ids', async () => {
    const first = await runScript(['--apply'], []);
    const second = await runScript(['--apply'], []);

    const ids = (r: RunResult, table: string) =>
      r.inserts
        .filter(i => i.table === table)
        .flatMap(i => i.rows.map(row => row.row_id))
        .sort();

    expect(ids(second, 'events_raw')).toEqual(ids(first, 'events_raw'));
    expect(ids(second, 'metrics_raw')).toEqual(ids(first, 'metrics_raw'));

    // Distinct rows must still be distinct — if the per-prompt millisecond
    // offsets collapsed, a day's prompts would merge into one under FINAL.
    const eventIds = ids(first, 'events_raw');
    expect(new Set(eventIds).size).toBe(eventIds.length);
    const metricIds = ids(first, 'metrics_raw');
    expect(new Set(metricIds).size).toBe(metricIds.length);
  });

  it('prints the deploy-order warning on every run', async () => {
    expect((await runScript(['--apply'], [])).stdout).toContain(
      'DEPLOY THE CODE THAT DROPPED THE LEGACY READ PATHS BEFORE --apply.'
    );
  });
});
