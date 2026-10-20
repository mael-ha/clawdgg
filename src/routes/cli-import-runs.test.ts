import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema';
import { importForRun, type RunCoverage } from './cli';
import { importBatches } from '../../cli/import-upload';
import {
  ULTRATHINK_EVENT_NAME,
  eventRowId,
  metricRowId,
  type EventRow,
  type MetricRow,
} from '../db/clickhouse';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const USER = 'github_1';
const CUTOFF = Date.parse('2026-05-06T00:00:00.000Z');
const FLAG_CUTOFF = Date.parse('2026-09-01T00:00:00.000Z');

let dir: string;
let sqlite: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** The real migration IS the schema under test. */
async function applySchema(database: Database): Promise<void> {
  database.exec(`CREATE TABLE users (id text PRIMARY KEY NOT NULL)`);
  const migration = await readFile(join(REPO_ROOT, 'drizzle/0014_add_import_days.sql'), 'utf-8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) database.exec(statement);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clawdgg-import-runs-'));
  sqlite = new Database(join(dir, 'test.db'), { create: true });
  sqlite.exec('PRAGMA foreign_keys = ON');
  await applySchema(sqlite);
  db = drizzle(sqlite, { schema });
  sqlite.exec(`INSERT INTO users (id) VALUES ('${USER}')`);
});

afterEach(async () => {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * ClickHouse as the import sees it: the two raw tables, the coverage sets the
 * real endpoint scans them for, and the stored row_ids per day.
 */
function fakeClickHouse() {
  const events: EventRow[] = [];
  const metrics: MetricRow[] = [];
  let failInserts = false;
  const day = (row: { timestamp: string }) => row.timestamp.slice(0, 10);

  return {
    events,
    metrics,
    failInserts(on: boolean) {
      failInserts = on;
    },
    coverage(): RunCoverage {
      const measured = events.filter((row) => row.event_name !== ULTRATHINK_EVENT_NAME);
      const flags = events.filter((row) => row.event_name === ULTRATHINK_EVENT_NAME);
      return {
        days: new Set([...measured, ...metrics].map(day)),
        ultrathinkDays: new Set(flags.map(day)),
      };
    },
    async storedRowIds(days: string[]) {
      const wanted = new Set(days);
      return new Set([
        ...events.filter((row) => wanted.has(day(row))).map(eventRowId),
        ...metrics.filter((row) => wanted.has(day(row))).map(metricRowId),
      ]);
    },
    async insertEvents(rows: EventRow[]) {
      if (failInserts) throw new Error('Database insert failed');
      events.push(...rows);
    },
    async insertMetrics(rows: MetricRow[]) {
      if (failInserts) throw new Error('Database insert failed');
      metrics.push(...rows);
    },
  };
}

type FakeClickHouse = ReturnType<typeof fakeClickHouse>;

/** `n` prompts on one UTC day, each its own row. */
function prompts(day: string, n: number, session = 's1') {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: `${day} 10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000`,
    session_id: session,
    event_name: 'claude_code.user_prompt',
    prompt_length: 12,
  }));
}

const apiRequest = (timestamp: string) => ({
  timestamp,
  session_id: 's1',
  event_name: 'claude_code.api_request',
  model: 'claude-opus-5',
  input_tokens: 1000,
  output_tokens: 500,
});

/**
 * Upload `rows` the way the CLI does — chronological, cut by importBatches —
 * as one run. `coverage` decides what the server knows about the covered
 * days for each batch: 'cached' is the snapshot from the run's first batch,
 * 'fresh' recomputes it every batch, which is what a restart after each batch
 * or a run longer than the cache produces.
 */
async function upload(
  ch: FakeClickHouse,
  rows: { timestamp: string }[],
  options: { runId: string; cap: number; coverage?: 'cached' | 'fresh'; stopAfter?: number }
) {
  const sorted = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const batches = importBatches(sorted, options.cap);
  let snapshot: RunCoverage | null = null;
  let inserted = 0;
  let sent = 0;

  for (const batch of batches) {
    if (options.stopAfter !== undefined && sent >= options.stopAfter) break;
    const coverage =
      options.coverage === 'fresh' ? ch.coverage() : (snapshot ??= ch.coverage());
    const result = await importForRun(
      USER,
      { events: batch.events, openDay: batch.openDay, runId: options.runId },
      {
        cutoffMs: CUTOFF,
        flagCutoffMs: FLAG_CUTOFF,
        coverage,
        storedRowIds: ch.storedRowIds,
        insertEvents: ch.insertEvents,
        insertMetrics: ch.insertMetrics,
        database: db,
      }
    );
    inserted += result.inserted;
    sent++;
  }
  return { batches: batches.length, sent, inserted };
}

/** Prompts stored per day, and whether any row is stored twice. */
function tally(ch: FakeClickHouse) {
  const perDay: Record<string, number> = {};
  for (const row of ch.events) {
    if (row.event_name === 'claude_code.user_prompt') {
      const day = row.timestamp.slice(0, 10);
      perDay[day] = (perDay[day] ?? 0) + 1;
    }
  }
  const ids = [...ch.events.map(eventRowId), ...ch.metrics.map(metricRowId)];
  return { perDay, doubled: ids.length - new Set(ids).size };
}

const openDays = () =>
  sqlite.query<{ day: string }, []>(`SELECT day FROM import_days WHERE open = 1 ORDER BY day`).all().map((r) => r.day);

describe('importForRun — a day bigger than one batch', () => {
  const history = () => [...prompts('2026-03-01', 2), ...prompts('2026-03-02', 7), ...prompts('2026-03-03', 2)];

  it('lands whole within one run', async () => {
    const ch = fakeClickHouse();
    const run = await upload(ch, history(), { runId: 'run-a', cap: 3 });

    expect(run.batches).toBe(5);
    expect(tally(ch)).toEqual({ perDay: { '2026-03-01': 2, '2026-03-02': 7, '2026-03-03': 2 }, doubled: 0 });
    expect(openDays()).toEqual([]);
  });

  it('lands whole when every batch finds the coverage recomputed — a restart, or a run past the cache', async () => {
    const ch = fakeClickHouse();
    await upload(ch, history(), { runId: 'run-a', cap: 3, coverage: 'fresh' });

    expect(tally(ch)).toEqual({ perDay: { '2026-03-01': 2, '2026-03-02': 7, '2026-03-03': 2 }, doubled: 0 });
  });

  it('is finished by the next run when the first stops between two of its batches', async () => {
    const ch = fakeClickHouse();
    // Batches: [03-01] [03-02 ×3, open] [03-02 ×3, open] [03-02 ×1] [03-03].
    const first = await upload(ch, history(), { runId: 'run-a', cap: 3, stopAfter: 2 });
    expect(first.sent).toBe(2);
    expect(tally(ch).perDay).toEqual({ '2026-03-01': 2, '2026-03-02': 3 });
    expect(openDays()).toEqual(['2026-03-02']);

    // A new run, after a restart: nothing in memory, a fresh coverage scan
    // that holds 03-01 and the first three rows of 03-02.
    const second = await upload(ch, history(), { runId: 'run-b', cap: 3, coverage: 'fresh' });

    expect(tally(ch)).toEqual({ perDay: { '2026-03-01': 2, '2026-03-02': 7, '2026-03-03': 2 }, doubled: 0 });
    expect(second.inserted).toBe(4 + 2);
    expect(openDays()).toEqual([]);
  });

  it('is finished by the next run when the insert failed, because the day is marked open first', async () => {
    const ch = fakeClickHouse();
    ch.failInserts(false);
    await upload(ch, history(), { runId: 'run-a', cap: 3, stopAfter: 2 });

    ch.failInserts(true);
    await expect(upload(ch, history().slice(5), { runId: 'run-a', cap: 3 })).rejects.toThrow('Database insert failed');
    ch.failInserts(false);
    expect(openDays()).toEqual(['2026-03-02']);

    await upload(ch, history(), { runId: 'run-b', cap: 3, coverage: 'fresh' });
    expect(tally(ch)).toEqual({ perDay: { '2026-03-01': 2, '2026-03-02': 7, '2026-03-03': 2 }, doubled: 0 });
  });

  it('carries the api_request metrics along, also once', async () => {
    const ch = fakeClickHouse();
    const rows = [...prompts('2026-03-02', 4), apiRequest('2026-03-02 11:00:00.000'), apiRequest('2026-03-02 11:00:01.000')];
    await upload(ch, rows, { runId: 'run-a', cap: 2, stopAfter: 2 });
    await upload(ch, rows, { runId: 'run-b', cap: 2, coverage: 'fresh' });

    const alone = fakeClickHouse();
    await upload(alone, rows, { runId: 'run-c', cap: 100 });

    expect(ch.events.length).toBe(alone.events.length);
    expect(ch.metrics.length).toBe(alone.metrics.length);
    expect(tally(ch).doubled).toBe(0);
  });
});

describe('importForRun — what stays skipped', () => {
  it('a finished import, run again, inserts nothing', async () => {
    const ch = fakeClickHouse();
    const rows = [...prompts('2026-03-01', 2), ...prompts('2026-03-02', 7)];
    await upload(ch, rows, { runId: 'run-a', cap: 3 });
    const again = await upload(ch, rows, { runId: 'run-b', cap: 3, coverage: 'fresh' });

    expect(again.inserted).toBe(0);
    expect(tally(ch).doubled).toBe(0);
  });

  it('a day held by another source is skipped whole, however it is batched', async () => {
    const ch = fakeClickHouse();
    // A legacy row on 03-02, written by nothing import_days knows about.
    ch.events.push({ ...(prompts('2026-03-02', 1, 'legacy')[0] as object), user_id: USER, provenance: 'legacy' } as EventRow);

    await upload(ch, [...prompts('2026-03-01', 2), ...prompts('2026-03-02', 7)], { runId: 'run-a', cap: 3 });
    expect(tally(ch).perDay).toEqual({ '2026-03-01': 2, '2026-03-02': 1 });
  });

  it('a day another run finished is not reopened, even with more rows for it', async () => {
    const ch = fakeClickHouse();
    await upload(ch, prompts('2026-03-02', 2), { runId: 'run-a', cap: 3 });
    // A second machine's history for the same day: rule 7 says the day is counted.
    await upload(ch, prompts('2026-03-02', 5, 'other-machine'), { runId: 'run-b', cap: 3, coverage: 'fresh' });

    expect(tally(ch).perDay).toEqual({ '2026-03-02': 2 });
  });

  it('a batch sent twice lands once', async () => {
    const ch = fakeClickHouse();
    const batch = { events: prompts('2026-03-02', 3), openDay: null, runId: 'run-a' };
    const deps = {
      cutoffMs: CUTOFF,
      flagCutoffMs: FLAG_CUTOFF,
      storedRowIds: ch.storedRowIds,
      insertEvents: ch.insertEvents,
      insertMetrics: ch.insertMetrics,
      database: db,
    };
    await importForRun(USER, batch, { ...deps, coverage: ch.coverage() });
    const retry = await importForRun(USER, batch, { ...deps, coverage: ch.coverage() });

    expect(retry.inserted).toBe(0);
    expect(retry.skippedDuplicate).toBe(3);
    expect(tally(ch)).toEqual({ perDay: { '2026-03-02': 3 }, doubled: 0 });
  });

  it('records nothing for a batch with no run id, and judges it as before', async () => {
    const ch = fakeClickHouse();
    const deps = {
      cutoffMs: CUTOFF,
      flagCutoffMs: FLAG_CUTOFF,
      storedRowIds: ch.storedRowIds,
      insertEvents: ch.insertEvents,
      insertMetrics: ch.insertMetrics,
      database: db,
    };
    await importForRun(USER, { events: prompts('2026-03-02', 2) }, { ...deps, coverage: ch.coverage() });
    const second = await importForRun(USER, { events: prompts('2026-03-02', 3) }, { ...deps, coverage: ch.coverage() });

    expect(second.inserted).toBe(0);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM import_days`).get()).toEqual({ n: 0 });
  });
});
