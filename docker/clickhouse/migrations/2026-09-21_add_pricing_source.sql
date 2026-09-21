-- ═══════════════════════════════════════════════════════════════════════════
-- Forward migration: add `pricing_source` to the raw tables.
--
-- 01_schema.sql only runs on a FRESH ClickHouse volume, so existing prod
-- tables need this ALTER applied by hand. This is the first file in this
-- directory: `provenance` was added out-of-band on prod with no migration
-- recorded. New raw-table columns go here from now on.
--
-- Cost is ESTIMATED (token counts × price table) only on rows written by
-- src/scripts/backfill-jsonl.ts. Those now carry how the model id matched the
-- table — 'exact' | 'normalized' | 'family' | 'fallback' (src/lib/pricing.ts),
-- so a fallback-priced row is traceable instead of blending into the totals.
-- Empty means no price table was consulted: live OTLP rows carry Claude Code's
-- own measured cost_usd, and token metrics carry no cost at all.
--
-- Backwards compatible: DEFAULT '' backfills existing rows, the ORDER BY key
-- is untouched (no ReplacingMergeTree dedup impact), and every read path
-- selects named columns.
--
-- Apply (NOT run automatically — do it deliberately):
--   ssh clawdgg 'docker compose -f /opt/clawdgg/docker-compose.staging.yml \
--     exec -T clickhouse clickhouse-client --multiquery' \
--     < docker/clickhouse/migrations/2026-09-21_add_pricing_source.sql
-- ═══════════════════════════════════════════════════════════════════════════

USE clawd;

ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS pricing_source String DEFAULT '' AFTER provenance;

ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS pricing_source String DEFAULT '' AFTER provenance;
