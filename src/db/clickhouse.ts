/**
 * ClickHouse client for clawd.gg
 * Handles all OTel metrics and events storage/retrieval
 *
 * ARCHITECTURE:
 * - Raw tables use ReplacingMergeTree for deduplication
 * - All queries use FINAL to get deduplicated results
 * - No materialized views - aggregation happens at query time
 *
 * OTEL NAMING CONVENTION (from Claude Code):
 * Events:
 *   - claude_code.user_prompt  = User submits a prompt (has prompt_length)
 *   - claude_code.api_request  = Each LLM API call (includes tool continuations)
 *   - claude_code.tool_result  = Tool execution result
 *   - claude_code.tool_decision = Tool permission decision
 *
 * IMPORTANT: Use user_prompt for "prompts" metric, NOT api_request!
 * api_request includes tool continuation calls (1 user prompt → 20+ api_request)
 *
 * Metrics:
 *   - claude_code.token.usage (with token_type: input/output/cacheRead/cacheCreation)
 *   - claude_code.cost.usage
 *   - claude_code.active_time.total
 *   - claude_code.lines_of_code.count (with line_type: added/removed)
 *   - claude_code.commit.count
 *   - claude_code.pull_request.count
 *   - claude_code.session.count
 */

import { createHash } from 'node:crypto';
import { db } from './index';
import { getModelPricing } from '../lib/pricing';
import { bucketDailyRows, bucketLabel, bucketSql, type ChartGroupBy } from '../lib/chart-buckets';
import { dailyStats } from './schema';
import { eq, and, gte, lte, asc, desc } from 'drizzle-orm';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || 'clawd';

interface ClickHouseResponse {
  data: any[];
  rows: number;
  statistics?: {
    elapsed: number;
    rows_read: number;
    bytes_read: number;
  };
}

/**
 * Execute a ClickHouse query
 */
export async function query<T = any>(sql: string, params?: Record<string, any>): Promise<T[]> {
  const url = new URL(CLICKHOUSE_URL);
  url.searchParams.set('database', CLICKHOUSE_DATABASE);
  url.searchParams.set('default_format', 'JSONEachRow');
  // Return numbers as actual JSON numbers, not quoted strings
  url.searchParams.set('output_format_json_quote_64bit_integers', '0');

  // Add parameters if provided
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(`param_${key}`, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    body: sql,
    headers: {
      'Content-Type': 'text/plain',
    },
    signal: AbortSignal.timeout(10000), // 10 second timeout
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ClickHouse] Query failed:', { sql: sql.slice(0, 200), error: errorText });
    throw new Error('Database query failed');
  }

  const text = await response.text();
  if (!text.trim()) return [];

  // Parse JSONEachRow format (one JSON object per line)
  return text.trim().split('\n').map(line => JSON.parse(line)) as T[];
}

/**
 * Insert rows into a ClickHouse table
 */
export async function insert(table: string, rows: Record<string, any>[]): Promise<void> {
  if (rows.length === 0) return;

  const url = new URL(CLICKHOUSE_URL);
  url.searchParams.set('database', CLICKHOUSE_DATABASE);
  url.searchParams.set('query', `INSERT INTO ${table} FORMAT JSONEachRow`);

  const body = rows.map(row => JSON.stringify(row)).join('\n');

  const response = await fetch(url.toString(), {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30000), // 30 second timeout for inserts (larger payloads)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ClickHouse] Insert failed:', { table, rows: rows.length, error: errorText });
    throw new Error('Database insert failed');
  }
}

/**
 * Check if ClickHouse is healthy
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await query<{ result: number }>('SELECT 1 as result');
    return result.length === 1 && result[0]?.result === 1;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Metric Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where a raw row came from.
 *   live     — received over OTLP from a running Claude Code (default)
 *   backfill — reconstructed from local Claude Code JSONL transcripts
 */
export type RowProvenance = 'live' | 'backfill';

export interface MetricRow {
  timestamp: string;
  user_id: string;
  session_id: string;
  metric_name: string;
  value: number;
  model?: string;
  token_type?: string;
  line_type?: string;
  terminal_type?: string;
  app_version?: string;
  account_uuid?: string;
  organization_id?: string;
  // code_edit_tool.decision attributes
  tool?: string;       // Edit, Write, NotebookEdit (OTEL attribute `tool_name`)
  decision?: string;   // accept, reject
  language?: string;   // TypeScript, Python, etc.
  source?: string;     // config, user_permanent, … (code_edit_tool.decision)
  // Attribution attributes on cost.usage / token.usage
  query_source?: string;     // main | subagent | auxiliary
  speed?: string;            // fast | normal
  effort?: string;           // low | medium | high | xhigh | max
  agent_name?: string;
  skill_name?: string;
  plugin_name?: string;
  mcp_server_name?: string;
  mcp_tool_name?: string;
  start_type?: string;       // session.count: fresh | resume | continue | agents_view
  provenance?: RowProvenance;
  /**
   * Deterministic per-row identity (see metricRowId). Part of the
   * ReplacingMergeTree sorting key — leave it unset and insertMetrics fills it.
   */
  row_id?: string;
}

export interface EventRow {
  timestamp: string;
  user_id: string;
  session_id: string;
  event_name: string;
  prompt_length?: number;
  tool_name?: string;
  tool_success?: number;
  tool_duration_ms?: number;
  model?: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  error_message?: string;
  status_code?: number;
  duration_ms?: number;
  // tool_result / tool_decision attributes
  decision?: string;        // accept, reject (OTEL `decision_type` on tool_result)
  source?: string;          // config, user_permanent, … (OTEL `decision_source` on tool_result)
  tool_parameters?: string; // JSON string with tool-specific params
  tool_use_id?: string;
  // Correlation + attribution
  prompt_id?: string;       // OTEL `prompt.id` — joins a prompt to its api_request calls
  request_id?: string;
  query_source?: string;    // main | subagent | auxiliary
  speed?: string;
  effort?: string;
  agent_name?: string;
  skill_name?: string;
  // user_prompt slash-command attribution (Claude Code 2.1.117+)
  command_name?: string;
  command_source?: string;  // builtin | custom | mcp
  terminal_type?: string;
  app_version?: string;
  account_uuid?: string;
  organization_id?: string;
  provenance?: RowProvenance;
  /**
   * Deterministic per-row identity (see eventRowId). Part of the
   * ReplacingMergeTree sorting key — leave it unset and insertEvents fills it.
   */
  row_id?: string;
}

export interface DailyMetrics {
  user_id: string;
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  lines_added: number;
  lines_removed: number;
  commits: number;
  prs: number;
  sessions: number;
  active_seconds: number;
  prompts: number;
}

export interface UserTotals {
  user_id: string;
  total_prompts: number;
  total_tokens: number;
  // Token breakdown (for TokenOrbit visualization)
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_cost_usd: number;
  total_lines_added: number;
  total_commits: number;
  total_prs: number;
  total_active_seconds: number;
  avg_prompt_length: number;
}

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface HourlyActivity {
  hour: number; // 0-23
  day_of_week: number; // 0-6 (Sun-Sat)
  activity: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Row Identity (ReplacingMergeTree dedup key)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `row_id` is a deterministic hash of everything that IDENTIFIES a row, and of
 * nothing that merely measures it.
 *
 * Why it exists: ReplacingMergeTree collapses rows that share the sorting key,
 * and every read uses FINAL. The old keys were
 *   metrics_raw (user_id, metric_name, token_type, line_type, timestamp)
 *   events_raw  (user_id, session_id, event_name, timestamp, tool_name)
 * but Claude Code emits several datapoints with the SAME timestamp that differ
 * only by model, query_source, speed, effort, agent/skill/plugin/mcp name, or
 * tool/decision/language. Those collapsed into one row and their values were
 * lost — main-thread and subagent token usage at the same instant became a
 * single number. Hashing every identifying attribute into the key keeps them
 * apart.
 *
 * Why the value is excluded: an OTLP retry re-sends the identical datapoint, so
 * it must hash identically for the dedup to still work. Values can legitimately
 * differ between a first delivery and a retry of a cumulative counter, and
 * including them would turn every retry into a duplicate row.
 *
 * `provenance` IS part of the identity: a backfill-estimated row must never
 * collapse onto a live row carrying Claude Code's own measured cost. It
 * defaults to 'live' here to match the column DEFAULT, so a row hashed in TS
 * and the same row hashed in SQL (migrations) agree.
 *
 * `pricing_source` is NOT part of the identity: it annotates how a cost was
 * estimated, so re-running a backfill after a price-table update must update
 * the row rather than add one.
 *
 * CALLERS THAT SYNTHESIZE TIMESTAMPS (JSONL backfill, daily_stats import):
 * two records that land on the same synthesized timestamp with the same
 * attributes are, by this definition, one row. Give each record a distinct
 * timestamp or pass an explicit `row_id`.
 */
export const METRIC_IDENTITY_COLUMNS = [
  'timestamp',
  'user_id',
  'session_id',
  'metric_name',
  'model',
  'token_type',
  'line_type',
  'tool',
  'decision',
  'language',
  'source',
  'query_source',
  'speed',
  'effort',
  'agent_name',
  'skill_name',
  'plugin_name',
  'mcp_server_name',
  'mcp_tool_name',
  'start_type',
  'terminal_type',
  'app_version',
  'account_uuid',
  'organization_id',
  'provenance',
] as const;

export const EVENT_IDENTITY_COLUMNS = [
  'timestamp',
  'user_id',
  'session_id',
  'event_name',
  'tool_name',
  'tool_use_id',
  'model',
  'decision',
  'source',
  'request_id',
  'prompt_id',
  'command_name',
  'command_source',
  'query_source',
  'speed',
  'effort',
  'agent_name',
  'skill_name',
  'status_code',
  'error_message',
  'provenance',
] as const;

// Unit separator: cannot appear in an OTLP attribute value we keep, so
// ('a', 'bc') and ('ab', 'c') can never hash alike.
const IDENTITY_SEPARATOR = '\u001f';

function identityHash(parts: string[]): string {
  return createHash('sha256')
    .update(parts.join(IDENTITY_SEPARATOR))
    .digest('hex')
    .slice(0, 32); // 128 bits — collision-free at any volume this project will see
}

/**
 * The ClickHouse expression that computes the same hash as identityHash() for
 * rows already in the table. Used by the v2 migration; asserted against the
 * checked-in .sql by src/db/clickhouse.test.ts so the two cannot drift.
 */
export function identitySqlExpr(columns: readonly string[]): string {
  const list = columns.map(c => `toString(${c})`).join(', ');
  return `substring(lower(hex(SHA256(arrayStringConcat([${list}], char(31))))), 1, 32)`;
}

export function metricRowId(row: MetricRow): string {
  const r = row as unknown as Record<string, unknown>;
  return identityHash(
    METRIC_IDENTITY_COLUMNS.map(c =>
      c === 'provenance' ? String(row.provenance ?? 'live') : String(r[c] ?? '')
    )
  );
}

export function eventRowId(row: EventRow): string {
  const r = row as unknown as Record<string, unknown>;
  return identityHash(
    EVENT_IDENTITY_COLUMNS.map(c => {
      if (c === 'provenance') return String(row.provenance ?? 'live');
      if (c === 'status_code') return String(row.status_code ?? 0);
      return String(r[c] ?? '');
    })
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Insert Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Insert raw metrics (from OTel)
 */
export async function insertMetrics(metrics: MetricRow[]): Promise<void> {
  await insert('metrics_raw', metrics.map(m => ({ ...m, row_id: m.row_id || metricRowId(m) })));
}

/**
 * Insert raw events (from OTel)
 */
export async function insertEvents(events: EventRow[]): Promise<void> {
  await insert('events_raw', events.map(e => ({ ...e, row_id: e.row_id || eventRowId(e) })));
}

// ═══════════════════════════════════════════════════════════════════════════
// Query Functions (all use FINAL for deduplication)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get user totals for leaderboard sync
 * Queries raw tables with FINAL for deduplication
 *
 * NOTE: user_prompt events = actual user prompts (with prompt_length)
 *       api_request events = all LLM calls (includes tool continuations)
 */
export async function getUserTotals(userId?: string): Promise<UserTotals[]> {
  const whereClause = userId ? `WHERE user_id = {userId:String}` : '';

  const sql = `
    WITH
      event_stats AS (
        SELECT
          user_id,
          countIf(event_name = 'claude_code.user_prompt') as total_prompts,
          sumIf(prompt_length, event_name = 'claude_code.user_prompt') as total_prompt_chars
        FROM events_raw FINAL
        ${whereClause}
        GROUP BY user_id
      ),
      metric_stats AS (
        SELECT
          user_id,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'input') as total_input_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'output') as total_output_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead') as total_cache_read_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheCreation') as total_cache_write_tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as total_cost_usd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as total_lines_added,
          sumIf(value, metric_name = 'claude_code.commit.count') as total_commits,
          sumIf(value, metric_name = 'claude_code.pull_request.count') as total_prs,
          sumIf(value, metric_name = 'claude_code.active_time.total') as total_active_seconds
        FROM metrics_raw FINAL
        ${whereClause}
        GROUP BY user_id
      )
    SELECT
      COALESCE(e.user_id, m.user_id) as user_id,
      toUInt64(COALESCE(e.total_prompts, 0)) as total_prompts,
      toUInt64(COALESCE(m.total_input_tokens + m.total_output_tokens, 0)) as total_tokens,
      toUInt64(COALESCE(m.total_input_tokens, 0)) as total_input_tokens,
      toUInt64(COALESCE(m.total_output_tokens, 0)) as total_output_tokens,
      toUInt64(COALESCE(m.total_cache_read_tokens, 0)) as total_cache_read_tokens,
      toUInt64(COALESCE(m.total_cache_write_tokens, 0)) as total_cache_write_tokens,
      toFloat64(COALESCE(m.total_cost_usd, 0)) as total_cost_usd,
      toUInt64(COALESCE(m.total_lines_added, 0)) as total_lines_added,
      toUInt64(COALESCE(m.total_commits, 0)) as total_commits,
      toUInt64(COALESCE(m.total_prs, 0)) as total_prs,
      toUInt64(COALESCE(m.total_active_seconds, 0)) as total_active_seconds,
      toFloat64(if(COALESCE(e.total_prompts, 0) > 0, COALESCE(e.total_prompt_chars, 0) / e.total_prompts, 0)) as avg_prompt_length
    FROM event_stats e
    FULL OUTER JOIN metric_stats m ON e.user_id = m.user_id
  `;

  return query<UserTotals>(sql, userId ? { userId } : undefined);
}

/**
 * Get daily metrics for a user (for contribution graph)
 */
export async function getUserDailyMetrics(userId: string, days: number = 365): Promise<DailyMetrics[]> {
  const sql = `
    WITH
      daily_events AS (
        SELECT
          toDate(timestamp) as date,
          countIf(event_name = 'claude_code.user_prompt') as prompts,
          uniqExact(session_id) as sessions
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND toDate(timestamp) >= today() - {days:UInt32}
        GROUP BY date
      ),
      daily_metrics AS (
        SELECT
          toDate(timestamp) as date,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'input') as input_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'output') as output_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead') as cache_read_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheCreation') as cache_write_tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as cost_usd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as lines_added,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'removed') as lines_removed,
          sumIf(value, metric_name = 'claude_code.commit.count') as commits,
          sumIf(value, metric_name = 'claude_code.pull_request.count') as prs,
          sumIf(value, metric_name = 'claude_code.active_time.total') as active_seconds
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String}
          AND toDate(timestamp) >= today() - {days:UInt32}
        GROUP BY date
      )
    SELECT
      {userId:String} as user_id,
      toString(COALESCE(e.date, m.date)) as date,
      toUInt64(COALESCE(m.input_tokens, 0)) as input_tokens,
      toUInt64(COALESCE(m.output_tokens, 0)) as output_tokens,
      toUInt64(COALESCE(m.cache_read_tokens, 0)) as cache_read_tokens,
      toUInt64(COALESCE(m.cache_write_tokens, 0)) as cache_write_tokens,
      toFloat64(COALESCE(m.cost_usd, 0)) as cost_usd,
      toUInt64(COALESCE(m.lines_added, 0)) as lines_added,
      toUInt64(COALESCE(m.lines_removed, 0)) as lines_removed,
      toUInt64(COALESCE(m.commits, 0)) as commits,
      toUInt64(COALESCE(m.prs, 0)) as prs,
      toUInt64(COALESCE(e.sessions, 0)) as sessions,
      toUInt64(COALESCE(m.active_seconds, 0)) as active_seconds,
      toUInt64(COALESCE(e.prompts, 0)) as prompts
    FROM daily_events e
    FULL OUTER JOIN daily_metrics m ON e.date = m.date
    ORDER BY date
  `;

  return query<DailyMetrics>(sql, { userId, days });
}

/**
 * Get model usage breakdown for a user (Claude Diet)
 */
export async function getUserModelUsage(userId: string, days?: number): Promise<ModelUsage[]> {
  const dateFilter = days ? `AND toDate(timestamp) >= today() - ${days}` : '';

  const sql = `
    SELECT
      model,
      toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'input')) as input_tokens,
      toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'output')) as output_tokens,
      toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage')) as cost_usd
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND model != ''
      ${dateFilter}
    GROUP BY model
    ORDER BY (input_tokens + output_tokens) DESC
  `;

  return query<ModelUsage>(sql, { userId, ...(days && { days }) });
}

/**
 * Get hourly activity for heatmap
 */
export async function getUserHourlyActivity(userId: string, days: number = 90): Promise<HourlyActivity[]> {
  const sql = `
    SELECT
      toUInt8(toHour(timestamp)) as hour,
      toUInt8(toDayOfWeek(timestamp)) as day_of_week,
      toUInt64(sumIf(value, metric_name = 'claude_code.token.usage')) as activity
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND timestamp >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY hour, day_of_week
    ORDER BY day_of_week, hour
  `;

  return query<HourlyActivity>(sql, { userId, days });
}

/**
 * Get leaderboard data
 */
export async function getLeaderboard(
  period: 'today' | 'week' | 'month' | 'all',
  sortBy: 'prompts' | 'tokens' | 'cost' | 'lines' = 'prompts',
  limit: number = 100,
  offset: number = 0
): Promise<{ entries: UserTotals[]; total: number }> {
  const dateFilter = {
    today: 'toDate(timestamp) = today()',
    week: 'toDate(timestamp) >= today() - 7',
    month: 'toDate(timestamp) >= today() - 30',
    all: '1=1',
  }[period];

  const sortColumn = {
    prompts: 'total_prompts',
    tokens: 'total_tokens',
    cost: 'total_cost_usd',
    lines: 'total_lines_added',
  }[sortBy];

  const sql = `
    WITH
      event_stats AS (
        SELECT
          user_id,
          countIf(event_name = 'claude_code.user_prompt') as total_prompts,
          sumIf(prompt_length, event_name = 'claude_code.user_prompt') as total_prompt_chars
        FROM events_raw FINAL
        WHERE ${dateFilter}
        GROUP BY user_id
      ),
      metric_stats AS (
        SELECT
          user_id,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'input') as total_input_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'output') as total_output_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead') as total_cache_read_tokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheCreation') as total_cache_write_tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as total_cost_usd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as total_lines_added,
          sumIf(value, metric_name = 'claude_code.commit.count') as total_commits,
          sumIf(value, metric_name = 'claude_code.pull_request.count') as total_prs,
          sumIf(value, metric_name = 'claude_code.active_time.total') as total_active_seconds
        FROM metrics_raw FINAL
        WHERE ${dateFilter}
        GROUP BY user_id
      )
    SELECT
      COALESCE(e.user_id, m.user_id) as user_id,
      toUInt64(COALESCE(e.total_prompts, 0)) as total_prompts,
      toUInt64(COALESCE(m.total_input_tokens + m.total_output_tokens, 0)) as total_tokens,
      toUInt64(COALESCE(m.total_input_tokens, 0)) as total_input_tokens,
      toUInt64(COALESCE(m.total_output_tokens, 0)) as total_output_tokens,
      toUInt64(COALESCE(m.total_cache_read_tokens, 0)) as total_cache_read_tokens,
      toUInt64(COALESCE(m.total_cache_write_tokens, 0)) as total_cache_write_tokens,
      toFloat64(COALESCE(m.total_cost_usd, 0)) as total_cost_usd,
      toUInt64(COALESCE(m.total_lines_added, 0)) as total_lines_added,
      toUInt64(COALESCE(m.total_commits, 0)) as total_commits,
      toUInt64(COALESCE(m.total_prs, 0)) as total_prs,
      toUInt64(COALESCE(m.total_active_seconds, 0)) as total_active_seconds,
      toFloat64(if(COALESCE(e.total_prompts, 0) > 0, COALESCE(e.total_prompt_chars, 0) / e.total_prompts, 0)) as avg_prompt_length
    FROM event_stats e
    FULL OUTER JOIN metric_stats m ON e.user_id = m.user_id
    ORDER BY ${sortColumn} DESC
    LIMIT {limit:UInt32}
    OFFSET {offset:UInt32}
  `;

  const entries = await query<UserTotals>(sql, { limit, offset });

  // Get total count
  const countSql = `
    SELECT count(DISTINCT user_id) as total
    FROM events_raw FINAL
    WHERE ${dateFilter}
  `;
  const countResult = await query<{ total: number }>(countSql);
  const total = countResult[0]?.total ?? 0;

  return { entries, total };
}

/**
 * Get user's rank on the leaderboard
 */
export async function getUserRank(
  userId: string,
  period: 'today' | 'week' | 'month' | 'all',
  sortBy: 'prompts' | 'tokens' | 'cost' | 'lines' = 'prompts'
): Promise<{ rank: number; total: number } | null> {
  const dateFilter = {
    today: 'toDate(timestamp) = today()',
    week: 'toDate(timestamp) >= today() - 7',
    month: 'toDate(timestamp) >= today() - 30',
    all: '1=1',
  }[period];

  const sortColumn = {
    prompts: 'total_prompts',
    tokens: 'total_tokens',
    cost: 'total_cost_usd',
    lines: 'total_lines_added',
  }[sortBy];

  const sql = `
    WITH
      event_stats AS (
        SELECT
          user_id,
          countIf(event_name = 'claude_code.user_prompt') as total_prompts
        FROM events_raw FINAL
        WHERE ${dateFilter}
        GROUP BY user_id
      ),
      metric_stats AS (
        SELECT
          user_id,
          sumIf(value, metric_name = 'claude_code.token.usage') as total_tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as total_cost_usd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as total_lines_added
        FROM metrics_raw FINAL
        WHERE ${dateFilter}
        GROUP BY user_id
      ),
      user_totals AS (
        SELECT
          COALESCE(e.user_id, m.user_id) as user_id,
          toUInt64(COALESCE(e.total_prompts, 0)) as total_prompts,
          toUInt64(COALESCE(m.total_tokens, 0)) as total_tokens,
          toFloat64(COALESCE(m.total_cost_usd, 0)) as total_cost_usd,
          toUInt64(COALESCE(m.total_lines_added, 0)) as total_lines_added
        FROM event_stats e
        FULL OUTER JOIN metric_stats m ON e.user_id = m.user_id
      ),
      ranked AS (
        SELECT
          user_id,
          row_number() OVER (ORDER BY ${sortColumn} DESC) as rank
        FROM user_totals
      )
    SELECT toUInt64(rank) as rank, toUInt64((SELECT count() FROM ranked)) as total
    FROM ranked
    WHERE user_id = {userId:String}
  `;

  const result = await query<{ rank: number; total: number }>(sql, { userId });
  return result[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Real-time & Insights Queries (OTEL Full Potential)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Real-time today's metrics (for live dashboard)
 */
export interface TodayMetrics {
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  activeSeconds: number;
  lastActivity: string | null;
}

export async function getUserTodayMetrics(userId: string): Promise<TodayMetrics | null> {
  const sql = `
    WITH
      today_events AS (
        SELECT
          countIf(event_name = 'claude_code.user_prompt') as prompts,
          MAX(timestamp) as lastActivity
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND toDate(timestamp) = today()
      ),
      today_metrics AS (
        SELECT
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'input') as inputTokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'output') as outputTokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead') as cacheReadTokens,
          sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheCreation') as cacheWriteTokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as costUsd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as linesAdded,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'removed') as linesRemoved,
          sumIf(value, metric_name = 'claude_code.commit.count') as commits,
          sumIf(value, metric_name = 'claude_code.active_time.total') as activeSeconds
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String}
          AND toDate(timestamp) = today()
      )
    SELECT
      toUInt64(COALESCE(e.prompts, 0)) as prompts,
      toUInt64(COALESCE(m.inputTokens, 0)) as inputTokens,
      toUInt64(COALESCE(m.outputTokens, 0)) as outputTokens,
      toUInt64(COALESCE(m.cacheReadTokens, 0)) as cacheReadTokens,
      toUInt64(COALESCE(m.cacheWriteTokens, 0)) as cacheWriteTokens,
      toFloat64(COALESCE(m.costUsd, 0)) as costUsd,
      toUInt64(COALESCE(m.linesAdded, 0)) as linesAdded,
      toUInt64(COALESCE(m.linesRemoved, 0)) as linesRemoved,
      toUInt64(COALESCE(m.commits, 0)) as commits,
      toUInt64(COALESCE(m.activeSeconds, 0)) as activeSeconds,
      e.lastActivity
    FROM today_events e, today_metrics m
  `;

  const result = await query<TodayMetrics>(sql, { userId });
  return result[0] || null;
}

/**
 * Cache efficiency stats (how much money caching saves)
 */
export interface CacheStats {
  totalCacheReadTokens: number;
  totalInputTokens: number;
  cacheHitRate: number;
  estimatedSavingsUsd: number;
}

/**
 * Cache savings are derived PER MODEL from src/lib/pricing.ts.
 *
 * This used to be `cacheRead * 0.9 * 4 / 1e6` — a flat $4/MTok input rate that
 * matches no model, times a hardcoded 0.9 that assumed cacheRead is always
 * 0.1x input. Both are wrong: Fable 5.1 reads at 0.025x, and input rates run
 * from $0.25 to $10. Savings per model are cacheRead tokens x (input - cacheRead).
 */
export async function getUserCacheStats(userId: string, days?: number): Promise<CacheStats | null> {
  const dateFilter = days ? `AND toDate(timestamp) >= today() - ${days}` : '';

  const sql = `
    SELECT
      model,
      toUInt64(sumIf(value, token_type = 'cacheRead')) as cacheReadTokens,
      toUInt64(sumIf(value, token_type = 'input')) as inputTokens
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND metric_name = 'claude_code.token.usage'
      AND token_type IN ('input', 'cacheRead')
      ${dateFilter}
    GROUP BY model
  `;

  const rows = await query<{ model: string; cacheReadTokens: number; inputTokens: number }>(sql, { userId });

  let totalCacheReadTokens = 0;
  let totalInputTokens = 0;
  let estimatedSavingsUsd = 0;
  for (const row of rows) {
    const cacheRead = Number(row.cacheReadTokens) || 0;
    const input = Number(row.inputTokens) || 0;
    totalCacheReadTokens += cacheRead;
    totalInputTokens += input;
    const pricing = getModelPricing(row.model || '');
    estimatedSavingsUsd += (cacheRead * (pricing.input - pricing.cacheRead)) / 1_000_000;
  }

  const billableTokens = totalCacheReadTokens + totalInputTokens;
  return {
    totalCacheReadTokens,
    totalInputTokens,
    cacheHitRate: billableTokens > 0 ? (totalCacheReadTokens * 100) / billableTokens : 0,
    estimatedSavingsUsd,
  };
}

/**
 * Tool usage breakdown (which tools are used most)
 */
export interface ToolStats {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
}

export async function getUserToolBreakdown(userId: string, days: number = 30): Promise<ToolStats[]> {
  const sql = `
    SELECT
      tool_name as toolName,
      toUInt64(COUNT(*)) as totalCalls,
      toUInt64(SUM(tool_success)) as successCount,
      toUInt64(SUM(1 - tool_success)) as failureCount,
      toFloat64(if(COUNT(*) > 0, SUM(tool_success) * 100.0 / COUNT(*), 0)) as successRate,
      toFloat64(AVG(tool_duration_ms)) as avgDurationMs
    FROM events_raw FINAL
    WHERE user_id = {userId:String}
      AND event_name = 'claude_code.tool_result'
      AND tool_name != ''
      AND timestamp >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY tool_name
    ORDER BY totalCalls DESC
  `;

  return query<ToolStats>(sql, { userId, days });
}

/**
 * Get total tool call count for a user (for badge computation and display)
 */
export async function getUserTotalToolCalls(userId: string): Promise<number> {
  const sql = `
    SELECT COUNT(*) as total
    FROM events_raw FINAL
    WHERE user_id = {userId:String}
      AND event_name = 'claude_code.tool_result'
  `;

  const result = await query<{ total: number }>(sql, { userId });
  return result[0]?.total || 0;
}

/**
 * Activity heatmap data (for GitHub-style visualization)
 */
export interface HeatmapCell {
  hour: number;
  dayOfWeek: number;
  activity: number;
  promptCount: number;
}

export async function getActivityHeatmap(userId: string, days: number = 90): Promise<HeatmapCell[]> {
  const sql = `
    SELECT
      toUInt8(toHour(timestamp)) as hour,
      toUInt8(toDayOfWeek(timestamp)) as dayOfWeek,
      toUInt64(SUM(input_tokens + output_tokens)) as activity,
      toUInt64(COUNT(*)) as promptCount
    FROM events_raw FINAL
    WHERE user_id = {userId:String}
      AND event_name = 'claude_code.user_prompt'
      AND timestamp >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY hour, dayOfWeek
    ORDER BY dayOfWeek, hour
  `;

  return query<HeatmapCell>(sql, { userId, days });
}

/**
 * Velocity trends (daily metrics for sparkline/chart)
 */
export interface DailyTrend {
  date: string;
  prompts: number;
  tokens: number;
  costUsd: number;
  lines: number;
}

export async function getUserVelocityTrend(userId: string, days: number = 30): Promise<DailyTrend[]> {
  const sql = `
    WITH
      daily_events AS (
        SELECT
          toDate(timestamp) as date,
          countIf(event_name = 'claude_code.user_prompt') as prompts
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND toDate(timestamp) >= today() - {days:UInt32}
        GROUP BY date
      ),
      daily_metrics AS (
        SELECT
          toDate(timestamp) as date,
          sumIf(value, metric_name = 'claude_code.token.usage') as tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as costUsd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as lines
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String}
          AND toDate(timestamp) >= today() - {days:UInt32}
        GROUP BY date
      )
    SELECT
      toString(COALESCE(e.date, m.date)) as date,
      toUInt64(COALESCE(e.prompts, 0)) as prompts,
      toUInt64(COALESCE(m.tokens, 0)) as tokens,
      toFloat64(COALESCE(m.costUsd, 0)) as costUsd,
      toUInt64(COALESCE(m.lines, 0)) as lines
    FROM daily_events e
    FULL OUTER JOIN daily_metrics m ON e.date = m.date
    ORDER BY date
  `;

  return query<DailyTrend>(sql, { userId, days });
}

/**
 * Session analytics
 */
export interface SessionStats {
  totalSessions: number;
  avgSessionMinutes: number;
  avgPromptsPerSession: number;
  longestSessionMinutes: number;
}

export async function getUserSessionStats(userId: string, days: number = 30): Promise<SessionStats | null> {
  const sql = `
    WITH sessions AS (
      SELECT
        session_id,
        COUNT(*) as prompt_count,
        dateDiff('second', MIN(timestamp), MAX(timestamp)) / 60 as duration_minutes
      FROM events_raw FINAL
      WHERE user_id = {userId:String}
        AND event_name = 'claude_code.user_prompt'
        AND timestamp >= now() - INTERVAL {days:UInt32} DAY
        AND session_id != ''
      GROUP BY session_id
      HAVING prompt_count > 0
    )
    SELECT
      toUInt64(COUNT(*)) as totalSessions,
      toFloat64(AVG(duration_minutes)) as avgSessionMinutes,
      toFloat64(AVG(prompt_count)) as avgPromptsPerSession,
      toFloat64(MAX(duration_minutes)) as longestSessionMinutes
    FROM sessions
  `;

  const result = await query<SessionStats>(sql, { userId, days });
  return result[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Chart Data (for flexible analytics chart)
// ═══════════════════════════════════════════════════════════════════════════

export type ChartMetric = 'tokens' | 'cost' | 'prompts' | 'lines' | 'commits';
export type ChartPeriod = '1d' | '7d' | '30d' | '90d' | 'all';
export type { ChartGroupBy };

export interface ChartDataPoint {
  date: string;
  hour?: number; // For hourly view (0-23)
  totalValue?: number;
  // For tokens breakdown on hover
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  // For lines breakdown
  linesAdded?: number;
  linesRemoved?: number;
}

export interface ChartData {
  chartType: 'line' | 'bar' | 'dualBar';
  // Canonical bucket keys, 1:1 with `labels` — 'YYYY-MM-DD' (day/week) or
  // 'YYYY-MM' (month), or the hour label for the 1d view. mergeChartData aligns
  // the legacy and OTEL series on these, never on the display label.
  keys: string[];
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    color: string;
  }>;
  hover?: Record<string, Record<string, number>>;
  summary: {
    total: number;
    average: number;
    peak: { date: string; value: number } | null;
    trend: string; // e.g., "+12%" or "-5%"
  };
  // Optional: indicates this is legacy-only data with limitations
  isLegacyData?: boolean;
}

// Response when OTEL is required but not enabled
export interface OtelRequiredResponse {
  noData: true;
  reason: 'otel_required';
  message: string;
  action: string;
  fallbackPeriod: ChartPeriod;
}

/**
 * Get chart data from SQLite dailyStats (legacy/pre-OTEL data)
 */
export async function getLegacyChartData(
  userId: string,
  metric: ChartMetric,
  period: ChartPeriod,
  groupBy: ChartGroupBy = 'day',
  endDate?: string // Optional: limit to dates before this (for OTEL users, this would be otelSetupDate)
): Promise<ChartData | null> {
  // "1d" (hourly) is not supported for legacy data
  if (period === '1d') {
    return null;
  }

  // Calculate date range
  const today = new Date().toISOString().split('T')[0]!;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365 * 10; // 10 years for "all"
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;

  // Build conditions
  const conditions = [eq(dailyStats.userId, userId), gte(dailyStats.date, startDate)];
  if (endDate) {
    conditions.push(lte(dailyStats.date, endDate));
  }

  // Query SQLite
  const rawData = await db
    .select({
      date: dailyStats.date,
      promptCount: dailyStats.promptCount,
      tokenCount: dailyStats.tokenCount,
      inputTokens: dailyStats.inputTokens,
      outputTokens: dailyStats.outputTokens,
      cacheReadTokens: dailyStats.cacheReadTokens,
      cacheCreationTokens: dailyStats.cacheCreationTokens,
      costUsdCents: dailyStats.costUsdCents,
      linesWritten: dailyStats.linesWritten,
      commitCount: dailyStats.commitCount,
    })
    .from(dailyStats)
    .where(and(...conditions))
    .orderBy(asc(dailyStats.date));

  if (rawData.length === 0) {
    return null;
  }

  // daily_stats is already one row per day — week/month collapse in JS, on the
  // same canonical key the ClickHouse path derives in SQL.
  const rows = bucketDailyRows(rawData, groupBy);

  // Transform to chart format
  const keys: string[] = [];
  const labels: string[] = [];
  const datasets: ChartData['datasets'] = [];
  const hover: Record<string, Record<string, number>> = {};

  // Determine chart type and color based on metric
  let chartType: ChartData['chartType'] = 'line';
  let primaryColor = '#22d3ee'; // cyan

  switch (metric) {
    case 'tokens':
      primaryColor = '#22d3ee';
      chartType = 'line';
      break;
    case 'cost':
      primaryColor = '#22c55e';
      chartType = 'line';
      break;
    case 'prompts':
      primaryColor = '#a855f7';
      chartType = 'bar';
      break;
    case 'lines':
      // For legacy, we only have linesWritten (added), no removed
      // Show as single bar, not dualBar
      primaryColor = '#22c55e';
      chartType = 'bar';
      break;
    case 'commits':
      primaryColor = '#f59e0b';
      chartType = 'bar';
      break;
  }

  // Build datasets based on metric
  const values: number[] = [];

  for (const row of rows) {
    const dateLabel = bucketLabel(row.date, groupBy);
    keys.push(row.date);
    labels.push(dateLabel);

    switch (metric) {
      case 'tokens': {
        const total = (row.inputTokens || 0) + (row.outputTokens || 0) +
                      (row.cacheReadTokens || 0) + (row.cacheCreationTokens || 0);
        values.push(total);
        hover[dateLabel] = {
          input: row.inputTokens || 0,
          output: row.outputTokens || 0,
          cacheRead: row.cacheReadTokens || 0,
          cacheWrite: row.cacheCreationTokens || 0,
        };
        break;
      }
      case 'cost':
        values.push((row.costUsdCents || 0) / 100); // Convert cents to dollars
        break;
      case 'prompts':
        values.push(row.promptCount || 0);
        break;
      case 'lines':
        values.push(row.linesWritten || 0);
        break;
      case 'commits':
        values.push(row.commitCount || 0);
        break;
    }
  }

  const labelMap: Record<ChartMetric, string> = {
    tokens: 'Tokens',
    cost: 'Cost',
    prompts: 'Prompts',
    lines: 'Lines Added', // Note: legacy only has additions
    commits: 'Commits',
  };

  datasets.push({ label: labelMap[metric], data: values, color: primaryColor });

  // Calculate summary
  const total = values.reduce((a, b) => a + b, 0);
  const average = values.length > 0 ? total / values.length : 0;

  // Find peak
  let peak: { date: string; value: number } | null = null;
  if (values.length > 0) {
    const maxIdx = values.indexOf(Math.max(...values));
    const maxValue = values[maxIdx] ?? 0;
    const peakLabel = labels[maxIdx];
    if (maxValue > 0 && peakLabel) {
      peak = {
        date: peakLabel,
        value: maxValue,
      };
    }
  }

  // Calculate trend
  let trend = '—';
  if (values.length >= 4) {
    const mid = Math.floor(values.length / 2);
    const firstHalf = values.slice(0, mid).reduce((a, b) => a + b, 0);
    const secondHalf = values.slice(mid).reduce((a, b) => a + b, 0);
    if (firstHalf > 0) {
      const pctChange = ((secondHalf - firstHalf) / firstHalf) * 100;
      trend = pctChange >= 0 ? `+${Math.round(pctChange)}%` : `${Math.round(pctChange)}%`;
    }
  }

  return {
    chartType,
    keys,
    labels,
    datasets,
    ...(Object.keys(hover).length > 0 && { hover }),
    summary: {
      total: Math.round(total),
      average: Math.round(average),
      peak,
      trend,
    },
    isLegacyData: true,
  };
}

/**
 * Get chart data for the flexible analytics chart (OTEL/ClickHouse)
 */
export async function getChartData(
  userId: string,
  metric: ChartMetric,
  period: ChartPeriod,
  groupBy: ChartGroupBy = 'day'
): Promise<ChartData> {
  // For "1d" (today), we group by hour; otherwise by the requested bucket
  const isHourly = period === '1d';

  // Calculate date range
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365;
  const dateFilter = period === '1d'
    ? `AND toDate(timestamp) = today()`
    : period === 'all'
      ? ''
      : `AND toDate(timestamp) >= today() - ${days}`;

  // Build query based on metric
  let sql: string;
  let chartType: 'line' | 'bar' | 'dualBar' = 'line';
  let primaryColor = '#22d3ee'; // cyan

  // For hourly view, we need to group by hour instead of date.
  // The date range itself is NOT snapped to bucket boundaries: week/month
  // buckets stay an exact partition of the days the daily view would show, so
  // their sums reconcile to it (the oldest bucket is simply partial).
  const groupByClause = isHourly ? 'toHour(timestamp) as hour' : bucketSql(groupBy);
  const orderByClause = isHourly ? 'hour' : 'date';

  switch (metric) {
    case 'tokens':
      sql = `
        SELECT
          ${groupByClause},
          toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'input')) as inputTokens,
          toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'output')) as outputTokens,
          toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead')) as cacheReadTokens,
          toUInt64(sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheCreation')) as cacheWriteTokens,
          toUInt64(sumIf(value, metric_name = 'claude_code.token.usage')) as totalValue
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String} ${dateFilter}
        GROUP BY ${orderByClause}
        ORDER BY ${orderByClause}
      `;
      chartType = 'line';
      primaryColor = '#22d3ee'; // cyan
      break;

    case 'cost':
      sql = `
        SELECT
          ${groupByClause},
          toFloat64(sumIf(value, metric_name = 'claude_code.cost.usage')) as totalValue
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String} ${dateFilter}
        GROUP BY ${orderByClause}
        ORDER BY ${orderByClause}
      `;
      chartType = 'line';
      primaryColor = '#22c55e'; // green
      break;

    case 'prompts':
      sql = `
        SELECT
          ${groupByClause},
          toUInt64(countIf(event_name = 'claude_code.user_prompt')) as totalValue
        FROM events_raw FINAL
        WHERE user_id = {userId:String} ${dateFilter}
        GROUP BY ${orderByClause}
        ORDER BY ${orderByClause}
      `;
      chartType = 'bar';
      primaryColor = '#a855f7'; // purple
      break;

    case 'lines':
      sql = `
        SELECT
          ${groupByClause},
          toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added')) as linesAdded,
          toUInt64(sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'removed')) as linesRemoved
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String} ${dateFilter}
        GROUP BY ${orderByClause}
        ORDER BY ${orderByClause}
      `;
      chartType = 'dualBar';
      break;

    case 'commits':
      sql = `
        SELECT
          ${groupByClause},
          toUInt64(sumIf(value, metric_name = 'claude_code.commit.count')) as totalValue
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String} ${dateFilter}
        GROUP BY ${orderByClause}
        ORDER BY ${orderByClause}
      `;
      chartType = 'bar';
      primaryColor = '#f59e0b'; // amber
      break;
  }

  const rawData = await query<ChartDataPoint>(sql, { userId });

  // Transform data for charting
  const keys: string[] = [];
  const labels: string[] = [];
  const datasets: ChartData['datasets'] = [];
  const hover: Record<string, Record<string, number>> = {};

  // For hourly view, we need to ensure all 24 hours are represented
  const dataMap = new Map<string, ChartDataPoint>();
  if (isHourly) {
    // Create map with hour as key
    for (const row of rawData) {
      dataMap.set(String(row.hour), row);
    }
  }

  // Format hour label (e.g., "12am", "1pm")
  const formatHourLabel = (hour: number): string => {
    if (hour === 0) return '12am';
    if (hour === 12) return '12pm';
    if (hour < 12) return `${hour}am`;
    return `${hour - 12}pm`;
  };

  if (metric === 'lines') {
    // Dual bar for lines
    const addedData: number[] = [];
    const removedData: number[] = [];

    if (isHourly) {
      for (let h = 0; h < 24; h++) {
        const label = formatHourLabel(h);
        keys.push(label);
        labels.push(label);
        const row = dataMap.get(String(h));
        addedData.push(row?.linesAdded || 0);
        removedData.push(-(row?.linesRemoved || 0));
      }
    } else {
      for (const row of rawData) {
        keys.push(row.date);
        labels.push(bucketLabel(row.date, groupBy));
        addedData.push(row.linesAdded || 0);
        removedData.push(-(row.linesRemoved || 0));
      }
    }

    datasets.push(
      { label: 'Added', data: addedData, color: '#22c55e' },
      { label: 'Removed', data: removedData, color: '#ef4444' }
    );
  } else if (metric === 'tokens') {
    // Line with hover breakdown
    const values: number[] = [];

    if (isHourly) {
      for (let h = 0; h < 24; h++) {
        const label = formatHourLabel(h);
        keys.push(label);
        labels.push(label);
        const row = dataMap.get(String(h));
        values.push(row?.totalValue || 0);
        hover[label] = {
          input: row?.inputTokens || 0,
          output: row?.outputTokens || 0,
          cacheRead: row?.cacheReadTokens || 0,
          cacheWrite: row?.cacheWriteTokens || 0,
        };
      }
    } else {
      for (const row of rawData) {
        const dateLabel = bucketLabel(row.date, groupBy);
        keys.push(row.date);
        labels.push(dateLabel);
        values.push(row.totalValue || 0);
        hover[dateLabel] = {
          input: row.inputTokens || 0,
          output: row.outputTokens || 0,
          cacheRead: row.cacheReadTokens || 0,
          cacheWrite: row.cacheWriteTokens || 0,
        };
      }
    }

    datasets.push({ label: 'Tokens', data: values, color: primaryColor });
  } else {
    // Simple line or bar
    const values: number[] = [];

    if (isHourly) {
      for (let h = 0; h < 24; h++) {
        keys.push(formatHourLabel(h));
        labels.push(formatHourLabel(h));
        const row = dataMap.get(String(h));
        values.push(row?.totalValue || 0);
      }
    } else {
      for (const row of rawData) {
        keys.push(row.date);
        labels.push(bucketLabel(row.date, groupBy));
        values.push(row.totalValue || 0);
      }
    }

    const labelMap: Record<ChartMetric, string> = {
      tokens: 'Tokens',
      cost: 'Cost',
      prompts: 'Prompts',
      lines: 'Lines',
      commits: 'Commits',
    };

    datasets.push({ label: labelMap[metric], data: values, color: primaryColor });
  }

  // Calculate summary - use all 24 hours for hourly, otherwise use raw data
  const allValues = isHourly
    ? Array.from({ length: 24 }, (_, h) => {
        const row = dataMap.get(String(h));
        return metric === 'lines'
          ? (row?.linesAdded || 0) - (row?.linesRemoved || 0)
          : (row?.totalValue || 0);
      })
    : metric === 'lines'
      ? rawData.map(r => (r.linesAdded || 0) - (r.linesRemoved || 0))
      : rawData.map(r => r.totalValue || 0);

  const total = allValues.reduce((a, b) => a + b, 0);
  const average = allValues.length > 0 ? total / allValues.length : 0;

  // Find peak
  let peak: { date: string; value: number } | null = null;
  if (allValues.length > 0) {
    const maxIdx = allValues.indexOf(Math.max(...allValues));
    const maxValue = allValues[maxIdx] ?? 0;
    if (maxValue > 0) {
      if (isHourly) {
        peak = {
          date: formatHourLabel(maxIdx),
          value: maxValue,
        };
      } else {
        const peakRow = rawData[maxIdx];
        if (peakRow) {
          peak = {
            date: bucketLabel(peakRow.date, groupBy),
            value: metric === 'lines'
              ? (peakRow.linesAdded || 0) - (peakRow.linesRemoved || 0)
              : (peakRow.totalValue || 0),
          };
        }
      }
    }
  }

  // Calculate trend (compare last half to first half of period)
  let trend = '—';
  if (allValues.length >= 4) {
    const mid = Math.floor(allValues.length / 2);
    const firstHalf = allValues.slice(0, mid).reduce((a, b) => a + b, 0);
    const secondHalf = allValues.slice(mid).reduce((a, b) => a + b, 0);
    if (firstHalf > 0) {
      const pctChange = ((secondHalf - firstHalf) / firstHalf) * 100;
      trend = pctChange >= 0 ? `+${Math.round(pctChange)}%` : `${Math.round(pctChange)}%`;
    }
  }

  return {
    chartType,
    keys,
    labels,
    datasets,
    ...(Object.keys(hover).length > 0 && { hover }),
    summary: {
      total: Math.round(total),
      average: Math.round(average),
      peak,
      trend,
    },
  };
}

/**
 * Merge legacy and OTEL chart data for seamless historical view.
 *
 * Aligns the two backends on the canonical bucket key, never on position: with
 * week/month grouping the bucket straddling the OTEL setup date holds rows from
 * BOTH sources, and concatenating would render it as two bars.
 */
export function mergeChartData(
  legacyData: ChartData | null,
  otelData: ChartData
): ChartData {
  if (!legacyData) {
    return otelData;
  }

  // Legacy only has "Lines Added" — pad it out to OTEL's dual structure
  const isDualBar = otelData.chartType === 'dualBar' && legacyData.chartType === 'bar';
  const shape = isDualBar
    ? [{ label: 'Added', color: '#22c55e' }, { label: 'Removed', color: '#ef4444' }]
    : otelData.datasets.map(ds => ({ label: ds.label, color: ds.color }));

  // Legacy dataset labels don't always match OTEL's ("Lines Added" vs "Added"),
  // so fall back to position when the label lookup misses
  const seriesFor = (src: ChartData, index: number, label: string): number[] =>
    src.datasets.find(ds => ds.label === label)?.data ?? src.datasets[index]?.data ?? [];

  const order: string[] = [];
  const buckets = new Map<string, { label: string; values: number[]; hover?: Record<string, number> }>();

  const absorb = (src: ChartData) => {
    const series = shape.map((ds, i) => seriesFor(src, i, ds.label));
    for (let i = 0; i < src.keys.length; i++) {
      const key = src.keys[i]!;
      const label = src.labels[i] ?? key;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { label, values: new Array(shape.length).fill(0) };
        buckets.set(key, bucket);
        order.push(key);
      }
      for (let d = 0; d < shape.length; d++) {
        bucket.values[d] = (bucket.values[d] ?? 0) + (series[d]?.[i] ?? 0);
      }
      const breakdown = src.hover?.[label];
      if (breakdown) {
        const acc = bucket.hover ?? (bucket.hover = {});
        for (const [field, value] of Object.entries(breakdown)) {
          acc[field] = (acc[field] ?? 0) + value;
        }
      }
    }
  };

  absorb(legacyData);
  absorb(otelData);

  // Canonical keys ('YYYY-MM-DD', 'YYYY-MM') sort chronologically as strings
  const mergedKeys = order.sort((a, b) => a.localeCompare(b));
  const mergedLabels = mergedKeys.map(key => buckets.get(key)!.label);
  const mergedDatasets: ChartData['datasets'] = shape.map((ds, d) => ({
    label: ds.label,
    data: mergedKeys.map(key => buckets.get(key)!.values[d] ?? 0),
    color: ds.color,
  }));

  if (isDualBar) {
    return {
      chartType: 'dualBar',
      keys: mergedKeys,
      labels: mergedLabels,
      datasets: mergedDatasets,
      summary: otelData.summary, // Use OTEL summary as it's more recent
    };
  }

  // Merge hover data if present
  let mergedHover: Record<string, Record<string, number>> | undefined;
  for (const key of mergedKeys) {
    const breakdown = buckets.get(key)!.hover;
    if (breakdown) {
      mergedHover ??= {};
      mergedHover[buckets.get(key)!.label] = breakdown;
    }
  }

  // Recalculate summary from merged data
  const allValues = mergedDatasets[0]?.data || [];
  const total = allValues.reduce((a, b) => a + Math.abs(b), 0);
  const average = allValues.length > 0 ? total / allValues.length : 0;

  // Find peak from merged data
  let peak: { date: string; value: number } | null = null;
  if (allValues.length > 0) {
    const absValues = allValues.map(v => Math.abs(v));
    const maxIdx = absValues.indexOf(Math.max(...absValues));
    const maxValue = absValues[maxIdx] ?? 0;
    const peakLabel = mergedLabels[maxIdx];
    if (maxValue > 0 && peakLabel) {
      peak = {
        date: peakLabel,
        value: maxValue,
      };
    }
  }

  // Calculate trend from merged data
  let trend = '—';
  if (allValues.length >= 4) {
    const mid = Math.floor(allValues.length / 2);
    const firstHalf = allValues.slice(0, mid).reduce((a, b) => a + Math.abs(b), 0);
    const secondHalf = allValues.slice(mid).reduce((a, b) => a + Math.abs(b), 0);
    if (firstHalf > 0) {
      const pctChange = ((secondHalf - firstHalf) / firstHalf) * 100;
      trend = pctChange >= 0 ? `+${Math.round(pctChange)}%` : `${Math.round(pctChange)}%`;
    }
  }

  return {
    chartType: otelData.chartType,
    keys: mergedKeys,
    labels: mergedLabels,
    datasets: mergedDatasets,
    ...(mergedHover && { hover: mergedHover }),
    summary: {
      total: Math.round(total),
      average: Math.round(average),
      peak,
      trend,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Profile Signature Insights (Language, Trust, Efficiency)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Language distribution with acceptance rates (from code_edit_tool.decision)
 * Shows what languages user edits with Claude and their trust level per language
 */
export interface LanguageStats {
  language: string;
  editCount: number;
  acceptCount: number;
  rejectCount: number;
  acceptRate: number;
  percentage: number; // percentage of total edits
}

export async function getUserLanguageStats(userId: string, days?: number): Promise<LanguageStats[]> {
  const dateFilter = days ? `AND timestamp >= now() - INTERVAL ${days} DAY` : '';

  const sql = `
    WITH total AS (
      SELECT count(*) as total_edits
      FROM metrics_raw FINAL
      WHERE user_id = {userId:String}
        AND metric_name = 'claude_code.code_edit_tool.decision'
        AND language != ''
        ${dateFilter}
    )
    SELECT
      language,
      toUInt64(count(*)) as editCount,
      toUInt64(countIf(decision = 'accept')) as acceptCount,
      toUInt64(countIf(decision = 'reject')) as rejectCount,
      toFloat64(if(count(*) > 0, countIf(decision = 'accept') * 100.0 / count(*), 0)) as acceptRate,
      toFloat64(if((SELECT total_edits FROM total) > 0,
         count(*) * 100.0 / (SELECT total_edits FROM total), 0)) as percentage
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND metric_name = 'claude_code.code_edit_tool.decision'
      AND language != ''
      ${dateFilter}
    GROUP BY language
    ORDER BY editCount DESC
    LIMIT 10
  `;

  return query<LanguageStats>(sql, { userId });
}

/**
 * Trust style breakdown - how user interacts with tool permissions
 * Shows accept/reject rates and auto-approve vs manual review patterns
 */
export interface TrustStyle {
  // Overall edit acceptance
  totalEdits: number;
  acceptedEdits: number;
  rejectedEdits: number;
  editAcceptRate: number;
  // Decision sources (auto vs manual)
  autoApproved: number;    // source = 'config'
  userPermanent: number;   // source = 'user_permanent'
  userTemporary: number;   // source = 'user_temporary'
  userAbort: number;       // source = 'user_abort'
  userReject: number;      // source = 'user_reject'
  // Derived
  autonomyRate: number;    // auto + permanent / total
}

export async function getUserTrustStyle(userId: string, days?: number): Promise<TrustStyle | null> {
  const dateFilter = days ? `AND timestamp >= now() - INTERVAL ${days} DAY` : '';

  const sql = `
    WITH
      edit_stats AS (
        SELECT
          toUInt64(count(*)) as totalEdits,
          toUInt64(countIf(decision = 'accept')) as acceptedEdits,
          toUInt64(countIf(decision = 'reject')) as rejectedEdits,
          toFloat64(if(count(*) > 0, countIf(decision = 'accept') * 100.0 / count(*), 0)) as editAcceptRate
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String}
          AND metric_name = 'claude_code.code_edit_tool.decision'
          ${dateFilter}
      ),
      decision_sources AS (
        SELECT
          toUInt64(countIf(source = 'config')) as autoApproved,
          toUInt64(countIf(source = 'user_permanent')) as userPermanent,
          toUInt64(countIf(source = 'user_temporary')) as userTemporary,
          toUInt64(countIf(source = 'user_abort')) as userAbort,
          toUInt64(countIf(source = 'user_reject')) as userReject
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND event_name IN ('claude_code.tool_result', 'claude_code.tool_decision')
          AND source != ''
          ${dateFilter}
      )
    SELECT
      e.totalEdits,
      e.acceptedEdits,
      e.rejectedEdits,
      e.editAcceptRate,
      d.autoApproved,
      d.userPermanent,
      d.userTemporary,
      d.userAbort,
      d.userReject,
      toFloat64(if((d.autoApproved + d.userPermanent + d.userTemporary + d.userAbort + d.userReject) > 0,
         (d.autoApproved + d.userPermanent) * 100.0 /
         (d.autoApproved + d.userPermanent + d.userTemporary + d.userAbort + d.userReject),
         0)) as autonomyRate
    FROM edit_stats e, decision_sources d
  `;

  const result = await query<TrustStyle>(sql, { userId });
  return result[0] || null;
}

/**
 * Agentic intensity - how "agentic" the user's workflow is
 * Measures API calls per prompt (higher = more tool use / agentic loops)
 */
export interface AgenticStats {
  totalApiCalls: number;
  totalPrompts: number;
  agenticRatio: number;       // api_calls / prompts
  maxApiCallsPerPrompt: number; // highest ratio for a single session
  avgApiCallsPerSession: number;
}

export async function getUserAgenticStats(userId: string, days?: number): Promise<AgenticStats | null> {
  const dateFilter = days ? `AND timestamp >= now() - INTERVAL ${days} DAY` : '';

  const sql = `
    WITH
      totals AS (
        SELECT
          toUInt64(countIf(event_name = 'claude_code.api_request')) as totalApiCalls,
          toUInt64(countIf(event_name = 'claude_code.user_prompt')) as totalPrompts
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          ${dateFilter}
      ),
      session_stats AS (
        SELECT
          session_id,
          countIf(event_name = 'claude_code.api_request') as api_calls,
          countIf(event_name = 'claude_code.user_prompt') as prompts
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND session_id != ''
          ${dateFilter}
        GROUP BY session_id
        HAVING prompts > 0
      )
    SELECT
      t.totalApiCalls,
      t.totalPrompts,
      toFloat64(if(t.totalPrompts > 0, t.totalApiCalls * 1.0 / t.totalPrompts, 0)) as agenticRatio,
      toFloat64(if(count(*) > 0, max(s.api_calls * 1.0 / s.prompts), 0)) as maxApiCallsPerPrompt,
      toFloat64(if(count(*) > 0, avg(s.api_calls), 0)) as avgApiCallsPerSession
    FROM totals t, session_stats s
    GROUP BY t.totalApiCalls, t.totalPrompts
  `;

  const result = await query<AgenticStats>(sql, { userId });
  return result[0] || null;
}

/**
 * Prompt length statistics
 */
export interface PromptLengthStats {
  avgLength: number;
  maxLength: number;
  minLength: number;
  totalPrompts: number;
}

export async function getUserPromptLengthStats(userId: string, days?: number): Promise<PromptLengthStats | null> {
  const dateFilter = days ? `AND timestamp >= now() - INTERVAL ${days} DAY` : '';

  const sql = `
    SELECT
      toFloat64(avg(prompt_length)) as avgLength,
      toUInt64(max(prompt_length)) as maxLength,
      toUInt64(min(prompt_length)) as minLength,
      toUInt64(count(*)) as totalPrompts
    FROM events_raw FINAL
    WHERE user_id = {userId:String}
      AND event_name = 'claude_code.user_prompt'
      AND prompt_length > 0
      ${dateFilter}
  `;

  const result = await query<PromptLengthStats>(sql, { userId });
  return result[0] || null;
}

/**
 * Today's languages (for Today widget)
 */
export interface TodayLanguage {
  language: string;
  count: number;
  percentage: number;
}

export async function getTodayLanguages(userId: string): Promise<TodayLanguage[]> {
  const sql = `
    WITH total AS (
      SELECT count(*) as total_edits
      FROM metrics_raw FINAL
      WHERE user_id = {userId:String}
        AND metric_name = 'claude_code.code_edit_tool.decision'
        AND toDate(timestamp) = today()
        AND language != ''
    )
    SELECT
      language,
      toUInt64(count(*)) as count,
      toFloat64(if((SELECT total_edits FROM total) > 0,
         count(*) * 100.0 / (SELECT total_edits FROM total), 0)) as percentage
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND metric_name = 'claude_code.code_edit_tool.decision'
      AND toDate(timestamp) = today()
      AND language != ''
    GROUP BY language
    ORDER BY count DESC
    LIMIT 5
  `;

  return query<TodayLanguage>(sql, { userId });
}

/**
 * Primary terminal/IDE type
 */
export interface TerminalStats {
  terminalType: string;
  sessionCount: number;
  percentage: number;
}

export async function getUserTerminalStats(userId: string): Promise<TerminalStats[]> {
  const sql = `
    WITH total AS (
      SELECT uniqExact(session_id) as total_sessions
      FROM metrics_raw FINAL
      WHERE user_id = {userId:String}
        AND terminal_type != ''
    )
    SELECT
      terminal_type as terminalType,
      toUInt64(uniqExact(session_id)) as sessionCount,
      toFloat64(if((SELECT total_sessions FROM total) > 0,
         uniqExact(session_id) * 100.0 / (SELECT total_sessions FROM total), 0)) as percentage
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND terminal_type != ''
    GROUP BY terminal_type
    ORDER BY sessionCount DESC
    LIMIT 5
  `;

  return query<TerminalStats>(sql, { userId });
}

/**
 * Enhanced Today metrics with active time and languages
 */
export interface TodayMetricsEnhanced extends TodayMetrics {
  languages: TodayLanguage[];
  topTool: string | null;
  editAcceptRate: number;
}

export async function getUserTodayMetricsEnhanced(userId: string): Promise<TodayMetricsEnhanced | null> {
  // Get base today metrics
  const baseMetrics = await getUserTodayMetrics(userId);
  if (!baseMetrics) return null;

  // Get today's languages
  const languages = await getTodayLanguages(userId);

  // Get today's top tool
  const toolSql = `
    SELECT tool_name as topTool
    FROM events_raw FINAL
    WHERE user_id = {userId:String}
      AND event_name = 'claude_code.tool_result'
      AND tool_name != ''
      AND toDate(timestamp) = today()
    GROUP BY tool_name
    ORDER BY count(*) DESC
    LIMIT 1
  `;
  const toolResult = await query<{ topTool: string }>(toolSql, { userId });

  // Get today's edit accept rate
  const editSql = `
    SELECT
      toFloat64(if(count(*) > 0, countIf(decision = 'accept') * 100.0 / count(*), 0)) as editAcceptRate
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND metric_name = 'claude_code.code_edit_tool.decision'
      AND toDate(timestamp) = today()
  `;
  const editResult = await query<{ editAcceptRate: number }>(editSql, { userId });

  return {
    ...baseMetrics,
    languages,
    topTool: toolResult[0]?.topTool || null,
    editAcceptRate: editResult[0]?.editAcceptRate || 0,
  };
}

export const clickhouse = {
  query,
  insert,
  healthCheck,
  insertMetrics,
  insertEvents,
  getUserTotals,
  getUserDailyMetrics,
  getUserModelUsage,
  getUserHourlyActivity,
  getLeaderboard,
  getUserRank,
  // OTEL full potential queries
  getUserTodayMetrics,
  getUserCacheStats,
  getUserToolBreakdown,
  getUserTotalToolCalls,
  getActivityHeatmap,
  getUserVelocityTrend,
  getUserSessionStats,
  // Chart data
  getChartData,
  getLegacyChartData,
  mergeChartData,
  // NEW: Profile Signature Insights
  getUserLanguageStats,
  getUserTrustStyle,
  getUserAgenticStats,
  getUserPromptLengthStats,
  getTodayLanguages,
  getUserTerminalStats,
  getUserTodayMetricsEnhanced,
};

export default clickhouse;
