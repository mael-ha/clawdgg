-- ═══════════════════════════════════════════════════════════════════════════
-- clawd.gg ClickHouse Schema
-- Stores OpenTelemetry metrics and events from Claude Code
-- ═══════════════════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS clawd;

USE clawd;

-- ═══════════════════════════════════════════════════════════════════════════
-- RAW TABLES (7-day retention for debugging)
-- ═══════════════════════════════════════════════════════════════════════════

-- Raw metrics from OTel (token usage, cost, lines of code, etc.)
CREATE TABLE IF NOT EXISTS metrics_raw (
    timestamp DateTime64(3),
    user_id String,                    -- Our user ID (from bearer token)
    session_id String,
    metric_name String,                -- e.g., 'claude_code.token.usage'
    value Float64,
    -- Dimension attributes
    model String DEFAULT '',           -- e.g., 'claude-sonnet-4-5-20250929'
    token_type String DEFAULT '',      -- 'input', 'output', 'cacheRead', 'cacheCreation'
    line_type String DEFAULT '',       -- 'added', 'removed'
    -- Resource attributes
    terminal_type String DEFAULT '',
    app_version String DEFAULT '',
    account_uuid String DEFAULT ''     -- Anthropic account UUID (optional)
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (user_id, metric_name, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY  -- Keep raw data 90 days during launch (can reduce later)
SETTINGS index_granularity = 8192;

-- Raw events from OTel (user_prompt, tool_result, api_request, etc.)
CREATE TABLE IF NOT EXISTS events_raw (
    timestamp DateTime64(3),
    user_id String,
    session_id String,
    event_name String,                 -- 'user_prompt', 'tool_result', etc.
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
    duration_ms UInt32 DEFAULT 0
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (user_id, event_name, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY  -- Keep raw data 90 days during launch (can reduce later)
SETTINGS index_granularity = 8192;


-- ═══════════════════════════════════════════════════════════════════════════
-- AGGREGATED TABLES (Long retention)
-- Using regular tables + INSERT queries instead of materialized views
-- for more control over aggregation logic
-- ═══════════════════════════════════════════════════════════════════════════

-- Daily aggregates - FOREVER (for contribution graph, leaderboard)
CREATE TABLE IF NOT EXISTS metrics_daily (
    user_id String,
    date Date,

    -- Token breakdown
    input_tokens UInt64 DEFAULT 0,
    output_tokens UInt64 DEFAULT 0,
    cache_read_tokens UInt64 DEFAULT 0,
    cache_write_tokens UInt64 DEFAULT 0,

    -- Cost
    cost_usd Float64 DEFAULT 0,

    -- Code
    lines_added UInt64 DEFAULT 0,
    lines_removed UInt64 DEFAULT 0,
    commits UInt64 DEFAULT 0,
    prs UInt64 DEFAULT 0,

    -- Activity
    sessions UInt64 DEFAULT 0,
    active_seconds UInt64 DEFAULT 0
) ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (user_id, date)
SETTINGS index_granularity = 8192;

-- Hourly aggregates - 90 days (for activity heatmap)
CREATE TABLE IF NOT EXISTS metrics_hourly (
    user_id String,
    hour DateTime,

    -- Simplified activity metric
    total_tokens UInt64 DEFAULT 0,
    total_cost Float64 DEFAULT 0,
    data_points UInt64 DEFAULT 0
) ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (user_id, hour)
TTL hour + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Model usage daily - FOREVER (for Claude Diet)
CREATE TABLE IF NOT EXISTS model_usage_daily (
    user_id String,
    date Date,
    model String,

    input_tokens UInt64 DEFAULT 0,
    output_tokens UInt64 DEFAULT 0,
    cost_usd Float64 DEFAULT 0
) ENGINE = SummingMergeTree()
ORDER BY (user_id, date, model)
SETTINGS index_granularity = 8192;

-- Prompt stats daily - FOREVER (from events)
CREATE TABLE IF NOT EXISTS prompt_stats_daily (
    user_id String,
    date Date,

    prompt_count UInt64 DEFAULT 0,
    total_prompt_chars UInt64 DEFAULT 0,
    tool_calls UInt64 DEFAULT 0,
    tool_successes UInt64 DEFAULT 0
) ENGINE = SummingMergeTree()
ORDER BY (user_id, date)
SETTINGS index_granularity = 8192;


-- ═══════════════════════════════════════════════════════════════════════════
-- MATERIALIZED VIEWS for automatic aggregation
-- ═══════════════════════════════════════════════════════════════════════════

-- Auto-aggregate metrics to daily
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_daily
TO metrics_daily
AS SELECT
    user_id,
    toDate(timestamp) as date,

    sumIf(toUInt64(value), metric_name = 'claude_code.token.usage' AND token_type = 'input') as input_tokens,
    sumIf(toUInt64(value), metric_name = 'claude_code.token.usage' AND token_type = 'output') as output_tokens,
    sumIf(toUInt64(value), metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead') as cache_read_tokens,
    sumIf(toUInt64(value), metric_name = 'claude_code.token.usage' AND token_type = 'cacheCreation') as cache_write_tokens,

    sumIf(value, metric_name = 'claude_code.cost.usage') as cost_usd,

    sumIf(toUInt64(value), metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as lines_added,
    sumIf(toUInt64(value), metric_name = 'claude_code.lines_of_code.count' AND line_type = 'removed') as lines_removed,
    sumIf(toUInt64(value), metric_name = 'claude_code.commit.count') as commits,
    sumIf(toUInt64(value), metric_name = 'claude_code.pull_request.count') as prs,

    sumIf(toUInt64(value), metric_name = 'claude_code.session.count') as sessions,
    sumIf(toUInt64(value), metric_name = 'claude_code.active_time.total') as active_seconds
FROM metrics_raw
GROUP BY user_id, date;

-- Auto-aggregate metrics to hourly
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_hourly
TO metrics_hourly
AS SELECT
    user_id,
    toStartOfHour(timestamp) as hour,
    sumIf(toUInt64(value), metric_name = 'claude_code.token.usage') as total_tokens,
    sumIf(value, metric_name = 'claude_code.cost.usage') as total_cost,
    count() as data_points
FROM metrics_raw
GROUP BY user_id, hour;

-- Auto-aggregate model usage
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_model_usage_daily
TO model_usage_daily
AS SELECT
    user_id,
    toDate(timestamp) as date,
    model,
    sumIf(toUInt64(value), metric_name = 'claude_code.token.usage' AND token_type = 'input') as input_tokens,
    sumIf(toUInt64(value), metric_name = 'claude_code.token.usage' AND token_type = 'output') as output_tokens,
    sumIf(value, metric_name = 'claude_code.cost.usage') as cost_usd
FROM metrics_raw
WHERE model != ''
GROUP BY user_id, date, model;

-- Auto-aggregate prompt stats from events
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_prompt_stats_daily
TO prompt_stats_daily
AS SELECT
    user_id,
    toDate(timestamp) as date,
    countIf(event_name = 'claude_code.user_prompt') as prompt_count,
    sumIf(prompt_length, event_name = 'claude_code.user_prompt') as total_prompt_chars,
    countIf(event_name = 'claude_code.tool_result') as tool_calls,
    countIf(event_name = 'claude_code.tool_result' AND tool_success = 1) as tool_successes
FROM events_raw
GROUP BY user_id, date;
