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
 *   - claude_code.api_request (prompts/LLM calls)
 *   - claude_code.tool_result
 *   - claude_code.tool_decision
 * Metrics:
 *   - claude_code.token.usage (with token_type: input/output/cacheRead/cacheCreation)
 *   - claude_code.cost.usage
 *   - claude_code.active_time.total
 *   - claude_code.lines_of_code.count (with line_type: added/removed)
 *   - claude_code.commit.count
 *   - claude_code.pull_request.count
 *   - claude_code.session.count
 */

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
// Insert Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Insert raw metrics (from OTel)
 */
export async function insertMetrics(metrics: MetricRow[]): Promise<void> {
  await insert('metrics_raw', metrics);
}

/**
 * Insert raw events (from OTel)
 */
export async function insertEvents(events: EventRow[]): Promise<void> {
  await insert('events_raw', events);
}

// ═══════════════════════════════════════════════════════════════════════════
// Query Functions (all use FINAL for deduplication)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get user totals for leaderboard sync
 * Queries raw tables with FINAL for deduplication
 *
 * NOTE: api_request events represent prompts/LLM calls
 */
export async function getUserTotals(userId?: string): Promise<UserTotals[]> {
  const whereClause = userId ? `WHERE user_id = {userId:String}` : '';

  const sql = `
    WITH
      event_stats AS (
        SELECT
          user_id,
          countIf(event_name = 'claude_code.api_request') as total_prompts,
          sumIf(prompt_length, event_name = 'claude_code.api_request') as total_prompt_chars
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
      COALESCE(e.total_prompts, 0) as total_prompts,
      COALESCE(m.total_input_tokens + m.total_output_tokens, 0) as total_tokens,
      COALESCE(m.total_input_tokens, 0) as total_input_tokens,
      COALESCE(m.total_output_tokens, 0) as total_output_tokens,
      COALESCE(m.total_cache_read_tokens, 0) as total_cache_read_tokens,
      COALESCE(m.total_cache_write_tokens, 0) as total_cache_write_tokens,
      COALESCE(m.total_cost_usd, 0) as total_cost_usd,
      COALESCE(m.total_lines_added, 0) as total_lines_added,
      COALESCE(m.total_commits, 0) as total_commits,
      COALESCE(m.total_prs, 0) as total_prs,
      COALESCE(m.total_active_seconds, 0) as total_active_seconds,
      if(COALESCE(e.total_prompts, 0) > 0, COALESCE(e.total_prompt_chars, 0) / e.total_prompts, 0) as avg_prompt_length
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
          countIf(event_name = 'claude_code.api_request') as prompts,
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
      COALESCE(m.input_tokens, 0) as input_tokens,
      COALESCE(m.output_tokens, 0) as output_tokens,
      COALESCE(m.cache_read_tokens, 0) as cache_read_tokens,
      COALESCE(m.cache_write_tokens, 0) as cache_write_tokens,
      COALESCE(m.cost_usd, 0) as cost_usd,
      COALESCE(m.lines_added, 0) as lines_added,
      COALESCE(m.lines_removed, 0) as lines_removed,
      COALESCE(m.commits, 0) as commits,
      COALESCE(m.prs, 0) as prs,
      COALESCE(e.sessions, 0) as sessions,
      COALESCE(m.active_seconds, 0) as active_seconds,
      COALESCE(e.prompts, 0) as prompts
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
      sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'input') as input_tokens,
      sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'output') as output_tokens,
      sumIf(value, metric_name = 'claude_code.cost.usage') as cost_usd
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
      toHour(timestamp) as hour,
      toDayOfWeek(timestamp) as day_of_week,
      sumIf(value, metric_name = 'claude_code.token.usage') as activity
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
          countIf(event_name = 'claude_code.api_request') as total_prompts,
          sumIf(prompt_length, event_name = 'claude_code.api_request') as total_prompt_chars
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
      COALESCE(e.total_prompts, 0) as total_prompts,
      COALESCE(m.total_input_tokens + m.total_output_tokens, 0) as total_tokens,
      COALESCE(m.total_input_tokens, 0) as total_input_tokens,
      COALESCE(m.total_output_tokens, 0) as total_output_tokens,
      COALESCE(m.total_cache_read_tokens, 0) as total_cache_read_tokens,
      COALESCE(m.total_cache_write_tokens, 0) as total_cache_write_tokens,
      COALESCE(m.total_cost_usd, 0) as total_cost_usd,
      COALESCE(m.total_lines_added, 0) as total_lines_added,
      COALESCE(m.total_commits, 0) as total_commits,
      COALESCE(m.total_prs, 0) as total_prs,
      COALESCE(m.total_active_seconds, 0) as total_active_seconds,
      if(COALESCE(e.total_prompts, 0) > 0, COALESCE(e.total_prompt_chars, 0) / e.total_prompts, 0) as avg_prompt_length
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
          countIf(event_name = 'claude_code.api_request') as total_prompts
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
          COALESCE(e.total_prompts, 0) as total_prompts,
          COALESCE(m.total_tokens, 0) as total_tokens,
          COALESCE(m.total_cost_usd, 0) as total_cost_usd,
          COALESCE(m.total_lines_added, 0) as total_lines_added
        FROM event_stats e
        FULL OUTER JOIN metric_stats m ON e.user_id = m.user_id
      ),
      ranked AS (
        SELECT
          user_id,
          row_number() OVER (ORDER BY ${sortColumn} DESC) as rank
        FROM user_totals
      )
    SELECT rank, (SELECT count() FROM ranked) as total
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
          countIf(event_name = 'claude_code.api_request') as prompts,
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
      COALESCE(e.prompts, 0) as prompts,
      COALESCE(m.inputTokens, 0) as inputTokens,
      COALESCE(m.outputTokens, 0) as outputTokens,
      COALESCE(m.cacheReadTokens, 0) as cacheReadTokens,
      COALESCE(m.cacheWriteTokens, 0) as cacheWriteTokens,
      COALESCE(m.costUsd, 0) as costUsd,
      COALESCE(m.linesAdded, 0) as linesAdded,
      COALESCE(m.linesRemoved, 0) as linesRemoved,
      COALESCE(m.commits, 0) as commits,
      COALESCE(m.activeSeconds, 0) as activeSeconds,
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

export async function getUserCacheStats(userId: string, days?: number): Promise<CacheStats | null> {
  const dateFilter = days ? `AND toDate(timestamp) >= today() - ${days}` : '';

  const sql = `
    SELECT
      sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead') as totalCacheReadTokens,
      sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'input') as totalInputTokens,
      if(
        sumIf(value, metric_name = 'claude_code.token.usage' AND token_type IN ('input', 'cacheRead')) > 0,
        sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead') * 100.0 /
        sumIf(value, metric_name = 'claude_code.token.usage' AND token_type IN ('input', 'cacheRead')),
        0
      ) as cacheHitRate,
      sumIf(value, metric_name = 'claude_code.token.usage' AND token_type = 'cacheRead') * 0.9 * 4 / 1000000 as estimatedSavingsUsd
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
    ${dateFilter}
  `;

  const result = await query<CacheStats>(sql, { userId });
  return result[0] || null;
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
      COUNT(*) as totalCalls,
      SUM(tool_success) as successCount,
      SUM(1 - tool_success) as failureCount,
      if(COUNT(*) > 0, SUM(tool_success) * 100.0 / COUNT(*), 0) as successRate,
      AVG(tool_duration_ms) as avgDurationMs
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
      toHour(timestamp) as hour,
      toDayOfWeek(timestamp) as dayOfWeek,
      SUM(input_tokens + output_tokens) as activity,
      COUNT(*) as promptCount
    FROM events_raw FINAL
    WHERE user_id = {userId:String}
      AND event_name = 'claude_code.api_request'
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
          countIf(event_name = 'claude_code.api_request') as prompts
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
      COALESCE(e.prompts, 0) as prompts,
      COALESCE(m.tokens, 0) as tokens,
      COALESCE(m.costUsd, 0) as costUsd,
      COALESCE(m.lines, 0) as lines
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
        AND event_name = 'claude_code.api_request'
        AND timestamp >= now() - INTERVAL {days:UInt32} DAY
        AND session_id != ''
      GROUP BY session_id
      HAVING prompt_count > 0
    )
    SELECT
      COUNT(*) as totalSessions,
      AVG(duration_minutes) as avgSessionMinutes,
      AVG(prompt_count) as avgPromptsPerSession,
      MAX(duration_minutes) as longestSessionMinutes
    FROM sessions
  `;

  const result = await query<SessionStats>(sql, { userId, days });
  return result[0] || null;
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
};

export default clickhouse;
