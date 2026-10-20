-- ═══════════════════════════════════════════════════════════════════════════
-- Forward migration: let both raw tables drop a retried insert.
--
-- src/db/clickhouse.ts insert() sends an `insert_deduplication_token` with
-- every batch, a hash of the table and the row_ids in it. On a non-replicated
-- MergeTree that token is only remembered when the table keeps a deduplication
-- window, and the default window is 0 — so without this the token is ignored
-- and a retried batch lands twice.
--
-- This is what makes it safe for the app's reads to run without FINAL: a
-- duplicate can no longer arrive through a retry, and ReplacingMergeTree's
-- merge still collapses equal sorting keys as a backstop.
--
-- 10000 is the number of recent insert blocks whose hashes the table keeps,
-- per table — hours of OTLP traffic at today's rate, comfortably longer than
-- any exporter or CLI retry. Metadata only: no data is rewritten, no restart.
--
-- Idempotent; run with clickhouse-client --multiquery.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE clawd.metrics_raw MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE clawd.events_raw MODIFY SETTING non_replicated_deduplication_window = 10000;
