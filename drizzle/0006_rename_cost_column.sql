-- The rename this file was always named for.
--
-- 0002 adds `users.total_cost_usd`; src/db/schema.ts calls the column
-- `total_cost_cents` and has since this migration was written. The file was
-- committed holding only a comment that said production already had
-- total_cost_cents from out-of-band ALTER TABLE work and that total_cost_usd
-- never existed there — true of production, and no help at all to a database
-- built by replaying the chain, which ends up with a column the application
-- does not read. (A comment-only migration is also not a migration drizzle can
-- run: better-sqlite3 rejects a statement with nothing in it.)
--
-- So it does the rename. Production is past this point in the journal and will
-- not run it; see docker/clickhouse/migrations/ for how its schema got here.

ALTER TABLE `users` RENAME COLUMN `total_cost_usd` TO `total_cost_cents`;
