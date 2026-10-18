-- ═══════════════════════════════════════════════════════════════════════════
-- Breaking migration: add `row_id` to the ReplacingMergeTree sorting keys.
--
-- THE BUG
-- Both raw tables are ReplacingMergeTree and every read uses FINAL, so rows
-- that share the sorting key collapse to one. The old keys were
--   metrics_raw (user_id, metric_name, token_type, line_type, timestamp)
--   events_raw  (user_id, session_id, event_name, timestamp, tool_name)
-- but Claude Code exports several datapoints per interval that share a
-- timestamp and differ only by model, query_source (main/subagent/auxiliary),
-- speed, effort, agent/skill/plugin/mcp name, or tool/decision/language. Those
-- were silently collapsed: main-thread and subagent token usage at the same
-- instant became a single number, and two models in one export interval became
-- one. Same exposure on events_raw for two tool_results in the same
-- millisecond.
--
-- THE FIX
-- `row_id` is a SHA-256 over all of a row's IDENTIFYING fields and none of its
-- measured value, computed at insert time by metricRowId()/eventRowId() in
-- src/db/clickhouse.ts. An OTLP retry of the same datapoint hashes identically
-- and still collapses; genuinely distinct datapoints differ and both survive.
-- The field lists live in METRIC_IDENTITY_COLUMNS / EVENT_IDENTITY_COLUMNS and
-- the expressions below are generated from them by identitySqlExpr() —
-- src/db/clickhouse.test.ts asserts this file still matches, so TS and SQL
-- cannot drift.
--
-- WHAT CANNOT BE RECOVERED
-- Rows already collapsed on prod are gone. ClickHouse kept one row per old key
-- and discarded the rest on merge; there is no history to re-derive them from.
-- After this migration the pre-existing rows keep whatever value survived, and
-- only data ingested from here on is split correctly. Numbers for the affected
-- period are therefore an UNDERCOUNT of tokens/cost wherever two datapoints
-- shared a key — say so if the figures are ever published as exact.
--
-- WHY NEW TABLES
-- ORDER BY cannot be rewritten in place for existing parts. (ClickHouse does
-- allow ALTER TABLE ... MODIFY ORDER BY to APPEND columns, and it is
-- metadata-only — but it leaves existing parts sorted by the old key with no
-- rewrite, which is exactly the state this migration exists to leave behind.
-- Copy-and-swap is auditable, verifiable with a row count, and reversible.)
--
-- The copy deliberately does NOT use FINAL on the source: FINAL would apply the
-- broken old key one last time and collapse the very rows we are trying to keep
-- apart. Copying raw and letting the v2 key dedup is strictly more faithful. The
-- new key is the old key plus row_id, so it is strictly finer — nothing that
-- survives in the old table can collapse in the new one.
--
-- RUN ORDER: this migration must be applied BEFORE deploying the app code that
-- writes row_id, or every insert fails on an unknown column. Full ordered
-- runbook, including the backup step: docker/clickhouse/migrations/README-2026-10.md
-- ═══════════════════════════════════════════════════════════════════════════

USE clawd;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. metrics_raw
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS metrics_raw_v2 (
    timestamp DateTime64(3),
    user_id String,
    session_id String,
    metric_name String,
    value Float64,
    model String DEFAULT '',
    token_type String DEFAULT '',
    line_type String DEFAULT '',
    tool String DEFAULT '',
    decision String DEFAULT '',
    language String DEFAULT '',
    source String DEFAULT '',
    query_source String DEFAULT '',
    speed String DEFAULT '',
    effort String DEFAULT '',
    agent_name String DEFAULT '',
    skill_name String DEFAULT '',
    plugin_name String DEFAULT '',
    mcp_server_name String DEFAULT '',
    mcp_tool_name String DEFAULT '',
    start_type String DEFAULT '',
    terminal_type String DEFAULT '',
    app_version String DEFAULT '',
    account_uuid String DEFAULT '',
    organization_id String DEFAULT '',
    provenance String DEFAULT 'live',
    pricing_source String DEFAULT '',
    row_id String DEFAULT ''
) ENGINE = ReplacingMergeTree()
ORDER BY (user_id, metric_name, token_type, line_type, timestamp, row_id)
PARTITION BY toYYYYMM(timestamp)
TTL toDateTime(timestamp) + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

INSERT INTO metrics_raw_v2
SELECT
    timestamp,
    user_id,
    session_id,
    metric_name,
    value,
    model,
    token_type,
    line_type,
    tool,
    decision,
    language,
    source,
    query_source,
    speed,
    effort,
    agent_name,
    skill_name,
    plugin_name,
    mcp_server_name,
    mcp_tool_name,
    start_type,
    terminal_type,
    app_version,
    account_uuid,
    organization_id,
    provenance,
    pricing_source,
    substring(lower(hex(SHA256(arrayStringConcat([toString(timestamp), toString(user_id), toString(session_id), toString(metric_name), toString(model), toString(token_type), toString(line_type), toString(tool), toString(decision), toString(language), toString(source), toString(query_source), toString(speed), toString(effort), toString(agent_name), toString(skill_name), toString(plugin_name), toString(mcp_server_name), toString(mcp_tool_name), toString(start_type), toString(terminal_type), toString(app_version), toString(account_uuid), toString(organization_id), toString(provenance)], char(31))))), 1, 32) AS row_id
FROM metrics_raw;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. events_raw
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events_raw_v2 (
    timestamp DateTime64(3),
    user_id String,
    session_id String,
    event_name String,
    prompt_length UInt32 DEFAULT 0,
    tool_name String DEFAULT '',
    tool_success UInt8 DEFAULT 1,
    tool_duration_ms UInt32 DEFAULT 0,
    model String DEFAULT '',
    cost_usd Float64 DEFAULT 0,
    input_tokens UInt32 DEFAULT 0,
    output_tokens UInt32 DEFAULT 0,
    cache_read_tokens UInt32 DEFAULT 0,
    cache_write_tokens UInt32 DEFAULT 0,
    error_message String DEFAULT '',
    status_code UInt16 DEFAULT 0,
    duration_ms UInt32 DEFAULT 0,
    decision String DEFAULT '',
    source String DEFAULT '',
    tool_parameters String DEFAULT '',
    tool_use_id String DEFAULT '',
    prompt_id String DEFAULT '',
    request_id String DEFAULT '',
    query_source String DEFAULT '',
    speed String DEFAULT '',
    effort String DEFAULT '',
    agent_name String DEFAULT '',
    skill_name String DEFAULT '',
    command_name String DEFAULT '',
    command_source String DEFAULT '',
    terminal_type String DEFAULT '',
    app_version String DEFAULT '',
    account_uuid String DEFAULT '',
    organization_id String DEFAULT '',
    provenance String DEFAULT 'live',
    pricing_source String DEFAULT '',
    row_id String DEFAULT ''
) ENGINE = ReplacingMergeTree()
ORDER BY (user_id, session_id, event_name, timestamp, tool_name, row_id)
PARTITION BY toYYYYMM(timestamp)
TTL toDateTime(timestamp) + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

INSERT INTO events_raw_v2
SELECT
    timestamp,
    user_id,
    session_id,
    event_name,
    prompt_length,
    tool_name,
    tool_success,
    tool_duration_ms,
    model,
    cost_usd,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens,
    error_message,
    status_code,
    duration_ms,
    decision,
    source,
    tool_parameters,
    tool_use_id,
    prompt_id,
    request_id,
    query_source,
    speed,
    effort,
    agent_name,
    skill_name,
    command_name,
    command_source,
    terminal_type,
    app_version,
    account_uuid,
    organization_id,
    provenance,
    pricing_source,
    substring(lower(hex(SHA256(arrayStringConcat([toString(timestamp), toString(user_id), toString(session_id), toString(event_name), toString(tool_name), toString(tool_use_id), toString(model), toString(decision), toString(source), toString(request_id), toString(prompt_id), toString(command_name), toString(command_source), toString(query_source), toString(speed), toString(effort), toString(agent_name), toString(skill_name), toString(status_code), toString(error_message), toString(provenance)], char(31))))), 1, 32) AS row_id
FROM events_raw;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. VERIFY BEFORE STEP 4 — step 4 is the point of no easy return.
--
--    Raw row counts must match exactly (the copy is 1:1, no FINAL anywhere):
--      SELECT count() FROM metrics_raw;     SELECT count() FROM metrics_raw_v2;
--      SELECT count() FROM events_raw;      SELECT count() FROM events_raw_v2;
--
--    Every row must have a hash:
--      SELECT countIf(row_id = '') FROM metrics_raw_v2;  -- expect 0
--      SELECT countIf(row_id = '') FROM events_raw_v2;   -- expect 0
--
--    FINAL counts must be >= the old FINAL counts — this is the recovered
--    detail. They are equal only if nothing was ever collapsed:
--      SELECT count() FROM metrics_raw FINAL;   SELECT count() FROM metrics_raw_v2 FINAL;
--      SELECT count() FROM events_raw FINAL;    SELECT count() FROM events_raw_v2 FINAL;
--
--    Headline totals must not move (the rows that survive keep their values):
--      SELECT sum(value) FROM metrics_raw FINAL WHERE metric_name = 'claude_code.token.usage';
--      SELECT sum(value) FROM metrics_raw_v2 FINAL WHERE metric_name = 'claude_code.token.usage';
--      SELECT count() FROM events_raw FINAL WHERE event_name = 'claude_code.user_prompt';
--      SELECT count() FROM events_raw_v2 FINAL WHERE event_name = 'claude_code.user_prompt';
--    Both token sums and prompt counts may RISE if previously-collapsed rows
--    came back. They must never FALL.
-- ───────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────────────
-- 4. ATOMIC SWAP. A multi-table RENAME inside one database is atomic, so no
--    query ever sees a missing table. The old tables are KEPT as
--    *_old_2026_10 for rollback — drop them only after the new shape has run
--    in prod for a while (the runbook says when).
--
--    Run these two statements only after step 3 passes. They are commented out
--    on purpose: `clickhouse-client --multiquery < thisfile` applies steps 1-2
--    and stops, so the copy can be inspected before the swap.
-- ───────────────────────────────────────────────────────────────────────────

-- RENAME TABLE metrics_raw TO metrics_raw_old_2026_10, metrics_raw_v2 TO metrics_raw;
-- RENAME TABLE events_raw  TO events_raw_old_2026_10,  events_raw_v2  TO events_raw;

-- ROLLBACK (reverses step 4 exactly; the old tables are untouched by it):
-- RENAME TABLE metrics_raw TO metrics_raw_v2, metrics_raw_old_2026_10 TO metrics_raw;
-- RENAME TABLE events_raw  TO events_raw_v2,  events_raw_old_2026_10  TO events_raw;
-- ...then redeploy the previous app image, which does not write row_id.
