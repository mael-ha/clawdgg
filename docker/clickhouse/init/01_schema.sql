-- ═══════════════════════════════════════════════════════════════════════════
-- clawd.gg ClickHouse Schema
-- Stores OpenTelemetry metrics and events from Claude Code
--
-- ARCHITECTURE:
-- - Raw tables use ReplacingMergeTree for deduplication (handles OTEL retries)
-- - All aggregation happens at query time using FINAL clause
-- - No materialized views - simpler, more reliable, guaranteed accurate
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
    tool String DEFAULT '',       -- Edit, Write, NotebookEdit
    decision String DEFAULT '',   -- accept, reject
    language String DEFAULT '',   -- TypeScript, Python, etc.
    -- Resource attributes
    terminal_type String DEFAULT '',
    app_version String DEFAULT '',
    account_uuid String DEFAULT ''
) ENGINE = ReplacingMergeTree()
-- CRITICAL: line_type must be in ORDER BY to prevent deduplication of added/removed rows
-- Note: session_id removed from ORDER BY for better query performance (not needed for dedup)
ORDER BY (user_id, metric_name, token_type, line_type, timestamp)
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
    -- tool_result / tool_decision attributes
    decision String DEFAULT '',        -- accept, reject
    source String DEFAULT '',          -- config, user_permanent, user_temporary, user_abort, user_reject
    tool_parameters String DEFAULT ''  -- JSON string with tool-specific params (bash_command, etc.)
) ENGINE = ReplacingMergeTree()
ORDER BY (user_id, session_id, event_name, timestamp, tool_name)
PARTITION BY toYYYYMM(timestamp)
TTL toDateTime(timestamp) + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;
