/**
 * Which UTC days `clawdgg import` has written, by which run, and whether that
 * run finished them.
 *
 * The import skips a day the server already holds rows for (rule 7 in
 * src/routes/cli.ts), and a day is the unit it counts in. Two kinds of day are
 * held and must still be accepted:
 *
 *   - the CURRENT run's own days. A day can take more than one batch (the CLI
 *     gives a day bigger than its batch cap batches of its own), and the
 *     second batch must not find the day "already held" by the first.
 *   - a day an EARLIER run left open. It stopped between two batches of one
 *     day, so the day is half written; skipping it would make it short for
 *     good, so the next run is let in to finish it.
 *
 * Both used to rest on a snapshot of the covered days kept in memory for 30
 * minutes per run: a restart or a slow run lost it, and an interrupted day
 * could never be finished at all. This table is that knowledge, in storage.
 *
 * A reopened day can already hold some of the rows a batch carries, so the
 * import drops every row whose identity is already stored for that day before
 * inserting (see runImport). That is what makes reopening safe to repeat.
 *
 * The order of writes is what makes it safe to crash: a day is marked open
 * under this run BEFORE its rows are inserted, and closed only after the insert
 * succeeded and only if the batch did not say the day continues. A crash in
 * between leaves the day open, which costs a later run one dedup, never a row.
 */

import { and, eq, or } from 'drizzle-orm';
import { db } from '../db';
import { importDays } from '../db/schema';

type AppDb = typeof db;

/** Days this run may write although they are held: its own, and any left open. */
export async function reopenedImportDays(
  userId: string,
  runId: string | null,
  database: AppDb = db
): Promise<Set<string>> {
  const rows = await database
    .select({ day: importDays.day })
    .from(importDays)
    .where(
      and(
        eq(importDays.userId, userId),
        runId === null ? eq(importDays.open, true) : or(eq(importDays.open, true), eq(importDays.runId, runId))
      )
    )
    .all();
  return new Set(rows.map((row) => row.day));
}

/** Record that `runId` has written `days`, open or finished. */
export async function markImportDays(
  userId: string,
  runId: string,
  days: Iterable<string>,
  isOpen: (day: string) => boolean,
  database: AppDb = db
): Promise<void> {
  const values = [...days].map((day) => ({ userId, day, runId, open: isOpen(day), updatedAt: new Date() }));
  if (values.length === 0) return;
  for (const value of values) {
    await database
      .insert(importDays)
      .values(value)
      .onConflictDoUpdate({
        target: [importDays.userId, importDays.day],
        set: { runId: value.runId, open: value.open, updatedAt: value.updatedAt },
      })
      .run();
  }
}
