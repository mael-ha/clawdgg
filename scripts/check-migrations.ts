#!/usr/bin/env bun
/**
 * Prove the SQLite migration chain, two ways:
 *
 *   1. REPLAY. A fresh database, 0000 → latest through drizzle's own migrator,
 *      must end up with the schema src/db/schema.ts describes. Nothing else
 *      catches a migration that was written but never journalled (every
 *      archetype column spent ten months in that state), a hand-written file
 *      with no breakpoint markers (better-sqlite3 rejects a multi-statement
 *      string, so the migrate fails on the spot), or a column the chain names
 *      differently from the code that reads it.
 *
 *   2. IDEMPOTENCE. Migrating an up-to-date database must do NOTHING, and a
 *      database that was brought up to date by hand must do nothing either
 *      once its journal is stamped. That second case is production: `migrate`
 *      has been broken there since the 0003 rename, so its schema arrived by
 *      hand while __drizzle_migrations stayed behind.
 *
 *   bun scripts/check-migrations.ts          # both checks, exit 1 on a diff
 *   bun scripts/check-migrations.ts --stamp /data/clawd.db   # see STAMPING
 *
 * STAMPING. `--stamp` is the one-off for a database whose schema was brought up
 * to date by hand. It compares that database against src/db/schema.ts and, only
 * if they agree, records the latest journal entry in __drizzle_migrations so the
 * next `drizzle-kit migrate` skips the whole chain instead of re-running it. It
 * executes no migration SQL and changes no table but that one. On a mismatch it
 * prints the difference and stamps nothing, which is the answer: a schema that
 * does not match must be reconciled by hand first.
 *
 * The expected schema comes from `drizzle-kit export`, which is the same
 * generator `drizzle-kit generate` diffs against — so this compares the chain
 * to the schema file, never to a second opinion about it.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const MIGRATIONS_FOLDER = "drizzle";

interface Column {
  table: string;
  name: string;
  type: string;
  notNull: number;
  dflt: string | null;
  pk: number;
}

/** Every column and index, as a comparable shape. Column ORDER is left out:
 *  `ALTER TABLE ADD COLUMN` appends, so a replayed table lists its columns in
 *  a different order than a freshly created one and means the same thing. */
function describe(db: Database): { columns: Column[]; indexes: string[] } {
  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'
       ORDER BY name`
    )
    .all();

  const columns: Column[] = [];
  for (const { name: table } of tables) {
    for (const row of db
      .query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
        `PRAGMA table_info(${JSON.stringify(table)})`
      )
      .all()) {
      columns.push({
        table,
        name: row.name,
        type: row.type.toUpperCase(),
        notNull: row.notnull,
        dflt: row.dflt_value,
        pk: row.pk,
      });
    }
  }
  columns.sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));

  // Normalised: the generator quotes identifiers with backticks and a replay
  // may not, and neither is a difference in the schema.
  const indexes = db
    .query<{ sql: string | null }, []>(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`
    )
    .all()
    .map((row) => (row.sql ?? "").replace(/[`"]/g, "").replace(/\s+/g, " ").trim())
    .sort();

  return { columns, indexes };
}

function columnKey(c: Column): string {
  return `${c.table}.${c.name}  ${c.type}${c.notNull ? " NOT NULL" : ""}${
    c.dflt === null ? "" : ` DEFAULT ${c.dflt}`
  }${c.pk ? " PK" : ""}`;
}

function diffLines(expected: string[], actual: string[]): string[] {
  const out: string[] = [];
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const line of expected) if (!actualSet.has(line)) out.push(`  - missing: ${line}`);
  for (const line of actual) if (!expectedSet.has(line)) out.push(`  + extra:   ${line}`);
  return out;
}

/** The expected schema, as DDL, straight from src/db/schema.ts. */
function exportedSchemaSql(): string {
  const exported = Bun.spawnSync(["bunx", "drizzle-kit", "export", "--sql"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (exported.exitCode !== 0) {
    console.error(`drizzle-kit export failed:\n${exported.stderr.toString()}`);
    process.exit(1);
  }
  return exported.stdout.toString();
}

function latestJournalEntry(): { when: number; tag: string } {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf-8")
  ) as { entries: { when: number; tag: string }[] };
  const latest = journal.entries[journal.entries.length - 1];
  if (!latest) {
    console.error("meta/_journal.json has no entries");
    process.exit(1);
  }
  return latest;
}

/**
 * Bring an already-up-to-date database's journal in line, without migrating it.
 * See STAMPING in the header.
 */
function stamp(dbPath: string): never {
  const scratch = mkdtempSync(join(tmpdir(), "clawdgg-stamp-"));
  try {
    const expectedDb = new Database(join(scratch, "expected.db"));
    expectedDb.run(exportedSchemaSql());

    const target = new Database(dbPath);
    const diff = [
      ...diffLines(
        describe(expectedDb).columns.map(columnKey),
        describe(target).columns.map(columnKey)
      ),
      ...diffLines(describe(expectedDb).indexes, describe(target).indexes),
    ];

    if (diff.length > 0) {
      console.error(`✗ ${dbPath} does not match src/db/schema.ts — stamping nothing.`);
      console.error("  (- is in schema.ts and missing from the database)");
      for (const line of diff) console.error(line);
      process.exit(1);
    }
    console.log(`✓ ${dbPath} matches src/db/schema.ts`);

    target.run(
      `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
    );
    const latest = latestJournalEntry();
    const newest = target
      .query<{ created_at: number | null }, []>(
        `SELECT MAX(created_at) AS created_at FROM __drizzle_migrations`
      )
      .get()?.created_at;

    if (newest !== null && newest !== undefined && Number(newest) >= latest.when) {
      console.log(`Already stamped at ${newest} — nothing to do, migrate is a no-op.`);
      process.exit(0);
    }

    target.run(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`, [
      `stamped:${latest.tag}`,
      latest.when,
    ]);
    console.log(
      `✓ stamped ${latest.tag} (created_at ${latest.when})${
        newest == null ? "" : `, over a journal that stopped at ${newest}`
      }`
    );
    console.log("`bunx drizzle-kit migrate` is now a no-op on this database.");
    process.exit(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const stampTarget = process.argv.indexOf("--stamp");
if (stampTarget !== -1) {
  const path = process.argv[stampTarget + 1];
  if (!path) {
    console.error("--stamp needs a database path");
    process.exit(1);
  }
  stamp(path);
}

const scratch = mkdtempSync(join(tmpdir(), "clawdgg-migrations-"));
let failures = 0;

try {
  // ---- 1. Replay from zero -------------------------------------------------
  const replayedPath = join(scratch, "replayed.db");
  const replayed = new Database(replayedPath);
  migrate(drizzle(replayed), { migrationsFolder: MIGRATIONS_FOLDER });
  console.log(`replayed ${MIGRATIONS_FOLDER}/0000 → latest into a fresh database`);

  // ---- 2. The schema the application expects -------------------------------
  const expectedSql = exportedSchemaSql();
  const expectedDb = new Database(join(scratch, "expected.db"));
  // Foreign keys are off by default, so the order the tables arrive in does
  // not matter — which is just as well, since `export` does not sort them.
  expectedDb.run(expectedSql);

  const replayedSchema = describe(replayed);
  const expectedSchema = describe(expectedDb);

  const columnDiff = diffLines(
    expectedSchema.columns.map(columnKey),
    replayedSchema.columns.map(columnKey)
  );
  const indexDiff = diffLines(expectedSchema.indexes, replayedSchema.indexes);

  if (columnDiff.length === 0 && indexDiff.length === 0) {
    console.log(
      `✓ replayed schema matches src/db/schema.ts ` +
        `(${expectedSchema.columns.length} columns, ${expectedSchema.indexes.length} indexes)`
    );
  } else {
    failures++;
    console.error("✗ the replayed schema and src/db/schema.ts disagree:");
    console.error("  (- is in schema.ts and not in the chain, + is the other way round)");
    for (const line of [...columnDiff, ...indexDiff]) console.error(line);
  }

  // ---- 3. Migrating an up-to-date database changes nothing ------------------
  const before = replayed
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM __drizzle_migrations`)
    .get()!.n;
  migrate(drizzle(replayed), { migrationsFolder: MIGRATIONS_FOLDER });
  const after = replayed
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM __drizzle_migrations`)
    .get()!.n;

  if (after === before && JSON.stringify(describe(replayed)) === JSON.stringify(replayedSchema)) {
    console.log(`✓ a second migrate is a no-op (${before} journal rows, unchanged)`);
  } else {
    failures++;
    console.error(`✗ a second migrate was NOT a no-op: ${before} journal rows became ${after}`);
  }

  // ---- 4. A hand-migrated database, once stamped, is left alone -------------
  // Production's case, modelled exactly: the schema is already there, the
  // journal table is not. Drizzle gates on the newest created_at it finds and
  // never looks at the hashes, so one stamped row is enough to make the whole
  // chain skip — and if the stamp were missing, every one of these migrations
  // would be re-run against a schema that already has them.
  const latest = latestJournalEntry();

  const stamped = new Database(join(scratch, "stamped.db"));
  stamped.run(expectedSql); // the schema, applied by "hand"
  stamped.run(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
  );
  stamped.run(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('stamped', ?)`, [
    latest.when,
  ]);

  const stampedBefore = describe(stamped);
  migrate(drizzle(stamped), { migrationsFolder: MIGRATIONS_FOLDER });
  const stampedAfter = describe(stamped);

  if (JSON.stringify(stampedBefore) === JSON.stringify(stampedAfter)) {
    console.log(`✓ a database stamped at ${latest.when} (${latest.tag}) is not migrated again`);
  } else {
    failures++;
    console.error("✗ a stamped database was migrated anyway — the schema changed under us");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} migration check(s) failed.`);
  process.exit(1);
}
console.log("\nMigration chain is replayable and idempotent.");
