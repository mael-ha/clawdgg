/**
 * ClickHouse client for clawd.gg
 * Handles all OTel metrics and events storage/retrieval
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
}

export interface UserTotals {
  user_id: string;
  total_prompts: number;
  total_tokens: number;
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
// Query Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get user totals for leaderboard sync
 */
export async function getUserTotals(userId?: string): Promise<UserTotals[]> {
  const whereClause = userId ? `WHERE md.user_id = {userId:String}` : '';

  const sql = `
    SELECT
      md.user_id,
      SUM(ps.prompt_count) as total_prompts,
      SUM(md.input_tokens + md.output_tokens) as total_tokens,
      SUM(md.cost_usd) as total_cost_usd,
      SUM(md.lines_added) as total_lines_added,
      SUM(md.commits) as total_commits,
      SUM(md.prs) as total_prs,
      SUM(md.active_seconds) as total_active_seconds,
      if(SUM(ps.prompt_count) > 0, SUM(ps.total_prompt_chars) / SUM(ps.prompt_count), 0) as avg_prompt_length
    FROM metrics_daily md
    LEFT JOIN prompt_stats_daily ps ON md.user_id = ps.user_id AND md.date = ps.date
    ${whereClause}
    GROUP BY md.user_id
  `;

  return query<UserTotals>(sql, userId ? { userId } : undefined);
}

/**
 * Get daily metrics for a user (for contribution graph)
 */
export async function getUserDailyMetrics(userId: string, days: number = 365): Promise<DailyMetrics[]> {
  const sql = `
    SELECT
      md.user_id,
      toString(md.date) as date,
      md.input_tokens,
      md.output_tokens,
      md.cache_read_tokens,
      md.cache_write_tokens,
      md.cost_usd,
      md.lines_added,
      md.lines_removed,
      md.commits,
      md.prs,
      md.sessions,
      md.active_seconds
    FROM metrics_daily md
    WHERE md.user_id = {userId:String}
      AND md.date >= today() - {days:UInt32}
    ORDER BY md.date
  `;

  return query<DailyMetrics>(sql, { userId, days });
}

/**
 * Get model usage breakdown for a user (Claude Diet)
 */
export async function getUserModelUsage(userId: string, days?: number): Promise<ModelUsage[]> {
  const dateFilter = days ? `AND date >= today() - {days:UInt32}` : '';

  const sql = `
    SELECT
      model,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cost_usd) as cost_usd
    FROM model_usage_daily
    WHERE user_id = {userId:String}
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
      toHour(hour) as hour,
      toDayOfWeek(hour) as day_of_week,
      SUM(total_tokens) as activity
    FROM metrics_hourly
    WHERE user_id = {userId:String}
      AND hour >= now() - INTERVAL {days:UInt32} DAY
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
    today: 'date = today()',
    week: 'date >= today() - 7',
    month: 'date >= today() - 30',
    all: '1=1',
  }[period];

  const sortColumn = {
    prompts: 'total_prompts',
    tokens: 'total_tokens',
    cost: 'total_cost_usd',
    lines: 'total_lines_added',
  }[sortBy];

  const sql = `
    SELECT
      md.user_id,
      SUM(ps.prompt_count) as total_prompts,
      SUM(md.input_tokens + md.output_tokens) as total_tokens,
      SUM(md.cost_usd) as total_cost_usd,
      SUM(md.lines_added) as total_lines_added,
      SUM(md.commits) as total_commits,
      SUM(md.prs) as total_prs,
      SUM(md.active_seconds) as total_active_seconds,
      if(SUM(ps.prompt_count) > 0, SUM(ps.total_prompt_chars) / SUM(ps.prompt_count), 0) as avg_prompt_length
    FROM metrics_daily md
    LEFT JOIN prompt_stats_daily ps ON md.user_id = ps.user_id AND md.date = ps.date
    WHERE ${dateFilter}
    GROUP BY md.user_id
    ORDER BY ${sortColumn} DESC
    LIMIT {limit:UInt32}
    OFFSET {offset:UInt32}
  `;

  const entries = await query<UserTotals>(sql, { limit, offset });

  // Get total count
  const countSql = `
    SELECT count(DISTINCT user_id) as total
    FROM metrics_daily
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
    today: 'date = today()',
    week: 'date >= today() - 7',
    month: 'date >= today() - 30',
    all: '1=1',
  }[period];

  const sortColumn = {
    prompts: 'total_prompts',
    tokens: 'total_tokens',
    cost: 'total_cost_usd',
    lines: 'total_lines_added',
  }[sortBy];

  const sql = `
    WITH user_totals AS (
      SELECT
        md.user_id,
        SUM(ps.prompt_count) as total_prompts,
        SUM(md.input_tokens + md.output_tokens) as total_tokens,
        SUM(md.cost_usd) as total_cost_usd,
        SUM(md.lines_added) as total_lines_added
      FROM metrics_daily md
      LEFT JOIN prompt_stats_daily ps ON md.user_id = ps.user_id AND md.date = ps.date
      WHERE ${dateFilter}
      GROUP BY md.user_id
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
};

export default clickhouse;
