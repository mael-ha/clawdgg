/**
 * ClickHouse client for clawd.gg
 * Handles all OTel metrics and events storage/retrieval
 *
 * ARCHITECTURE:
 * - Raw tables use ReplacingMergeTree for deduplication
 * - Reads do not use FINAL: identity is enforced at write time (see insert())
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
import { DEFAULT_TIMEZONE, normalizeTimezone } from '../lib/timezone';
import { ULTRATHINK_EVENT_NAME } from '../lib/ultrathink';
import { recordClickhouse } from '../lib/request-timing';

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

// ═══════════════════════════════════════════════════════════════════════════
// Read Concurrency
// ═══════════════════════════════════════════════════════════════════════════

/**
 * HOW MANY READS MAY BE INSIDE CLICKHOUSE AT ONCE. Not a tuning knob — this is
 * what stops a profile render from taking the server down.
 *
 * Every read here USED TO BE `... FINAL`, which means merging the
 * ReplacingMergeTree parts in memory, and the sorting key ends in `row_id` (32
 * hex chars) so the merge carried that column too. One profile query over a 1.5M-event user
 * costs 116–285 MiB, measured from system.query_log. A single profile render
 * fires ~25–30 of them at once through nested `Promise.all`s (src/routes/
 * profile.tsx, src/lib/fingerprint.ts, src/lib/profile-data.ts), and prod's
 * `max_server_memory_usage` is under 3 GiB with ~660 MiB already resident. The
 * fan-out therefore did not run slowly, it ran out of memory: ClickHouse's
 * OvercommitTracker killed the queries with MEMORY_LIMIT_EXCEEDED and the page
 * answered 503. Four at a time fits; raising the server cap alone does not,
 * because 30 x 150 MiB exceeds any cap this box can hold.
 *
 * INSERTS DO NOT TAKE A PERMIT. Ingestion is the one thing that must never
 * queue behind somebody's profile — a slow OTLP route makes exporters retry,
 * and a retry storm is how a read problem becomes a write problem.
 *
 * The queue is FIFO, so a page that waits is served before a page that arrives
 * later: a lifo queue starves the first request under sustained load.
 */
const DEFAULT_MAX_CONCURRENT_READS = 4;

/** Exported for the test — the parse is the part worth asserting on. */
export function resolveReadConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MAX_CONCURRENT_READS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(
      `[ClickHouse] ignoring CLICKHOUSE_MAX_CONCURRENT_READS=${raw}; using ${DEFAULT_MAX_CONCURRENT_READS}`
    );
    return DEFAULT_MAX_CONCURRENT_READS;
  }
  return parsed;
}

const MAX_CONCURRENT_READS = resolveReadConcurrency(process.env.CLICKHOUSE_MAX_CONCURRENT_READS);

/** Permits GRANTED, held or handed over — never the number of running fetches. */
let readsInFlight = 0;
const readQueue: (() => void)[] = [];

/**
 * Run `fn` holding one of MAX_CONCURRENT_READS permits.
 *
 * The permit is handed STRAIGHT to the next waiter rather than released and
 * re-acquired: resolving a promise only schedules a microtask, so a decrement
 * here would let a caller arriving in between see a free slot that the waiter
 * is about to take, and briefly run MAX+1 reads. Which is exactly the state
 * this exists to prevent. A waiter therefore inherits its permit and does not
 * increment.
 *
 * The release is in a `finally`, so it happens on success, throw, timeout and
 * abort alike. A leaked permit would deadlock every page on the site.
 */
async function withReadPermit<T>(fn: () => Promise<T>): Promise<T> {
  if (readsInFlight >= MAX_CONCURRENT_READS) {
    await new Promise<void>(resolve => readQueue.push(resolve));
  } else {
    readsInFlight++;
  }

  try {
    return await fn();
  } finally {
    const next = readQueue.shift();
    if (next) next();
    else readsInFlight--;
  }
}

export async function query<T = any>(
  sql: string,
  params?: Record<string, any>,
  options?: QueryOptions
): Promise<T[]> {
  // For the Server-Timing header (src/lib/request-timing.ts): from the call to
  // the answer, permit wait included, because that is what the request paid.
  const start = performance.now();
  try {
    return await runQuery<T>(sql, params, options);
  } finally {
    recordClickhouse(performance.now() - start);
  }
}

async function runQuery<T>(
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

  // THE TIMEOUT STARTS WHEN THE QUERY DOES, not when it was asked for: the
  // signal is created inside the permit, so the 10s budget covers the HTTP
  // exchange only. Counting the queue wait against it would mean the 25th
  // query of a profile render fails for being 25th — the queue exists to make
  // the fan-out survivable, and a budget that the queue itself can exhaust
  // just moves the 503 from ClickHouse to here. The wait is bounded anyway:
  // four reads at a 10s ceiling each.
  const { ok, body } = await withReadPermit(async () => {
    const response = await fetch(url.toString(), {
      method: 'POST',
      body: sql,
      headers: {
        'Content-Type': 'text/plain',
      },
      signal: AbortSignal.timeout(options?.timeoutMs ?? QUERY_TIMEOUT_MS),
    });
    // Drained while we still hold the permit: an unread body is a query the
    // server is still streaming.
    return { ok: response.ok, body: await response.text() };
  });

  if (!ok) {
    const errorText = body;

    // A STORED TIMEZONE MUST NEVER TAKE A PROFILE DOWN.
    //
    // `toTimeZone` is case-sensitive and Intl is not, so a row written before
    // canonicalTimezone() existed can hold `europe/paris` — a name Intl
    // approved and ClickHouse answers with `Time zone europe/paris is not
    // supported (BAD_ARGUMENTS)`, on every single query that converts. The
    // write path now canonicalizes and probes, but the rows already written
    // are not reachable from there, and a 503 on somebody's profile is a worse
    // way to find out than a log line and their hours in UTC.
    //
    // Deliberately narrow: only when a `tz` parameter was bound, only when it
    // is not already UTC, and only on an error that names a time zone. Anything
    // else throws as before. The write-path probe passes its candidate under a
    // DIFFERENT parameter name for exactly this reason — it needs the truth,
    // not a fallback. The retry re-enters runQuery() with the permit already
    // released, so it queues like any other read instead of deadlocking
    // against itself.
    if (params?.tz && String(params.tz) !== DEFAULT_TIMEZONE && /time zone/i.test(errorText)) {
      console.error(
        `[ClickHouse] timezone ${params.tz} is unusable; re-reading in ${DEFAULT_TIMEZONE}:`,
        errorText.slice(0, 200)
      );
      return runQuery<T>(sql, { ...params, tz: DEFAULT_TIMEZONE }, options);
    }

    console.error('[ClickHouse] Query failed:', { sql: sql.slice(0, 200), error: errorText });
    throw new Error('Database query failed');
  }

  if (!body.trim()) return [];

  // Parse JSONEachRow format (one JSON object per line)
  return body.trim().split('\n').map(line => JSON.parse(line)) as T[];
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
 * The `insert_deduplication_token` for one insert: a hash of the table and of
 * the identity of every row in it, in order.
 *
 * Over `row_id`, not over the body: an OTLP retry of a cumulative counter can
 * carry a different VALUE for the same datapoint, and that is still the same
 * datapoint — hashing the body would let it in twice. A row with no row_id
 * (nothing in src/ writes one, but `insert` is exported) falls back to its
 * serialized form, so it is at least never mistaken for a different row.
 */
export function insertDedupToken(table: string, rows: Record<string, any>[], body: string[]): string {
  const hash = createHash('sha256').update(table);
  rows.forEach((row, index) => {
    hash.update('\n');
    hash.update(typeof row.row_id === 'string' && row.row_id !== '' ? row.row_id : body[index]!);
  });
  return hash.digest('hex');
}

/**
 * Insert rows into a ClickHouse table
 *
 * DELIBERATELY NOT under withReadPermit: see the note on
 * DEFAULT_MAX_CONCURRENT_READS. An insert is cheap (no merge) and ingestion
 * must never wait behind a profile render.
 *
 * IDENTITY IS ENFORCED HERE, AT WRITE TIME, which is why no read in src/ uses
 * FINAL. Two layers:
 *   - every row carries `row_id`, the hash of what identifies it (see
 *     metricRowId/eventRowId), at the end of the sorting key;
 *   - every insert carries an `insert_deduplication_token` derived from those
 *     row_ids, and both raw tables keep `non_replicated_deduplication_window`
 *     (docker/clickhouse/migrations/2026-10-20_insert_dedup_window.sql), so a
 *     retried batch — an OTLP exporter resending after a timeout, a CLI import
 *     re-posting a batch it never saw acknowledged — is dropped by the server
 *     instead of landing twice.
 * ReplacingMergeTree's background merge still collapses equal sorting keys,
 * as a backstop for a duplicate that arrives in a DIFFERENT batch shape. FINAL
 * made every read pay to do that merge again in memory — 3x the time and 600x
 * the bytes on a measured count — for duplicates that were not there.
 */
export async function insert(table: string, rows: Record<string, any>[]): Promise<void> {
  if (rows.length === 0) return;

  const lines = rows.map(row => JSON.stringify(sanitizeRow(row)));
  const body = lines.join('\n');

  const url = new URL(CLICKHOUSE_URL);
  url.searchParams.set('database', CLICKHOUSE_DATABASE);
  url.searchParams.set('query', `INSERT INTO ${table} FORMAT JSONEachRow`);
  url.searchParams.set('insert_deduplication_token', insertDedupToken(table, rows, lines));

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
  /** Every token type, summed — TOTAL_TOKENS_SQL. */
  total_tokens: number;
  // Token breakdown, for the profile's token-flow bar. These add up to
  // total_tokens above; none of them is it.
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
 * and the reads used FINAL. The old keys were
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
 * Can ClickHouse actually load this zone? Asked once, on the way IN.
 *
 * Intl is not the same database: it accepts spellings and (in principle) zones
 * that `toTimeZone` refuses, and a zone that gets stored anyway converts
 * nothing and errors everything. So the write path asks the engine that will
 * have to use it, before the value becomes a row.
 *
 * The parameter is named `zone` and not `tz` ON PURPOSE: `query()` retries a
 * `tz` parameter in UTC rather than failing (see the note there), which would
 * make this function answer `true` for every zone on earth.
 */
export async function probeTimezone(zone: string): Promise<boolean> {
  try {
    await query(`SELECT toString(toTimeZone(now(), {zone:String})) AS local`, { zone });
    return true;
  } catch {
    return false;
  }
}

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
 * `cappedUltrathinksSql(predicate)` is the same cap over a SUBSET of the group:
 * the day picked by a predicate rather than by the GROUP BY (☀️ today), and the
 * recovered part of a bucket (⚡ activity's faint bars). A subset's cap can
 * never exceed the group's, because a minimum over two subsets is at most the
 * minimum over the sets they came from.
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
export function cappedUltrathinksSql(within?: string): string {
  const scope = within ? ` AND (${within})` : '';
  return `least(countIf(${ULTRATHINK_EVENT_SQL}${scope}), countIf(${PROMPT_EVENT_SQL}${scope}))`;
}

export const CAPPED_ULTRATHINKS_SQL = cappedUltrathinksSql();

/**
 * A user's TOTAL TOKENS. THE ONE DEFINITION — every figure the UI, the API or
 * the CLI labels "tokens" is this expression, and nothing else is.
 *
 * EVERY token type: input, output, cacheRead and cacheCreation. Claude Code
 * emits one `claude_code.token.usage` datapoint per type, so a sum with no
 * `token_type` filter is the whole of what moved. This used to be
 * `input + output` in getUserTotals and getLeaderboard and the unfiltered sum
 * in getUserRank and getUserProvenanceBreakdown, which meant /api/me reported
 * one number, the rank it reported beside it was computed from another, and
 * the two were about twenty times apart — roughly 95% of tokens are cache
 * reads. The board that ranks on this figure is what made the disagreement
 * visible; it was always a bug.
 *
 * NO provenance filter. NO_LEGACY_SQL is for queries that read the SHAPE of a
 * day; a pre-OTEL row is honest about HOW MANY tokens moved, and excluding it
 * would take a user's first months off their own lifetime total.
 *
 * It is an AGGREGATE EXPRESSION and not a predicate on purpose: a predicate
 * can be handed an extra `AND token_type = …` by the next caller, which is
 * exactly how the two definitions grew apart. The PER-TYPE columns beside it
 * (total_input_tokens and friends, the profile's token-flow bar) stay as they
 * are — they are a breakdown OF this sum, and they add up to it.
 */
export const TOTAL_TOKENS_SQL = `sumIf(value, metric_name = 'claude_code.token.usage')`;

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
// Query Functions (no FINAL — see insert())
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get user totals for leaderboard sync
 * Queries the raw tables directly; see insert() for why without FINAL
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
        FROM events_raw
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
          ${TOTAL_TOKENS_SQL} as total_tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as total_cost_usd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as total_lines_added,
          sumIf(value, metric_name = 'claude_code.commit.count') as total_commits,
          sumIf(value, metric_name = 'claude_code.pull_request.count') as total_prs,
          sumIf(value, metric_name = 'claude_code.active_time.total') as total_active_seconds
        FROM metrics_raw
        ${whereClause}
        GROUP BY user_id
      )
    SELECT
      COALESCE(e.user_id, m.user_id) as user_id,
      toUInt64(COALESCE(e.total_prompts, 0)) as total_prompts,
      -- The sum itself, not the two types added back up: cache reads are the
      -- bulk of it (TOTAL_TOKENS_SQL).
      toUInt64(COALESCE(m.total_tokens, 0)) as total_tokens,
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
        FROM events_raw
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
        FROM metrics_raw
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
     FROM events_raw
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
    FROM metrics_raw
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
      toUInt64(${TOTAL_TOKENS_SQL}) as activity
    FROM metrics_raw
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
        FROM events_raw
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
          ${TOTAL_TOKENS_SQL} as total_tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as total_cost_usd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as total_lines_added,
          sumIf(value, metric_name = 'claude_code.commit.count') as total_commits,
          sumIf(value, metric_name = 'claude_code.pull_request.count') as total_prs,
          sumIf(value, metric_name = 'claude_code.active_time.total') as total_active_seconds
        FROM metrics_raw
        WHERE ${dateFilter}
        GROUP BY user_id
      )
    SELECT
      COALESCE(e.user_id, m.user_id) as user_id,
      toUInt64(COALESCE(e.total_prompts, 0)) as total_prompts,
      -- The sum itself, not the two types added back up: cache reads are the
      -- bulk of it (TOTAL_TOKENS_SQL).
      toUInt64(COALESCE(m.total_tokens, 0)) as total_tokens,
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
    FROM events_raw
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
        FROM events_raw
        WHERE ${dateFilter}
          AND ${CLAUDE_CODE_EVENT_SQL}
        GROUP BY user_id
      ),
      metric_stats AS (
        SELECT
          user_id,
          ${TOTAL_TOKENS_SQL} as total_tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as total_cost_usd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as total_lines_added
        FROM metrics_raw
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
        FROM events_raw
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
        FROM metrics_raw
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
    FROM metrics_raw
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
    FROM events_raw
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
    FROM events_raw
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
    FROM events_raw
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
        FROM events_raw
        WHERE user_id = {userId:String}
          AND toDate(timestamp) >= today() - {days:UInt32}
          AND ${CLAUDE_CODE_EVENT_SQL}
        GROUP BY date
      ),
      daily_metrics AS (
        SELECT
          toDate(timestamp) as date,
          ${TOTAL_TOKENS_SQL} as tokens,
          sumIf(value, metric_name = 'claude_code.cost.usage') as costUsd,
          sumIf(value, metric_name = 'claude_code.lines_of_code.count' AND line_type = 'added') as lines
        FROM metrics_raw
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
      FROM events_raw
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
      FROM metrics_raw
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
    FROM metrics_raw
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
        FROM metrics_raw
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
        FROM events_raw
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
        FROM events_raw
        WHERE user_id = {userId:String}
          AND ${NO_LEGACY_SQL}
          ${dateFilter}
      ),
      session_stats AS (
        SELECT
          session_id,
          countIf(event_name = 'claude_code.api_request') as api_calls,
          countIf(${PROMPT_EVENT_SQL}) as prompts
        FROM events_raw
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
    FROM events_raw
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
      FROM metrics_raw
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
    FROM metrics_raw
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
      FROM metrics_raw
      WHERE user_id = {userId:String}
        AND terminal_type != ''
    )
    SELECT
      terminal_type as terminalType,
      toUInt64(uniqExact(session_id)) as sessionCount,
      toFloat64(if((SELECT total_sessions FROM total) > 0,
         uniqExact(session_id) * 100.0 / (SELECT total_sessions FROM total), 0)) as percentage
    FROM metrics_raw
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
        FROM events_raw
        WHERE user_id = {userId:String}
          -- A provenance whose only rows are ultrathink flags contributes no
          -- prompt, no token and no dollar, so listing it as a source of the
          -- numbers would be a row of zeroes claiming to explain something.
          AND ${CLAUDE_CODE_EVENT_SQL}
        GROUP BY provenance
      ),
      metric_parts AS (
        SELECT provenance,
               ${TOTAL_TOKENS_SQL} as tokens,
               sumIf(value, metric_name = 'claude_code.cost.usage') as cost_usd
        FROM metrics_raw
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
    FROM events_raw
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
    FROM metrics_raw
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
  probeTimezone,
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
