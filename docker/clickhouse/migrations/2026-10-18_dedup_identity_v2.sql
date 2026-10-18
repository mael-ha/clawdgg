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
-- NO TTL ON THE NEW TABLES
-- The old tables carry `TTL toDateTime(timestamp) + INTERVAL 365 DAY`, which
-- silently deletes a user's first year the moment it turns 366 days old. The
-- v2 tables have no TTL at all: this is a usage history, and the whole point
-- of the daily_stats import is to make it reach further back, not less far.
-- Step 0 of the runbook removes the TTL from the OLD tables too, so nothing
-- expires in the window between the copy and the swap.
--
-- RUN ORDER: step 1 of README-2026-10.md adds `row_id` and every new identity
-- column to the CURRENT tables first, so the new app can write to them while
-- this copy runs. This file is step 3. Full ordered runbook, with the backups
-- and the catch-up: docker/clickhouse/migrations/README-2026-10.md
--
-- THE COPY IS RESUMABLE AND RE-RUNNABLE. `if(row_id != '', row_id, <expr>)`
-- keeps the hash the app already computed for a row and only computes one for
-- the rows written before the new app was deployed. Re-running it re-copies
-- rows that are already there, and they collapse under FINAL because they
-- carry the same row_id — so the step-4 catch-up is just this file again with
-- a timestamp filter.
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
    time_type String DEFAULT '',
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
    marketplace_name String DEFAULT '',
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
    time_type,
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
    marketplace_name,
    mcp_server_name,
    mcp_tool_name,
    start_type,
    terminal_type,
    app_version,
    account_uuid,
    organization_id,
    provenance,
    pricing_source,
    if(row_id != '', row_id, substring(lower(hex(SHA256(arrayStringConcat([toString(timestamp), toString(user_id), toString(session_id), toString(metric_name), toString(model), toString(token_type), toString(line_type), toString(time_type), toString(tool), toString(decision), toString(language), toString(source), toString(query_source), toString(speed), toString(effort), toString(agent_name), toString(skill_name), toString(plugin_name), toString(marketplace_name), toString(mcp_server_name), toString(mcp_tool_name), toString(start_type), toString(terminal_type), toString(app_version), toString(account_uuid), toString(organization_id), toString(provenance)], char(31))))), 1, 32)) AS row_id
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
    error_type String DEFAULT '',
    status_code UInt16 DEFAULT 0,
    duration_ms UInt32 DEFAULT 0,
    decision String DEFAULT '',
    source String DEFAULT '',
    tool_use_id String DEFAULT '',
    tool_source String DEFAULT '',
    prompt_id String DEFAULT '',
    request_id String DEFAULT '',
    client_request_id String DEFAULT '',
    message_uuid String DEFAULT '',
    event_sequence Int64 DEFAULT -1,
    query_source String DEFAULT '',
    speed String DEFAULT '',
    effort String DEFAULT '',
    agent_name String DEFAULT '',
    skill_name String DEFAULT '',
    marketplace_name String DEFAULT '',
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
    error_type,
    status_code,
    duration_ms,
    decision,
    source,
    tool_use_id,
    tool_source,
    prompt_id,
    request_id,
    client_request_id,
    message_uuid,
    event_sequence,
    query_source,
    speed,
    effort,
    agent_name,
    skill_name,
    marketplace_name,
    command_name,
    command_source,
    terminal_type,
    app_version,
    account_uuid,
    organization_id,
    provenance,
    pricing_source,
    if(row_id != '', row_id, substring(lower(hex(SHA256(arrayStringConcat([toString(timestamp), toString(user_id), toString(session_id), toString(event_name), toString(event_sequence), toString(tool_name), toString(tool_use_id), toString(tool_source), toString(model), toString(decision), toString(source), toString(request_id), toString(client_request_id), toString(prompt_id), toString(message_uuid), toString(command_name), toString(command_source), toString(query_source), toString(speed), toString(effort), toString(agent_name), toString(skill_name), toString(marketplace_name), toString(status_code), toString(error_type), toString(error_message), toString(provenance)], char(31))))), 1, 32)) AS row_id
FROM events_raw;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. VERIFY BEFORE THE SWAP — see README-2026-10.md step 3 for the full set.
--
--    Raw row counts: v2 >= old (the copy is 1:1, and the app keeps inserting
--    into the old tables while it runs, so v2 can only be behind, never ahead):
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
--    Headline totals must not FALL (they may rise, as collapsed rows come back):
--      SELECT sum(value) FROM metrics_raw FINAL WHERE metric_name = 'claude_code.token.usage';
--      SELECT sum(value) FROM metrics_raw_v2 FINAL WHERE metric_name = 'claude_code.token.usage';
--      SELECT count() FROM events_raw FINAL WHERE event_name = 'claude_code.user_prompt' AND command_source != 'builtin';
--      SELECT count() FROM events_raw_v2 FINAL WHERE event_name = 'claude_code.user_prompt' AND command_source != 'builtin';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. SWAP, WITHOUT STOPPING THE APP.
--
-- EXCHANGE TABLES swaps two names atomically, in one statement, per pair. No
-- query and no insert ever sees a missing table, so the app stays up and no
-- OTLP batch is refused. That matters more than it sounds: the OTel exporter
-- DROPS a batch it cannot deliver, and metrics are delta temporality, so a
-- batch refused during a maintenance window is gone — not resent. Stopping
-- the app to swap would lose exactly the data this migration exists to protect.
--
-- RENAME would need the old name free and would leave a gap between the two
-- statements. EXCHANGE has neither problem.
-- ───────────────────────────────────────────────────────────────────────────

-- EXCHANGE TABLES metrics_raw AND metrics_raw_v2;
-- EXCHANGE TABLES events_raw  AND events_raw_v2;

-- After the exchange the names have traded places: `metrics_raw` is the v2
-- shape the app now writes to, and `metrics_raw_v2` holds the OLD rows —
-- including everything inserted into the old table between the copy and the
-- exchange. Catch those up. Same expression, so it is idempotent: a row
-- already present carries the same row_id and collapses under FINAL.
--
-- The column lists are explicit because the two tables no longer have the same
-- shape (the old one still has tool_parameters, which is deliberately not
-- copied — see 2026-10-18_add_otel_attributes.sql).

-- INSERT INTO metrics_raw (timestamp, user_id, session_id, metric_name, value, model,
--     token_type, line_type, time_type, tool, decision, language, source, query_source,
--     speed, effort, agent_name, skill_name, plugin_name, marketplace_name,
--     mcp_server_name, mcp_tool_name, start_type, terminal_type, app_version,
--     account_uuid, organization_id, provenance, pricing_source, row_id)
-- SELECT timestamp, user_id, session_id, metric_name, value, model,
--     token_type, line_type, time_type, tool, decision, language, source, query_source,
--     speed, effort, agent_name, skill_name, plugin_name, marketplace_name,
--     mcp_server_name, mcp_tool_name, start_type, terminal_type, app_version,
--     account_uuid, organization_id, provenance, pricing_source,
--     if(row_id != '', row_id, substring(lower(hex(SHA256(arrayStringConcat([toString(timestamp), toString(user_id), toString(session_id), toString(metric_name), toString(model), toString(token_type), toString(line_type), toString(time_type), toString(tool), toString(decision), toString(language), toString(source), toString(query_source), toString(speed), toString(effort), toString(agent_name), toString(skill_name), toString(plugin_name), toString(marketplace_name), toString(mcp_server_name), toString(mcp_tool_name), toString(start_type), toString(terminal_type), toString(app_version), toString(account_uuid), toString(organization_id), toString(provenance)], char(31))))), 1, 32))
-- FROM metrics_raw_v2
-- WHERE timestamp >= toDateTime64({watermark:String}, 3);

-- INSERT INTO events_raw (timestamp, user_id, session_id, event_name, prompt_length,
--     tool_name, tool_success, tool_duration_ms, model, cost_usd, input_tokens,
--     output_tokens, cache_read_tokens, cache_write_tokens, error_message, error_type,
--     status_code, duration_ms, decision, source, tool_use_id, tool_source, prompt_id,
--     request_id, client_request_id, message_uuid, event_sequence, query_source, speed,
--     effort, agent_name, skill_name, marketplace_name, command_name, command_source,
--     terminal_type, app_version, account_uuid, organization_id, provenance,
--     pricing_source, row_id)
-- SELECT timestamp, user_id, session_id, event_name, prompt_length,
--     tool_name, tool_success, tool_duration_ms, model, cost_usd, input_tokens,
--     output_tokens, cache_read_tokens, cache_write_tokens, error_message, error_type,
--     status_code, duration_ms, decision, source, tool_use_id, tool_source, prompt_id,
--     request_id, client_request_id, message_uuid, event_sequence, query_source, speed,
--     effort, agent_name, skill_name, marketplace_name, command_name, command_source,
--     terminal_type, app_version, account_uuid, organization_id, provenance,
--     pricing_source,
--     if(row_id != '', row_id, substring(lower(hex(SHA256(arrayStringConcat([toString(timestamp), toString(user_id), toString(session_id), toString(event_name), toString(event_sequence), toString(tool_name), toString(tool_use_id), toString(tool_source), toString(model), toString(decision), toString(source), toString(request_id), toString(client_request_id), toString(prompt_id), toString(message_uuid), toString(command_name), toString(command_source), toString(query_source), toString(speed), toString(effort), toString(agent_name), toString(skill_name), toString(marketplace_name), toString(status_code), toString(error_type), toString(error_message), toString(provenance)], char(31))))), 1, 32))
-- FROM events_raw_v2
-- WHERE timestamp >= toDateTime64({watermark:String}, 3);

-- ROLLBACK: exchange back, then catch up the other way. The old tables are
-- never modified by the forward path, so this is a true reversal.
--
-- EXCHANGE TABLES metrics_raw AND metrics_raw_v2;
-- EXCHANGE TABLES events_raw  AND events_raw_v2;
--
-- ...then copy the rows the new app wrote while the v2 shape was live back into
-- the old tables (they now answer to *_v2 again). Only the columns the OLD
-- shape has — row_id included, since step 1 added it there:
--
-- INSERT INTO metrics_raw (timestamp, user_id, session_id, metric_name, value, model,
--     token_type, line_type, time_type, tool, decision, language, source, query_source,
--     speed, effort, agent_name, skill_name, plugin_name, marketplace_name,
--     mcp_server_name, mcp_tool_name, start_type, terminal_type, app_version,
--     account_uuid, organization_id, provenance, pricing_source, row_id)
-- SELECT timestamp, user_id, session_id, metric_name, value, model,
--     token_type, line_type, time_type, tool, decision, language, source, query_source,
--     speed, effort, agent_name, skill_name, plugin_name, marketplace_name,
--     mcp_server_name, mcp_tool_name, start_type, terminal_type, app_version,
--     account_uuid, organization_id, provenance, pricing_source, row_id
-- FROM metrics_raw_v2 WHERE timestamp >= toDateTime64({watermark:String}, 3);
--
-- (and the same for events_raw / events_raw_v2)
--
-- Then redeploy the previous app image. It does not write the new columns, and
-- the old tables tolerate that: every one of them has a DEFAULT.
