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
import { getModelPricing, type PricingMatchQuality } from '../lib/pricing';
import { bucketLabel, bucketSql, type ChartGroupBy } from '../lib/chart-buckets';
import { DEFAULT_TIMEZONE, normalizeTimezone } from '../lib/timezone';
import { ULTRATHINK_EVENT_NAME } from '../lib/ultrathink';

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
/** Default per-statement budget. A read that takes longer is a read that failed. */
const QUERY_TIMEOUT_MS = 10_000;

export interface QueryOptions {
  /**
   * Override the 10s budget. Only for statements that are SUPPOSED to take
   * minutes: a synchronous `ALTER ... DELETE` (mutations_sync = 2) and the big
   * `INSERT ... SELECT` in the one-off migrations. Aborting one of those
   * mid-flight leaves the table half-changed, which is the one outcome worse
   * than waiting — so the migration asks for the time it needs rather than
   * racing the default.
   */
  timeoutMs?: number;
}

export async function query<T = any>(
  sql: string,
  params?: Record<string, any>,
  options?: QueryOptions
): Promise<T[]> {
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
    signal: AbortSignal.timeout(options?.timeoutMs ?? QUERY_TIMEOUT_MS),
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
 * A UTF-16 code unit with no partner: half of a surrogate pair.
 *
 * Truncating a string by code units — which is what every `safeString(v, n)`
 * at the OTLP boundary does — can cut an emoji in half and leave one behind.
 * `JSON.stringify` then emits it as a bare `\ud83d`, and ClickHouse REJECTS
 * THE WHOLE BATCH with CANNOT_PARSE_ESCAPE_SEQUENCE. One truncated emoji in
 * one agent name therefore used to cost every datapoint in the export: the
 * insert threw, the route answered 500, and a 500 is retryable to the OTel
 * SDK, so the same doomed batch came back forever.
 *
 * Replacing with U+FFFD is not a lossy choice: Node already encodes a lone
 * surrogate as U+FFFD when it converts the string to UTF-8, so this is exactly
 * what the bytes were going to be — including the bytes the identity hash is
 * computed over. The hash is byte-identical before and after, which is why
 * this can live at the insert boundary without disturbing row_id.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const ANY_SURROGATE = /[\uD800-\uDFFF]/;

export function sanitizeForJson(value: string): string {
  // Almost every value is ASCII; the cheap test keeps the regex off the hot path.
  return ANY_SURROGATE.test(value) ? value.replace(LONE_SURROGATE, '�') : value;
}

function sanitizeRow(row: Record<string, any>): Record<string, any> {
  let copy: Record<string, any> | null = null;
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'string') continue;
    const clean = sanitizeForJson(value);
    if (clean === value) continue;
    copy ??= { ...row };
    copy[key] = clean;
  }
  return copy ?? row;
}

/**
 * Insert rows into a ClickHouse table
 */
export async function insert(table: string, rows: Record<string, any>[]): Promise<void> {
  if (rows.length === 0) return;

  const url = new URL(CLICKHOUSE_URL);
  url.searchParams.set('database', CLICKHOUSE_DATABASE);
  url.searchParams.set('query', `INSERT INTO ${table} FORMAT JSONEachRow`);

  const body = rows.map(row => JSON.stringify(sanitizeRow(row))).join('\n');

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
 * Where a raw row came from. Part of the row identity, so a reconstructed row
 * can never collapse onto a measured one.
 *   live             — received over OTLP from a running Claude Code (default)
 *   backfill         — reconstructed from local Claude Code JSONL transcripts
 *                      by src/scripts/backfill-jsonl.ts (operator-run)
 *   backfill-history — prompt counts recovered from ~/.claude/history.jsonl for
 *                      windows whose transcripts have rotated away
 *   legacy           — imported from the pre-OTEL SQLite `daily_stats` table by
 *                      docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts
 *   import           — reconstructed from the user's own transcripts by
 *                      `clawdgg import` (user-run, src/routes/cli.ts)
 *   hook             — reported by a local Claude Code hook that read something
 *                      we never receive. Today that is only the ultrathink flag
 *                      (cli/prompt-hook.ts): the prompt text is matched on the
 *                      user's machine and only the yes/no is sent.
 *   repair           — a token or cost datapoint REBUILT from the api_request
 *                      event that measured it, replacing a live row the old
 *                      sorting key had collapsed. Same measurement, recovered
 *                      from the other table that recorded it — see
 *                      docker/clickhouse/migrations/2026-10-19_repair_token_metrics.ts.
 *                      It is NOT an estimate, and it counts everywhere 'live'
 *                      counts.
 */
export type RowProvenance =
  | 'live'
  | 'backfill'
  | 'backfill-history'
  | 'legacy'
  | 'import'
  | 'hook'
  | 'repair';

export interface MetricRow {
  timestamp: string;
  user_id: string;
  session_id: string;
  metric_name: string;
  value: number;
  model?: string;
  token_type?: string;
  line_type?: string;
  time_type?: string;  // active_time.total: user (keyboard) | cli (tools + responses)
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
  marketplace_name?: string; // where plugin_name's plugin was installed from
  mcp_server_name?: string;
  mcp_tool_name?: string;
  start_type?: string;       // session.count: fresh | resume | continue | agents_view
  provenance?: RowProvenance;
  /**
   * How the model id matched the price table behind an ESTIMATED cost. Empty on
   * a live row: those carry Claude Code's own measured cost. NOT part of the
   * row identity — see the note on METRIC_IDENTITY_COLUMNS.
   */
  pricing_source?: PricingMatchQuality;
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
  /** Absolute paths are stripped at ingest — see redactAbsolutePaths(). */
  error_message?: string;
  error_type?: string;      // tool_result: "Error:ENOENT", "ShellError", …
  status_code?: number;
  duration_ms?: number;
  // tool_result / tool_decision attributes
  decision?: string;        // accept, reject (OTEL `decision_type` on tool_result)
  source?: string;          // config, user_permanent, … (OTEL `decision_source` on tool_result)
  tool_use_id?: string;
  tool_source?: string;     // tool_decision: builtin | mcp | sdk_host_builtin_mcp
  // Correlation + attribution
  prompt_id?: string;       // OTEL `prompt.id` — joins a prompt to its api_request calls
  request_id?: string;
  client_request_id?: string; // present even when the server never answered
  message_uuid?: string;      // OTEL `message.uuid` — the user message behind a prompt
  /**
   * OTEL `event.sequence`: 0-based per-process counter, the documented
   * tie-breaker for events sharing a timestamp. -1 when absent — see
   * NO_EVENT_SEQUENCE in src/routes/otel.ts.
   */
  event_sequence?: number;
  query_source?: string;    // main | subagent | auxiliary
  speed?: string;
  effort?: string;
  agent_name?: string;
  skill_name?: string;
  marketplace_name?: string;
  // user_prompt slash-command attribution (Claude Code 2.1.117+)
  command_name?: string;
  command_source?: string;  // builtin | custom | mcp
  terminal_type?: string;
  app_version?: string;
  account_uuid?: string;
  organization_id?: string;
  provenance?: RowProvenance;
  /** See MetricRow.pricing_source. */
  pricing_source?: PricingMatchQuality;
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
  // Token breakdown, for the profile's token-flow bar
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
 * only by model, query_source, speed, effort, agent/skill/plugin/mcp name,
 * tool/decision/language, or `type` (active_time.total splits into user and
 * cli). Those collapsed into one row and their values were lost — main-thread
 * and subagent token usage at the same instant became a single number. Hashing
 * every identifying attribute into the key keeps them apart.
 *
 * `event_sequence` (OTEL `event.sequence`) is the general case of the same
 * problem on events: the docs name it as the tie-breaker for records sharing a
 * timestamp, so it separates even the event types this schema has no dedicated
 * columns for. It is -1, not 0, when a record carries none.
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
  'time_type',
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
  'marketplace_name',
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
  'event_sequence',
  'tool_name',
  'tool_use_id',
  'tool_source',
  'model',
  'decision',
  'source',
  'request_id',
  'client_request_id',
  'prompt_id',
  'message_uuid',
  'command_name',
  'command_source',
  'query_source',
  'speed',
  'effort',
  'agent_name',
  'skill_name',
  'marketplace_name',
  'status_code',
  'error_type',
  'error_message',
  'provenance',
] as const;

/**
 * Identity columns that are NUMERIC in ClickHouse, with the value TS must hash
 * when the row leaves one unset. The SQL side hashes toString(column), which
 * renders the column DEFAULT — so an omitted field has to hash as that exact
 * default here or the two sides disagree on every row that omits it.
 */
const EVENT_IDENTITY_NUMERIC_DEFAULTS: Record<string, number> = {
  status_code: 0,
  event_sequence: -1,
};

// Unit separator: cannot appear in an OTLP attribute value we keep, so
// ('a', 'bc') and ('ab', 'c') can never hash alike.
const IDENTITY_SEPARATOR = '\u001f';

/**
 * Exported for identities that are NOT a column list — the token/cost repair
 * hashes (source event row_id, metric_name, token_type) so each derived row
 * inherits the identity of the request it was rebuilt from. Any such caller
 * must pass the same parts, in the same order, that its SQL side concatenates
 * (identitySqlExpr), or the two disagree on every row.
 */
export function identityHash(parts: string[]): string {
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
      const numericDefault = EVENT_IDENTITY_NUMERIC_DEFAULTS[c];
      if (numericDefault !== undefined) return String(r[c] ?? numericDefault);
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
// Query Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What counts as a "prompt". USE THIS, never a bare event_name check — the
 * number it produces is the headline metric on every surface, so it has to
 * mean the same thing everywhere.
 *
 * THE RULE: a user_prompt event, excluding builtin slash commands.
 *
 * Since Claude Code 2.1.117 a slash command also emits claude_code.user_prompt,
 * tagged with `command_name` / `command_source`. `command_source = 'builtin'`
 * is a UI action — /clear, /compact, /model, /resume — not a request to Claude,
 * and counting those inflates the number with keystrokes that never reached a
 * model. Custom, plugin and `mcp` commands ARE requests and still count.
 *
 * Rows with `command_source = ''` count, and that is correct for all four
 * kinds of row that have it:
 *
 *   - free-typed prompts, which carry no command at all
 *   - anything ingested before Claude Code 2.1.117, which did not send the
 *     attribute
 *   - JSONL-reconstructed rows (`backfill`, `backfill-history`, `import`):
 *     src/lib/session-import.ts applies the SAME rule at the source and by
 *     default, dropping built-in commands — including the ones Claude Code
 *     wraps in `<command-name>` tags — while keeping custom, skill and MCP
 *     commands. So a built-in never reaches ClickHouse as a reconstructed row,
 *     and the custom ones that do are rows this predicate should count.
 *   - pre-OTEL `legacy` rows, where daily_stats recorded a prompt count and
 *     nothing about what was typed. Those counts came from a CLI that did not
 *     distinguish commands either, so they are taken as given.
 *
 * Any new importer must mirror that: drop built-in commands at the source, or
 * set command_source so this predicate can do it.
 */
export const PROMPT_EVENT_SQL =
  `event_name = 'claude_code.user_prompt' AND command_source != 'builtin'`;

/**
 * Excludes rows reconstructed from the pre-OTEL SQLite `daily_stats` table.
 *
 * Those rows are honest about WHAT happened on a day and silent about WHEN and
 * HOW: daily_stats held one row per day, so the import puts every row at 12:00
 * UTC, leaves `session_id` and `model` empty, and sets `tool_success = 1`
 * because the old CLI counted tool calls and not their outcomes.
 *
 * Counts and sums over those rows are correct and must include them. Anything
 * that reads the SHAPE of a day — hour of the week, per-session structure,
 * api-calls-per-prompt, a success rate — must not, or it reports a noon spike,
 * a 100% tool success rate and a collapsed agentic ratio that nobody lived.
 */
export const NO_LEGACY_SQL = `provenance != 'legacy'`;

/**
 * MANDATORY on every FULL OUTER JOIN in this file. Not a tuning knob.
 *
 * ClickHouse's default fills an unmatched side with the column's DEFAULT, not
 * with NULL — so `COALESCE(e.user_id, m.user_id)` returns `''` for a user who
 * has metric rows and no events, and `COALESCE(e.date, m.date)` returns
 * `1970-01-01`. Both were happening: a metrics-only day came back dated 1970,
 * which the sync job then stored as the user's first session, and a
 * metrics-only user came back under the empty user id. Verified against a real
 * clickhouse-local: the same join reads `('', 1970-01-01)` by default and
 * `('u2', 2026-09-01)` with this setting.
 *
 * src/db/join-nulls.test.ts asserts no FULL OUTER JOIN here is missing it.
 */
export const JOIN_NULLS_SETTING = `SETTINGS join_use_nulls = 1`;

/**
 * A prompt that contained the word "ultrathink", recorded WITHOUT its text.
 *
 * These are synthetic rows: there is no such OTEL event. A local Claude Code
 * hook (and the history import) decides the yes/no on the user's machine and
 * only the flag leaves it — see cli/index.ts `prompt-hook`.
 *
 * `clawdgg.` rather than `claude_code.` on purpose. The prefix is what keeps
 * these rows out of every existing query: PROMPT_EVENT_SQL, the api_request
 * and tool_result counts all name a `claude_code.*` event, so a flag can never
 * be mistaken for a prompt or an API call. src/db/ultrathink-events.test.ts
 * holds the read layer to that.
 */
export { ULTRATHINK_EVENT_NAME };
export const ULTRATHINK_EVENT_SQL = `event_name = '${ULTRATHINK_EVENT_NAME}'`;

/**
 * Only the events Claude Code itself emitted.
 *
 * USE THIS wherever a query's POPULATION comes out of events_raw — the user set
 * on a board, the date set behind a streak, a "has this person used it" check.
 * The synthetic ultrathink rows are in the same table with a `clawdgg.` prefix,
 * and while no COUNT includes them (every count names a `claude_code.*` event),
 * a bare `GROUP BY user_id` or `GROUP BY toDate(timestamp)` does: a flag on a
 * day with no prompts manufactured an active day, and a user whose only row is
 * a flag was an entrant on the leaderboard with zeroes across the board.
 */
export const CLAUDE_CODE_EVENT_SQL = `startsWith(event_name, 'claude_code.')`;

/**
 * Ultrathink flags, CAPPED AT ONE PER PROMPT PER DAY. The ONE definition.
 *
 * A flag is a synthetic row a local hook posts, so nothing in the transport
 * stops a client from sending more of them than it sent prompts — and an
 * uncapped count ranks whoever scripted the hook hardest, while a share of
 * prompts could read over 100%. `least(flags, prompts)` per user per day cannot
 * exceed what that day's prompts could have carried, and it costs an honest
 * user nothing: for them flags <= prompts holds on every day already, so the
 * capped total and the raw total are the same number.
 *
 * It is a per-(user, day) AGGREGATE expression, not a whole query, because the
 * grouping is the caller's: the profile groups by the user's own local day, the
 * boards by each user's local day via a multiIf offset, and the cross-user
 * rarity comparison by UTC day (one query cannot hold a hundred zones). All
 * three read the same expression — see fetchPeerTotals for why the UTC variant
 * differs only for an abuser.
 *
 * LOAD-BEARING ASSUMPTION: a flag carries the same instant as the prompt it
 * describes. Both sources guarantee it — the hook posts the prompt's own
 * timestamp, and the history import emits both rows from one record — and the
 * cap depends on it: a flag grouped into a different day from its prompt is a
 * day with flags and no prompts, which `least` reduces to zero. Verified
 * against clickhouse-local, which is also how that was found: a fixture that
 * put them an hour apart capped an honest count away. The residual is a prompt
 * submitted across local midnight whose two rows land on opposite sides of the
 * millisecond, which is at most one flag per user per lifetime.
 */
export const CAPPED_ULTRATHINKS_SQL =
  `least(countIf(${ULTRATHINK_EVENT_SQL}), countIf(${PROMPT_EVENT_SQL}))`;

/**
 * `timestamp` in the user's own wall clock. Every hour-of-day, weekday and
 * week-boundary read goes through this, never bare `toHour(timestamp)`.
 *
 * Why: a 23:00 prompt in Paris is 22:00 UTC and a Monday-morning one in
 * Auckland is a Sunday prompt in UTC — the figure does not just shift, it lands
 * in the wrong bucket and (for a week) the wrong week. UTC hours made every
 * non-UTC user's peak hour and weekday ring wrong by their offset.
 *
 * The caller passes `tz` as a query parameter (an IANA name validated by
 * src/lib/timezone.ts). ClickHouse substitutes a parameter before parsing, so
 * it satisfies toTimeZone's constant-argument requirement.
 *
 * ALWAYS combine with NO_LEGACY_SQL: the pre-OTEL daily_stats rows are all
 * stamped 12:00 UTC, so converting them produces a spike at whatever 12:00 UTC
 * is locally — an artefact of the import, not an hour anyone worked.
 */
export const LOCAL_TS_SQL = `toTimeZone(timestamp, {tz:String})`;

/**
 * Model id reduced to its bare form for GROUPING, mirroring
 * stripModelDecorations() in src/lib/pricing.ts: a Bedrock region/vendor
 * prefix, a `-v1:0` revision, and a bracketed context variant all come off, so
 * `claude-opus-5-5` and `claude-opus-5-5[1m]` are one row in the model mix
 * instead of two labels for the same model. The date snapshot stays — it is
 * what the user recognises and a real price-table key.
 */
const MODEL_DECORATION_PATTERNS = [
  String.raw`^(?:us|eu|apac|global)\.`,
  String.raw`^anthropic\.`,
  String.raw`\[[^\]]*\]$`,
  String.raw`-v\d+:\d+$`,
];

// ClickHouse string literals process backslash escapes, so every `\` in the
// pattern has to survive one extra round of unescaping on the way in.
function chRegexLiteral(pattern: string): string {
  return `'${pattern.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export const MODEL_ID_SQL = MODEL_DECORATION_PATTERNS.reduce(
  (expr, pattern) => `replaceRegexpOne(${expr}, ${chRegexLiteral(pattern)}, '')`,
  'lower(model)'
);

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
          countIf(${PROMPT_EVENT_SQL}) as total_prompts,
          sumIf(prompt_length, ${PROMPT_EVENT_SQL} AND prompt_length > 0) as total_prompt_chars,
          countIf(${PROMPT_EVENT_SQL} AND prompt_length > 0) as total_measured_prompts
        FROM events_raw FINAL
        ${whereClause ? `${whereClause} AND ${CLAUDE_CODE_EVENT_SQL}` : `WHERE ${CLAUDE_CODE_EVENT_SQL}`}
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
      toFloat64(if(COALESCE(e.total_measured_prompts, 0) > 0, COALESCE(e.total_prompt_chars, 0) / e.total_measured_prompts, 0)) as avg_prompt_length
    FROM event_stats e
    FULL OUTER JOIN metric_stats m ON e.user_id = m.user_id
    ${JOIN_NULLS_SETTING}
  `;

  return query<UserTotals>(sql, userId ? { userId } : undefined);
}

/**
 * Get daily metrics for a user (for contribution graph)
 *
 * `sessions` is `claude_code.session.count` — sessions STARTED — and not
 * `uniqExact(session_id)`. One definition that holds for every source: live
 * OTEL emits the metric, the JSONL import counts transcripts, and the
 * pre-OTEL daily_stats import carries the old CLI's own session count. The
 * uniqExact version read 1 for every imported day (those rows have no
 * session_id) and silently disagreed with the number the CLI used to show.
 */
export async function getUserDailyMetrics(userId: string, days: number = 365): Promise<DailyMetrics[]> {
  const sql = `
    WITH
      daily_events AS (
        SELECT
          toDate(timestamp) as date,
          countIf(${PROMPT_EVENT_SQL}) as prompts
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND toDate(timestamp) >= today() - {days:UInt32}
          -- The DATE SET, not just the count: an ultrathink flag on a day with
          -- no prompts used to manufacture an active day here, which the sync
          -- job then counted into a streak.
          AND ${CLAUDE_CODE_EVENT_SQL}
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
          sumIf(value, metric_name = 'claude_code.session.count') as sessions,
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
      toUInt64(COALESCE(m.sessions, 0)) as sessions,
      toUInt64(COALESCE(m.active_seconds, 0)) as active_seconds,
      toUInt64(COALESCE(e.prompts, 0)) as prompts
    FROM daily_events e
    FULL OUTER JOIN daily_metrics m ON e.date = m.date
    ORDER BY date
    ${JOIN_NULLS_SETTING}
  `;

  return query<DailyMetrics>(sql, { userId, days });
}

/**
 * The local days a user actually sent a prompt on. ONE streak definition.
 *
 * A streak was computed three different ways: the sync job walked every UTC
 * date `getUserDailyMetrics` returned (which included days with no prompts at
 * all, and — before CLAUDE_CODE_EVENT_SQL — days whose only row was an
 * ultrathink flag), while the profile's milestones walk LOCAL days with
 * `prompts > 0`. Two numbers for one word is the thing the data-integrity rule
 * forbids, so this is the definition and both callers read it.
 *
 * Local, because a streak is a run of DAYS AS THE USER LIVED THEM: a 23:00
 * prompt in Paris is the previous UTC day, so a UTC streak breaks for someone
 * who works late and never for someone who works early. `prompts > 0`, because
 * a day Claude spent tokens on without being asked anything is not a day the
 * user showed up — that is a background job, a retry or a subagent finishing.
 */
export async function getUserActiveLocalDays(
  userId: string,
  tz?: string,
  days: number = 365
): Promise<string[]> {
  const rows = await query<{ date: string }>(
    `SELECT toString(toDate(${LOCAL_TS_SQL})) as date
     FROM events_raw FINAL
     WHERE user_id = {userId:String}
       AND toDate(timestamp) >= today() - {days:UInt32}
       AND ${PROMPT_EVENT_SQL}
     GROUP BY date
     HAVING count() > 0
     ORDER BY date`,
    { userId, days, tz: normalizeTimezone(tz) }
  );
  return rows.map((row) => row.date);
}

/**
 * Get model usage breakdown for a user (Claude Diet)
 *
 * Grouped on the decoration-stripped id (MODEL_ID_SQL), so the 1M-context
 * variant `…[1m]` and the Bedrock/Vertex spellings do not show up as extra
 * models alongside the id they are variants of.
 */
export async function getUserModelUsage(userId: string, days?: number): Promise<ModelUsage[]> {
  const dateFilter = days ? `AND toDate(timestamp) >= today() - ${days}` : '';

  const sql = `
    SELECT
      ${MODEL_ID_SQL} as model,
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
 * Get hourly activity for heatmap, in the user's own wall clock.
 *
 * `day_of_week` is ClickHouse's default mode: 1 = Monday … 7 = Sunday.
 */
export async function getUserHourlyActivity(
  userId: string,
  days: number = 90,
  tz: string = DEFAULT_TIMEZONE
): Promise<HourlyActivity[]> {
  const sql = `
    SELECT
      toUInt8(toHour(${LOCAL_TS_SQL})) as hour,
      toUInt8(toDayOfWeek(${LOCAL_TS_SQL})) as day_of_week,
      toUInt64(sumIf(value, metric_name = 'claude_code.token.usage')) as activity
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND ${NO_LEGACY_SQL}
      AND timestamp >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY hour, day_of_week
    ORDER BY day_of_week, hour
  `;

  return query<HourlyActivity>(sql, { userId, days, tz: normalizeTimezone(tz) });
}

/**
 * Get leaderboard data
 */
export type LeaderboardSort = 'prompts' | 'tokens' | 'cost' | 'lines' | 'commits';

export async function getLeaderboard(
  period: 'today' | 'week' | 'month' | 'all',
  sortBy: LeaderboardSort = 'prompts',
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
    commits: 'total_commits',
  }[sortBy];

  const sql = `
    WITH
      event_stats AS (
        SELECT
          user_id,
          countIf(${PROMPT_EVENT_SQL}) as total_prompts,
          sumIf(prompt_length, ${PROMPT_EVENT_SQL} AND prompt_length > 0) as total_prompt_chars,
          countIf(${PROMPT_EVENT_SQL} AND prompt_length > 0) as total_measured_prompts
        FROM events_raw FINAL
        WHERE ${dateFilter}
          -- The ENTRANT SET: a user whose only row in the period is an
          -- ultrathink flag is not on the leaderboard with zeroes, they are
          -- not on it. The count below already agreed; this makes the rows do.
          AND ${CLAUDE_CODE_EVENT_SQL}
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
      toFloat64(if(COALESCE(e.total_measured_prompts, 0) > 0, COALESCE(e.total_prompt_chars, 0) / e.total_measured_prompts, 0)) as avg_prompt_length
    FROM event_stats e
    FULL OUTER JOIN metric_stats m ON e.user_id = m.user_id
    -- user_id is a TIEBREAKER, not decoration: two users on the same total
    -- come back in an arbitrary order without it, and the rank snapshot then
    -- shows both of them a phantom move every day. Same ordering as the
    -- all-time board's (src/routes/api.ts) and the snapshot's
    -- (src/lib/rank-snapshots.ts), which is the point.
    ORDER BY ${sortColumn} DESC, user_id ASC
    LIMIT {limit:UInt32}
    OFFSET {offset:UInt32}
    ${JOIN_NULLS_SETTING}
  `;

  const entries = await query<UserTotals>(sql, { limit, offset });

  // Everyone with a PROMPT in the period, which is what the board ranks on.
  // Without the predicate this counted users with any row at all, including
  // ones whose only rows are synthetic (an ultrathink flag is not an entrant).
  const countSql = `
    SELECT count(DISTINCT user_id) as total
    FROM events_raw FINAL
    WHERE ${dateFilter}
      AND ${PROMPT_EVENT_SQL}
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
          countIf(${PROMPT_EVENT_SQL}) as total_prompts
        FROM events_raw FINAL
        WHERE ${dateFilter}
          AND ${CLAUDE_CODE_EVENT_SQL}
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
          row_number() OVER (ORDER BY ${sortColumn} DESC, user_id ASC) as rank
        FROM user_totals
      )
    SELECT toUInt64(rank) as rank, toUInt64((SELECT count() FROM ranked)) as total
    FROM ranked
    WHERE user_id = {userId:String}
    ${JOIN_NULLS_SETTING}
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
          countIf(${PROMPT_EVENT_SQL}) as prompts,
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
 *
 * Rows with no model are EXCLUDED rather than priced: the pre-OTEL daily_stats
 * import never recorded a model, so pricing those rows would mean inventing a
 * saving from DEFAULT_PRICING and presenting the guess as a dollar figure.
 */
export async function getUserCacheStats(userId: string, days?: number): Promise<CacheStats | null> {
  const dateFilter = days ? `AND toDate(timestamp) >= today() - ${days}` : '';

  // Grouped by speed as well as model: Opus fast mode bills input at 2x, so a
  // cache read against a fast-mode prompt saves twice as much. Haiku 5.5's
  // over-100K tier is NOT applied here and cannot be — it is decided per
  // request, and these are sums over many.
  const sql = `
    SELECT
      model,
      speed,
      toUInt64(sumIf(value, token_type = 'cacheRead')) as cacheReadTokens,
      toUInt64(sumIf(value, token_type = 'input')) as inputTokens
    FROM metrics_raw FINAL
    WHERE user_id = {userId:String}
      AND metric_name = 'claude_code.token.usage'
      AND token_type IN ('input', 'cacheRead')
      AND model != ''
      ${dateFilter}
    GROUP BY model, speed
  `;

  const rows = await query<{
    model: string;
    speed: string;
    cacheReadTokens: number;
    inputTokens: number;
  }>(sql, { userId });

  let totalCacheReadTokens = 0;
  let totalInputTokens = 0;
  let estimatedSavingsUsd = 0;
  for (const row of rows) {
    const cacheRead = Number(row.cacheReadTokens) || 0;
    const input = Number(row.inputTokens) || 0;
    totalCacheReadTokens += cacheRead;
    totalInputTokens += input;
    const pricing = getModelPricing(row.model, { speed: row.speed });
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
      AND ${NO_LEGACY_SQL}
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

export async function getActivityHeatmap(
  userId: string,
  days: number = 90,
  tz: string = DEFAULT_TIMEZONE
): Promise<HeatmapCell[]> {
  const sql = `
    SELECT
      toUInt8(toHour(${LOCAL_TS_SQL})) as hour,
      toUInt8(toDayOfWeek(${LOCAL_TS_SQL})) as dayOfWeek,
      toUInt64(SUM(input_tokens + output_tokens)) as activity,
      toUInt64(COUNT(*)) as promptCount
    FROM events_raw FINAL
    WHERE user_id = {userId:String}
      AND ${PROMPT_EVENT_SQL}
      AND ${NO_LEGACY_SQL}
      AND timestamp >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY hour, dayOfWeek
    ORDER BY dayOfWeek, hour
  `;

  return query<HeatmapCell>(sql, { userId, days, tz: normalizeTimezone(tz) });
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
          countIf(${PROMPT_EVENT_SQL}) as prompts
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND toDate(timestamp) >= today() - {days:UInt32}
          AND ${CLAUDE_CODE_EVENT_SQL}
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
    ${JOIN_NULLS_SETTING}
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
        AND ${PROMPT_EVENT_SQL}
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
  // 'YYYY-MM' (month), or the hour label for the 1d view.
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
 * Get chart data for the flexible analytics chart (OTEL/ClickHouse)
 */
export async function getChartData(
  userId: string,
  metric: ChartMetric,
  period: ChartPeriod,
  groupBy: ChartGroupBy = 'day',
  tz: string = DEFAULT_TIMEZONE
): Promise<ChartData> {
  // For "1d" (today), we group by hour; otherwise by the requested bucket
  const isHourly = period === '1d';

  // Calculate date range
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365;
  // The 1d view is hour-of-day, so BOTH its bucket and its day boundary are the
  // user's own: a "today" that ends at 00:00 UTC cuts a Tokyo afternoon in half
  // and an Auckland user's day before it starts. The multi-day windows stay on
  // UTC days — there the boundary moves one partial day at the far end of the
  // range, which is not a figure anyone reads.
  const dateFilter = period === '1d'
    ? `AND toDate(${LOCAL_TS_SQL}) = toDate(toTimeZone(now(), {tz:String}))`
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
  const groupByClause = isHourly ? `toHour(${LOCAL_TS_SQL}) as hour` : bucketSql(groupBy);
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
          toUInt64(countIf(${PROMPT_EVENT_SQL})) as totalValue
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

  const rawData = await query<ChartDataPoint>(sql, { userId, tz: normalizeTimezone(tz) });

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
    // NOT rounded here. Rounding is a display decision and the client makes it
    // per metric; pre-rounding to a whole number threw away every cent of a
    // cost total, so a $0.42 day read as 0.
    summary: { total, average, peak, trend },
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
          toUInt64(countIf(${PROMPT_EVENT_SQL})) as totalPrompts
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND ${NO_LEGACY_SQL}
          ${dateFilter}
      ),
      session_stats AS (
        SELECT
          session_id,
          countIf(event_name = 'claude_code.api_request') as api_calls,
          countIf(${PROMPT_EVENT_SQL}) as prompts
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          AND session_id != ''
          AND ${NO_LEGACY_SQL}
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
      AND ${PROMPT_EVENT_SQL}
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
 * Where a user's numbers came from, by provenance.
 *
 * This replaces the old `dataSources` block on /api/me/insights, which
 * reported "legacy vs OTEL" by SUBTRACTING the frozen users.legacy_total_*
 * snapshot from the synced total — a derivation that went negative the moment
 * either number moved for any other reason. Asking ClickHouse directly is both
 * honest and exhaustive: every row has a provenance, so the parts add up to
 * the whole by construction. That is the "traceable" half of the data-integrity
 * rule — any displayed number can be followed back to the rows behind it.
 */
export interface ProvenanceBreakdown {
  provenance: string;
  prompts: number;
  tokens: number;
  costUsd: number;
  firstDay: string | null;
  lastDay: string | null;
}

export async function getUserProvenanceBreakdown(userId: string): Promise<ProvenanceBreakdown[]> {
  const sql = `
    WITH
      event_parts AS (
        SELECT provenance,
               countIf(${PROMPT_EVENT_SQL}) as prompts,
               toString(min(toDate(timestamp))) as first_day,
               toString(max(toDate(timestamp))) as last_day
        FROM events_raw FINAL
        WHERE user_id = {userId:String}
          -- A provenance whose only rows are ultrathink flags contributes no
          -- prompt, no token and no dollar, so listing it as a source of the
          -- numbers would be a row of zeroes claiming to explain something.
          AND ${CLAUDE_CODE_EVENT_SQL}
        GROUP BY provenance
      ),
      metric_parts AS (
        SELECT provenance,
               sumIf(value, metric_name = 'claude_code.token.usage') as tokens,
               sumIf(value, metric_name = 'claude_code.cost.usage') as cost_usd
        FROM metrics_raw FINAL
        WHERE user_id = {userId:String}
        GROUP BY provenance
      )
    SELECT
      COALESCE(e.provenance, m.provenance) as provenance,
      toUInt64(COALESCE(e.prompts, 0)) as prompts,
      toUInt64(COALESCE(m.tokens, 0)) as tokens,
      toFloat64(COALESCE(m.cost_usd, 0)) as costUsd,
      e.first_day as firstDay,
      e.last_day as lastDay
    FROM event_parts e
    FULL OUTER JOIN metric_parts m ON e.provenance = m.provenance
    ORDER BY prompts DESC, tokens DESC
    ${JOIN_NULLS_SETTING}
  `;

  return query<ProvenanceBreakdown>(sql, { userId });
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
  getUserActiveLocalDays,
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
  // NEW: Profile Signature Insights
  getUserLanguageStats,
  getUserTrustStyle,
  getUserAgenticStats,
  getUserPromptLengthStats,
  getTodayLanguages,
  getUserTerminalStats,
  getUserTodayMetricsEnhanced,
  getUserProvenanceBreakdown,
};

export default clickhouse;
