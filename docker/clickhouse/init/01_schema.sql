-- ═══════════════════════════════════════════════════════════════════════════
-- clawd.gg ClickHouse Schema
-- Stores OpenTelemetry metrics and events from Claude Code
--
-- ARCHITECTURE:
-- - Raw tables use ReplacingMergeTree for deduplication (handles OTEL retries)
-- - All aggregation happens at query time using FINAL clause
-- - No materialized views - simpler, more reliable, guaranteed accurate
--
-- DEDUPLICATION: every sorting key ends in `row_id`, a SHA-256 of all of the
-- row's IDENTIFYING fields (not its value) computed at insert time by
-- metricRowId()/eventRowId() in src/db/clickhouse.ts. An OTLP retry of the same
-- datapoint hashes identically and still collapses; two genuinely different
-- datapoints that share a timestamp (main vs subagent token usage, two models
-- in the same export interval) now differ and both survive. Changing the field
-- list means re-hashing every existing row — see
-- docker/clickhouse/migrations/2026-10-18_dedup_identity_v2.sql.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS clawd;

USE clawd;

-- ═══════════════════════════════════════════════════════════════════════════
-- RAW TABLES (ReplacingMergeTree for deduplication)
-- ═══════════════════════════════════════════════════════════════════════════

-- Raw metrics from OTel (token usage, cost, lines of code, etc.)
-- ReplacingMergeTree deduplicates rows with same ORDER BY key on merge
CREATE TABLE IF NOT EXISTS metrics_raw (
    timestamp DateTime64(3),
    user_id String,
    session_id String,
    metric_name String,
    value Float64,
    -- Dimension attributes
    model String DEFAULT '',
    token_type String DEFAULT '',
    line_type String DEFAULT '',
    -- code_edit_tool.decision attributes
    tool String DEFAULT '',       -- Edit, Write, NotebookEdit (OTEL attr `tool_name`)
    decision String DEFAULT '',   -- accept, reject
    language String DEFAULT '',   -- TypeScript, Python, etc.
    source String DEFAULT '',     -- config, user_permanent, … (code_edit_tool.decision)
    -- Attribution attributes on cost.usage / token.usage.
    -- query_source is main vs subagent vs auxiliary: without it a subagent's
    -- tokens are indistinguishable from main-thread tokens.
    query_source String DEFAULT '',     -- main | subagent | auxiliary
    speed String DEFAULT '',            -- fast | normal
    effort String DEFAULT '',           -- low | medium | high | xhigh | max
    agent_name String DEFAULT '',       -- OTEL attr `agent.name`
    skill_name String DEFAULT '',       -- OTEL attr `skill.name`
    plugin_name String DEFAULT '',      -- OTEL attr `plugin.name`
    mcp_server_name String DEFAULT '',  -- OTEL attr `mcp_server.name`
    mcp_tool_name String DEFAULT '',    -- OTEL attr `mcp_tool.name`
    -- session.count attribute
    start_type String DEFAULT '',       -- fresh | resume | continue | agents_view
    -- Standard attributes. Claude Code sends these per-datapoint; older
    -- exporters put them on the resource block. Both are read (src/routes/otel.ts).
    terminal_type String DEFAULT '',
    app_version String DEFAULT '',
    account_uuid String DEFAULT '',
    organization_id String DEFAULT '',
    -- Provenance: 'live' for OTLP-received, 'backfill' for JSONL-reconstructed.
    -- Distinct from `source` (which captures the OTEL source attribute meaning).
    provenance String DEFAULT 'live',
    -- How the model id matched the price table behind an ESTIMATED cost:
    -- 'exact' | 'normalized' | 'family' | 'fallback' (see src/lib/pricing.ts).
    -- Empty means no price table was consulted — live OTLP rows carry Claude
    -- Code's own measured cost, and token metrics carry no cost at all.
    pricing_source String DEFAULT '',
    -- Per-row identity hash — see DEDUPLICATION above. Never empty on a row
    -- written through insertMetrics().
    row_id String DEFAULT ''
) ENGINE = ReplacingMergeTree()
-- CRITICAL: row_id is what actually keeps distinct datapoints apart. token_type
-- and line_type stay in the key for scan locality; they are redundant for dedup.
ORDER BY (user_id, metric_name, token_type, line_type, timestamp, row_id)
PARTITION BY toYYYYMM(timestamp)
TTL toDateTime(timestamp) + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

-- Raw events from OTel (user_prompt, tool_result, api_request, etc.)
-- ReplacingMergeTree deduplicates rows with same ORDER BY key on merge
CREATE TABLE IF NOT EXISTS events_raw (
    timestamp DateTime64(3),
    user_id String,
    session_id String,
    event_name String,
    -- Event-specific attributes
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
    -- tool_result / tool_decision attributes. tool_result renamed these to
    -- `decision_type` / `decision_source`; tool_decision still sends the old
    -- names. src/routes/otel.ts reads new-then-old into these columns.
    decision String DEFAULT '',        -- accept, reject
    source String DEFAULT '',          -- config, user_permanent, user_temporary, user_abort, user_reject
    tool_parameters String DEFAULT '', -- JSON string with tool-specific params (bash_command, etc.)
    tool_use_id String DEFAULT '',
    -- Correlation + attribution. prompt_id (OTEL `prompt.id`) joins a prompt to
    -- the api_request calls it caused.
    prompt_id String DEFAULT '',
    request_id String DEFAULT '',
    query_source String DEFAULT '',    -- main | subagent | auxiliary
    speed String DEFAULT '',
    effort String DEFAULT '',
    agent_name String DEFAULT '',      -- OTEL attr `agent.name`
    skill_name String DEFAULT '',      -- OTEL attr `skill.name`
    -- user_prompt slash-command attribution (Claude Code 2.1.117+).
    -- command_source = 'builtin' (/clear, /compact, /model, …) is a UI action,
    -- not a prompt — excluded from prompt counts (see PROMPT_EVENT_SQL).
    command_name String DEFAULT '',
    command_source String DEFAULT '',  -- builtin | custom | mcp
    -- Standard attributes (per-record, resource fallback)
    terminal_type String DEFAULT '',
    app_version String DEFAULT '',
    account_uuid String DEFAULT '',
    organization_id String DEFAULT '',
    -- Provenance: 'live' for OTLP-received, 'backfill' for JSONL-reconstructed.
    -- Distinct from `source` above (which captures the OTEL source attribute).
    provenance String DEFAULT 'live',
    -- How the model id matched the price table behind cost_usd when that cost
    -- was ESTIMATED: 'exact' | 'normalized' | 'family' | 'fallback'
    -- (see src/lib/pricing.ts). Empty means no price table was consulted —
    -- live OTLP rows carry Claude Code's own measured cost_usd.
    pricing_source String DEFAULT '',
    -- Per-row identity hash — see DEDUPLICATION above. Never empty on a row
    -- written through insertEvents().
    row_id String DEFAULT ''
) ENGINE = ReplacingMergeTree()
-- row_id is what keeps two tool_results in the same millisecond apart.
ORDER BY (user_id, session_id, event_name, timestamp, tool_name, row_id)
PARTITION BY toYYYYMM(timestamp)
TTL toDateTime(timestamp) + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;
