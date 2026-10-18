-- ═══════════════════════════════════════════════════════════════════════════
-- Forward migration: capture the attributes current Claude Code actually sends.
--
-- Verified against https://code.claude.com/docs/en/monitoring-usage on
-- 2026-10-18 (Claude Code 2.1.30x). Three classes of change:
--
--  1. Renamed attributes we were reading under the old name, so the column was
--     silently empty:
--       - claude_code.code_edit_tool.decision: `tool` -> `tool_name`
--         (kept in the existing `tool` column) and `source` (never read at all,
--         hence the new metrics_raw.source column).
--       - claude_code.tool_result: `decision` -> `decision_type`,
--         `source` -> `decision_source` (kept in the existing columns;
--         claude_code.tool_decision still sends the old names).
--
--  2. Standard attributes read from the wrong place. session.id, app.version,
--     terminal.type, user.account_uuid and organization.id are documented as
--     per-datapoint / per-log-record attributes; the resource block carries
--     service.name, service.version, os.* and host.*. src/routes/otel.ts now
--     reads the datapoint first and falls back to the resource block.
--     organization_id is new on both tables.
--
--  3. New high-value attributes. The important one is `query_source`
--     (main | subagent | auxiliary): without it a subagent's tokens and cost
--     are indistinguishable from main-thread ones. `command_source` on
--     user_prompt is what makes the prompt count honest — since 2.1.117 slash
--     commands emit user_prompt too, and the builtin ones (/clear, /compact,
--     /model, ...) are UI actions rather than prompts.
--
-- NOT added, because the current docs do not define them: `agent_id`,
-- `parent_agent_id`, `cache_creation_5m_tokens`, `cache_creation_1h_tokens`.
-- Subagent attribution is `agent.name` + `query_source`; api_request reports a
-- single `cache_creation_tokens` with no TTL split. Do not add columns for
-- attributes that are not emitted — an always-empty column is a trap for the
-- next reader.
--
-- Prompt text is deliberately NOT captured: no column exists for `prompt` or
-- `prompt_text`, and src/routes/otel.ts never reads them.
--
-- Backwards compatible: DEFAULT '' backfills existing rows, the ORDER BY key is
-- untouched (no ReplacingMergeTree dedup impact — that is the NEXT migration,
-- 2026-10-18_dedup_identity_v2.sql), and every read path selects named columns.
--
-- Apply (NOT run automatically — do it deliberately):
--   ssh clawdgg 'docker compose -f /opt/clawdgg/docker-compose.staging.yml \
--     exec -T clickhouse clickhouse-client --multiquery' \
--     < docker/clickhouse/migrations/2026-10-18_add_otel_attributes.sql
--
-- Verify:
--   SELECT name FROM system.columns
--    WHERE database = 'clawd' AND table IN ('metrics_raw', 'events_raw')
--    ORDER BY table, position;
-- ═══════════════════════════════════════════════════════════════════════════

USE clawd;

-- ── metrics_raw ───────────────────────────────────────────────────────────

-- code_edit_tool.decision `source` — dropped entirely until now.
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS source String DEFAULT '' AFTER language;

-- Attribution attributes on cost.usage / token.usage.
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS query_source String DEFAULT '' AFTER source;
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS speed String DEFAULT '' AFTER query_source;
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS effort String DEFAULT '' AFTER speed;
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS agent_name String DEFAULT '' AFTER effort;
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS skill_name String DEFAULT '' AFTER agent_name;
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS plugin_name String DEFAULT '' AFTER skill_name;
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS mcp_server_name String DEFAULT '' AFTER plugin_name;
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS mcp_tool_name String DEFAULT '' AFTER mcp_server_name;

-- session.count attribute.
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS start_type String DEFAULT '' AFTER mcp_tool_name;

-- Standard attribute we never captured.
ALTER TABLE metrics_raw
    ADD COLUMN IF NOT EXISTS organization_id String DEFAULT '' AFTER account_uuid;

-- ── events_raw ────────────────────────────────────────────────────────────

ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS tool_use_id String DEFAULT '' AFTER tool_parameters;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS prompt_id String DEFAULT '' AFTER tool_use_id;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS request_id String DEFAULT '' AFTER prompt_id;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS query_source String DEFAULT '' AFTER request_id;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS speed String DEFAULT '' AFTER query_source;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS effort String DEFAULT '' AFTER speed;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS agent_name String DEFAULT '' AFTER effort;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS skill_name String DEFAULT '' AFTER agent_name;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS command_name String DEFAULT '' AFTER skill_name;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS command_source String DEFAULT '' AFTER command_name;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS terminal_type String DEFAULT '' AFTER command_source;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS app_version String DEFAULT '' AFTER terminal_type;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS account_uuid String DEFAULT '' AFTER app_version;
ALTER TABLE events_raw
    ADD COLUMN IF NOT EXISTS organization_id String DEFAULT '' AFTER account_uuid;
