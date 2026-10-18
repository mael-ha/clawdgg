import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema';
import { rankSnapshots } from '../db/schema';
import {
  RANK_METRIC_NAMES,
  assignRanks,
  pruneRankSnapshots,
  rankChange,
  rankChangesFor,
  snapshotRanks,
  utcDay,
} from './rank-snapshots';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

describe('assignRanks', () => {
  it('ranks highest first, from 1', () => {
    const ranked = assignRanks([
      { userId: 'b', value: 10 },
      { userId: 'a', value: 30 },
      { userId: 'c', value: 20 },
    ]);
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([
      ['a', 1],
      ['c', 2],
      ['b', 3],
    ]);
  });

  /**
   * The reason the tiebreaker exists. Two users on the same total come back
   * from SQLite in an arbitrary order, and a snapshot taken under one order and
   * compared with a board rendered under another shows BOTH of them a move that
   * never happened — every day, forever.
   */
  it('breaks ties deterministically, whatever order the rows arrive in', () => {
    const rows = [
      { userId: 'zoe', value: 100 },
      { userId: 'ann', value: 100 },
      { userId: 'mel', value: 100 },
    ];
    const first = assignRanks(rows).map((r) => r.userId);
    const reversed = assignRanks([...rows].reverse()).map((r) => r.userId);

    expect(first).toEqual(['ann', 'mel', 'zoe']);
    expect(reversed).toEqual(first);
  });

  // Positions, not competition ranking: the board displays index + 1, and a
  // stored rank under a different rule would disagree with the number next to
  // the user's name.
  it('gives tied users distinct positions, matching what the board renders', () => {
    const ranked = assignRanks([
      { userId: 'a', value: 5 },
      { userId: 'b', value: 5 },
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('does not mutate its input', () => {
    const rows = [{ userId: 'b', value: 1 }, { userId: 'a', value: 2 }];
    assignRanks(rows);
    expect(rows.map((r) => r.userId)).toEqual(['b', 'a']);
  });

  it('has nothing to rank with no rows', () => {
    expect(assignRanks([])).toEqual([]);
  });
});

describe('rankChange', () => {
  // 1 is the top, so a SMALLER rank is better and the arrow points up.
  it('is positive when the user climbed', () => {
    expect(rankChange(5, 2)).toBe(3);
  });

  it('is negative when the user fell', () => {
    expect(rankChange(2, 5)).toBe(-3);
  });

  it('is zero when nothing moved', () => {
    expect(rankChange(4, 4)).toBe(0);
  });

  // A user who was not in the previous snapshot has not moved, they have
  // arrived. An arrow would be invented.
  it('is undefined with no previous rank', () => {
    expect(rankChange(undefined, 1)).toBeUndefined();
  });
});

describe('utcDay', () => {
  it('is the UTC day, not the local one', () => {
    expect(utcDay(new Date('2026-10-18T23:59:59.999Z'))).toBe('2026-10-18');
    expect(utcDay(new Date('2026-10-19T00:00:00.000Z'))).toBe('2026-10-19');
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Against a real database
// ═══════════════════════════════════════════════════════════════════════════

let dir: string;
let sqlite: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

/**
 * The real migration IS the schema under test: reading it here is what keeps
 * drizzle/0011_add_rank_snapshots.sql and src/db/schema.ts from drifting.
 */
async function applySchema(database: Database): Promise<void> {
  database.exec(`CREATE TABLE users (
    id text PRIMARY KEY NOT NULL,
    github_id text,
    github_username text,
    total_prompts integer DEFAULT 0,
    total_tokens integer DEFAULT 0,
    total_lines_added integer DEFAULT 0,
    total_commits integer DEFAULT 0,
    total_cost_cents integer DEFAULT 0
  )`);

  const migration = await readFile(
    join(REPO_ROOT, 'drizzle/0011_add_rank_snapshots.sql'),
    'utf-8'
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) database.exec(statement);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clawdgg-rank-snapshots-'));
  sqlite = new Database(join(dir, 'test.db'), { create: true });
  sqlite.exec('PRAGMA foreign_keys = ON');
  await applySchema(sqlite);
  db = drizzle(sqlite, { schema });

  sqlite.exec(`INSERT INTO users (id, github_id, github_username, total_prompts, total_tokens) VALUES
    ('github_1', '1', 'ann', 300, 30),
    ('github_2', '2', 'mel', 200, 20),
    ('github_3', '3', 'zoe', 100, 10)`);
});

afterEach(async () => {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

const DAY_1 = new Date('2026-10-17T06:00:00.000Z');
const DAY_2 = new Date('2026-10-18T06:00:00.000Z');

describe('snapshotRanks', () => {
  it('writes one row per user per metric, for the UTC day', async () => {
    const written = await snapshotRanks(DAY_1, db);
    expect(written).toBe(3 * RANK_METRIC_NAMES.length);

    const rows = db.select().from(rankSnapshots).all();
    expect(rows.every((r) => r.day === '2026-10-17')).toBe(true);

    const prompts = rows
      .filter((r) => r.metric === 'prompts')
      .sort((a, b) => a.rank - b.rank);
    expect(prompts.map((r) => [r.userId, r.rank, r.value])).toEqual([
      ['github_1', 1, 300],
      ['github_2', 2, 200],
      ['github_3', 3, 100],
    ]);
  });

  // The sync job runs every five minutes; "once a day" has to survive that.
  it('is a no-op for the rest of the day, however often it runs', async () => {
    await snapshotRanks(DAY_1, db);
    const after = db.select().from(rankSnapshots).all().length;

    for (let i = 0; i < 5; i++) {
      expect(await snapshotRanks(new Date(DAY_1.getTime() + i * 60_000), db)).toBe(0);
    }
    expect(db.select().from(rankSnapshots).all().length).toBe(after);
  });

  // The figures moved, but the day already has a record: the EARLIER one is
  // what yesterday looked like, so it must not be overwritten.
  it('keeps the first snapshot of the day when the totals change under it', async () => {
    await snapshotRanks(DAY_1, db);
    sqlite.exec(`UPDATE users SET total_prompts = 9999 WHERE id = 'github_3'`);
    await snapshotRanks(DAY_1, db);

    const zoe = db
      .select()
      .from(rankSnapshots)
      .all()
      .find((r) => r.userId === 'github_3' && r.metric === 'prompts');
    expect(zoe?.rank).toBe(3);
    expect(zoe?.value).toBe(100);
  });

  it('writes a new row the next day', async () => {
    await snapshotRanks(DAY_1, db);
    expect(await snapshotRanks(DAY_2, db)).toBe(3 * RANK_METRIC_NAMES.length);
    expect(new Set(db.select().from(rankSnapshots).all().map((r) => r.day))).toEqual(
      new Set(['2026-10-17', '2026-10-18'])
    );
  });
});

describe('rankChangesFor', () => {
  const currentRanks = (order: string[]) =>
    new Map(order.map((userId, index) => [userId, index + 1]));

  it('reports the arrow each user earned', async () => {
    await snapshotRanks(DAY_1, db); // ann 1, mel 2, zoe 3

    // zoe overtakes everyone today.
    const changes = await rankChangesFor(
      'prompts',
      ['github_1', 'github_2', 'github_3'],
      currentRanks(['github_3', 'github_1', 'github_2']),
      DAY_2,
      db
    );
    expect(changes.get('github_3')).toBe(2); // 3rd → 1st, up two
    expect(changes.get('github_1')).toBe(-1); // 1st → 2nd
    expect(changes.get('github_2')).toBe(-1); // 2nd → 3rd
  });

  // A zero is not an arrow; the row renders nothing.
  it('omits users who did not move', async () => {
    await snapshotRanks(DAY_1, db);
    const changes = await rankChangesFor(
      'prompts',
      ['github_1', 'github_2', 'github_3'],
      currentRanks(['github_1', 'github_2', 'github_3']),
      DAY_2,
      db
    );
    expect(changes.size).toBe(0);
  });

  it('has no arrow for anyone before the first snapshot exists', async () => {
    const changes = await rankChangesFor(
      'prompts',
      ['github_1'],
      currentRanks(['github_1']),
      DAY_1,
      db
    );
    expect(changes.size).toBe(0);
  });

  // Today's own snapshot must not be the comparison. It is taken from the same
  // totals the board is rendering, so comparing against it would read 0 for
  // everybody and the board would never show an arrow at all.
  it('compares against the last day BEFORE today, not today', async () => {
    await snapshotRanks(DAY_1, db); // zoe 3rd
    sqlite.exec(`UPDATE users SET total_prompts = 999 WHERE id = 'github_3'`);
    await snapshotRanks(DAY_2, db); // zoe 1st — today's own record

    const changes = await rankChangesFor(
      'prompts',
      ['github_3'],
      currentRanks(['github_3']), // the board has zoe 1st
      DAY_2,
      db
    );
    // Against DAY_1 (3rd) this is +2. Against DAY_2's own snapshot (1st) it
    // would be 0, and omitted entirely.
    expect(changes.get('github_3')).toBe(2);
  });

  /**
   * A gap is why the comparison is "the previous snapshot" and not "yesterday":
   * a day the server was down would otherwise hide every arrow.
   */
  it('reaches back past a missing day', async () => {
    await snapshotRanks(DAY_1, db);
    const threeDaysLater = new Date('2026-10-20T06:00:00.000Z');

    const changes = await rankChangesFor(
      'prompts',
      ['github_3'],
      currentRanks(['github_3']),
      threeDaysLater,
      db
    );
    expect(changes.get('github_3')).toBe(2);
  });

  it('ignores a user who is not in the current page', async () => {
    await snapshotRanks(DAY_1, db);
    const changes = await rankChangesFor(
      'prompts',
      ['github_3'],
      currentRanks(['github_3']),
      DAY_2,
      db
    );
    expect([...changes.keys()]).toEqual(['github_3']);
  });

  it('is per metric, so a move in prompts is not a move in tokens', async () => {
    await snapshotRanks(DAY_1, db);
    const tokens = await rankChangesFor(
      'tokens',
      ['github_1'],
      currentRanks(['github_1']),
      DAY_2,
      db
    );
    expect(tokens.size).toBe(0); // ann was 1st in tokens and still is
  });
});

describe('pruneRankSnapshots', () => {
  const days = () => new Set(db.select().from(rankSnapshots).all().map((r) => r.day));

  it('keeps everything inside the horizon', async () => {
    await snapshotRanks(DAY_1, db);
    await snapshotRanks(DAY_2, db);

    // A one-day horizon keeps today and the day before it.
    await pruneRankSnapshots(1, DAY_2, db);
    expect(days()).toEqual(new Set(['2026-10-17', '2026-10-18']));
  });

  it('drops days past it', async () => {
    await snapshotRanks(DAY_1, db);
    await snapshotRanks(DAY_2, db);

    await pruneRankSnapshots(0, DAY_2, db);
    expect(days()).toEqual(new Set(['2026-10-18']));
  });

  it('leaves the table alone when nothing is old enough', async () => {
    await snapshotRanks(DAY_2, db);
    await pruneRankSnapshots(400, DAY_2, db);
    expect(days()).toEqual(new Set(['2026-10-18']));
  });
});
