/**
 * OTLP Receiver for Claude Code telemetry
 *
 * Receives metrics and events from Claude Code's OpenTelemetry export.
 *
 * Endpoints:
 * - POST /otel/v1/metrics - Receive OTLP metrics (token usage, cost, etc.)
 * - POST /otel/v1/logs   - Receive OTLP events (user_prompt, tool_result, etc.)
 */

import { Hono } from 'hono';
import { gunzipSync } from 'node:zlib';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { insertMetrics, insertEvents, type MetricRow, type EventRow } from '../db/clickhouse';
import { verifyBearerToken } from '../lib/session';

const otel = new Hono();

// ═══════════════════════════════════════════════════════════════════════════
// Request Size Limits
// ═══════════════════════════════════════════════════════════════════════════

// Applied to BOTH the wire body and the gzip-decompressed payload, so
// Content-Encoding buys bandwidth, never a bigger payload (gzip-bomb guard).
const MAX_METRICS_BODY_SIZE = 1024 * 1024; // 1MB
const MAX_LOGS_BODY_SIZE = 5 * 1024 * 1024; // 5MB

// ═══════════════════════════════════════════════════════════════════════════
// Safe Parsing Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Safely parse number, rejecting NaN/Infinity and enforcing bounds
 */
function safeNumber(val: any, defaultVal: number = 0, max: number = 1e15): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return defaultVal;
  if (num < 0) return 0;
  if (num > max) return max;
  return num;
}

/**
 * Safely parse string with length limit
 */
function safeString(val: any, maxLen: number = 1000): string {
  const str = String(val ?? '');
  return str.slice(0, maxLen);
}

/**
 * `event.sequence`: a 0-based per-process counter, or -1 when the record
 * carries none. -1 rather than 0 because a record without a sequence and the
 * genuine first record of a process are different things, and the sequence is
 * part of the row identity — conflating them would collapse them into one row.
 */
export const NO_EVENT_SEQUENCE = -1;

function safeSequence(val: any): number {
  if (val === null || val === undefined || val === '') return NO_EVENT_SEQUENCE;
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return NO_EVENT_SEQUENCE;
  return Math.min(Math.trunc(num), Number.MAX_SAFE_INTEGER);
}

// ═══════════════════════════════════════════════════════════════════════════
// Privacy: absolute paths never reach storage
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Error messages are kept — they are how a user finds out their tooling is
 * broken — but a filesystem path inside one names the person ("/Users/mael"),
 * their employer, and their project layout. None of that is usage data, so it
 * is replaced at ingest and never written.
 *
 * Both separators are covered: POSIX roots we actually see in Claude Code
 * errors (/Users, /home, /tmp, ~) and Windows drive paths. A path ends at the
 * first character that cannot be in one — whitespace or a quote — which is how
 * `open '/Users/x/y.ts'` keeps its surrounding syntax.
 */
const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:\/(?:Users|home|tmp)|~)\/[^\s'"`<>|]*/g,
  /[A-Za-z]:\\[^\s'"`<>|]*/g,
];

export function redactAbsolutePaths(text: string): string {
  let out = text;
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    out = out.replace(pattern, '<path>');
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// OTLP Body Decoding
// ═══════════════════════════════════════════════════════════════════════════

export type OtlpBodyResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: 400 | 413 | 415; error: string };

/**
 * Decode an OTLP/HTTP JSON request body.
 *
 * The OTel SDK exporter sets `Content-Encoding: gzip` whenever
 * OTEL_EXPORTER_OTLP_COMPRESSION=gzip (and some collectors do it
 * unconditionally). Before this, a gzipped batch hit JSON.parse as binary,
 * threw, and was answered with a 500 — which the SDK treats as retryable, so
 * the same batch came back forever and never landed. Anything we cannot parse
 * is now a 4xx: permanent for the exporter, visible in the logs, dropped once.
 *
 * `rootKey` is the only top-level field OTLP defines for this signal; a payload
 * that carries it as something other than an array is malformed, not empty.
 */
export function decodeOtlpBody<T>(
  raw: Uint8Array,
  contentEncoding: string | undefined,
  contentType: string | undefined,
  maxBytes: number,
  rootKey: 'resourceMetrics' | 'resourceLogs'
): OtlpBodyResult<T> {
  const type = (contentType ?? '').toLowerCase();
  if (type && !type.includes('json')) {
    return { ok: false, status: 415, error: `Unsupported Content-Type "${contentType}" — this receiver speaks OTLP http/json only` };
  }

  if (raw.byteLength > maxBytes) {
    return { ok: false, status: 413, error: 'Request body too large' };
  }

  const encoding = (contentEncoding ?? '').toLowerCase().trim();
  let bytes = raw;
  if (encoding && encoding !== 'identity') {
    if (encoding !== 'gzip') {
      return { ok: false, status: 415, error: `Unsupported Content-Encoding "${contentEncoding}" — gzip or identity only` };
    }
    try {
      // maxOutputLength is the gzip-bomb guard that matters: zlib refuses to
      // materialise anything bigger than the limit instead of handing us the
      // buffer and letting us measure it afterwards. A 1000:1 bomb therefore
      // costs us its compressed bytes and nothing more. Checking
      // bytes.byteLength after an unbounded gunzipSync is too late — the
      // allocation has already happened.
      bytes = new Uint8Array(gunzipSync(raw, { maxOutputLength: maxBytes }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
        return { ok: false, status: 413, error: 'Decompressed body too large' };
      }
      return { ok: false, status: 400, error: 'Malformed gzip body' };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, status: 400, error: 'Malformed JSON body' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: 'OTLP body must be a JSON object' };
  }

  const root = (parsed as Record<string, unknown>)[rootKey];
  if (root !== undefined && !Array.isArray(root)) {
    return { ok: false, status: 400, error: `OTLP body field "${rootKey}" must be an array` };
  }

  return { ok: true, body: parsed as T };
}

// ═══════════════════════════════════════════════════════════════════════════
// Auth Middleware - Validate bearer token
// ═══════════════════════════════════════════════════════════════════════════

interface OtelContext {
  userId: string;
  username: string;
}

// Rate-limited 401 warning. The OTel SDK silently drops batches on 401, so a
// user can be stuck pushing rejected requests for months without any visible
// signal. This surfaces sustained 401s in `docker logs` so the operator
// notices even before the user's CLI heartbeat (clawdgg doctor) catches it.
type AuthFailWindow = { count: number; windowStartMs: number; lastWarnMs: number };
const authFailures = new Map<string, AuthFailWindow>();
const AUTH_FAIL_WINDOW_MS = 60 * 60 * 1000;     // 1 hour rolling window
const AUTH_FAIL_THRESHOLD = 100;                 // 401s/hour before warning
const AUTH_WARN_THROTTLE_MS = 60 * 60 * 1000;    // at most one warn per hour per key

function recordAuthFailure(key: string, reason: string): void {
  const now = Date.now();
  const entry = authFailures.get(key) ?? { count: 0, windowStartMs: now, lastWarnMs: 0 };

  if (now - entry.windowStartMs > AUTH_FAIL_WINDOW_MS) {
    entry.count = 0;
    entry.windowStartMs = now;
  }
  entry.count++;

  if (entry.count > AUTH_FAIL_THRESHOLD && now - entry.lastWarnMs > AUTH_WARN_THROTTLE_MS) {
    const minutes = Math.round((now - entry.windowStartMs) / 60000);
    console.warn(
      `[OTel Auth] WARN: ${key} has ${entry.count} 401s in ${minutes}m (reason=${reason}). ` +
      `Likely a stale or revoked token; user should re-run \`clawdgg login\`.`
    );
    entry.lastWarnMs = now;
  }

  authFailures.set(key, entry);
}

function peekTokenUserId(token: string | undefined): string | null {
  if (!token) return null;
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;
  try {
    const parsed = JSON.parse(token.slice(0, lastDot));
    return typeof parsed.userId === 'string' ? parsed.userId : null;
  } catch {
    return null;
  }
}

async function requireOtelAuth(c: any, next: () => Promise<void>): Promise<Response | void> {
  let authHeader = c.req.header('Authorization');

  // OTEL exporter sends the header value as-is from env var, which may be URL-encoded
  // Decode it if it looks encoded (starts with "Bearer%20" instead of "Bearer ")
  if (authHeader && authHeader.startsWith('Bearer%20')) {
    try {
      authHeader = decodeURIComponent(authHeader);
    } catch {
      // If decode fails, use as-is
    }
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('[OTel Auth] Missing or invalid header format:', authHeader?.slice(0, 30));
    recordAuthFailure('anon', 'missing-or-malformed-header');
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7); // Remove "Bearer "
  const userIdHint = peekTokenUserId(token) ?? 'anon';

  // Verify token signature, expiry, and gen against users.token_gen
  const userId = await verifyBearerToken(token);
  if (!userId) {
    recordAuthFailure(userIdHint, 'invalid-or-revoked-token');
    return c.json({ error: 'Invalid or revoked token' }, 401);
  }

  // Verify user exists in database
  const validUser = await db
    .select({ id: users.id, username: users.githubUsername })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!validUser) {
    recordAuthFailure(userIdHint, 'user-not-found');
    return c.json({ error: 'User not found' }, 401);
  }

  // Set user context
  c.set('otelUser', { userId: validUser.id, username: validUser.username });

  await next();
}

// ═══════════════════════════════════════════════════════════════════════════
// OTLP Parsing Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What a parse produced, and what it had to throw away.
 *
 * A batch is never all-or-nothing: Claude Code packs hundreds of datapoints
 * into one export, and one unreadable datapoint must not cost the other 299.
 * `skipped` is what the caller reports back as OTLP `partialSuccess`, and a
 * batch where NOTHING was readable is the only case that answers 4xx.
 */
export interface OtlpParseResult<T> {
  rows: T[];
  skipped: number;
}

/** `resourceMetrics: [null]`, `scopeLogs: {}`, a missing key — all become []. */
function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

type OtlpAttribute = {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
};

/**
 * Nothing in here may throw on a malformed payload.
 *
 * `value` is required by the OTLP schema but arrives missing from real
 * exporters (an attribute whose value was dropped serialises as `{key}`), and
 * an attribute list arrives as null or as a bare object. Reading those used to
 * throw, which Hono answered with a 500 — and a 500 is RETRYABLE to the OTel
 * SDK, so one malformed attribute meant the same batch coming back forever.
 */
function getAttr(attrs: unknown, key: string): string | number | boolean | null {
  if (!Array.isArray(attrs)) return null;
  const attr = attrs.find(a => a && typeof a === 'object' && (a as OtlpAttribute).key === key);
  if (!attr) return null;
  const v = (attr as OtlpAttribute).value;
  if (!v || typeof v !== 'object') return null;
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null;
}

/**
 * First non-empty value for `keys`, looking at the datapoint / log-record
 * attributes before the resource attributes.
 *
 * Claude Code documents session.id, app.version, terminal.type,
 * user.account_uuid and organization.id as STANDARD attributes carried by
 * every metric datapoint and every log record. The resource block carries
 * service.name, service.version, os.* and host.*. We used to read the five
 * standard ones from the resource block only, so they landed empty on any
 * exporter that puts them where the docs say they are — datapoint-first with a
 * resource fallback covers both shapes.
 */
function pickAttr(
  own: unknown,
  resource: unknown,
  ...keys: string[]
): string | number | boolean | null {
  for (const attrs of [own, resource]) {
    for (const key of keys) {
      const v = getAttr(attrs, key);
      if (v !== null && v !== '') return v;
    }
  }
  return null;
}

/**
 * OTLP nanoseconds -> ClickHouse DateTime64(3) literal, or null when the
 * datapoint carries no usable timestamp. Exactly three fractional digits,
 * always: the identity hash feeds this string through toString(timestamp) in
 * SQL, and DateTime64(3) always renders three — a shorter literal here would
 * hash differently on the two sides.
 */
export function parseTimestamp(timeUnixNano: unknown): string | null {
  if (timeUnixNano === null || timeUnixNano === undefined || timeUnixNano === '') return null;

  let nanos: bigint;
  try {
    nanos = BigInt(typeof timeUnixNano === 'number' ? Math.trunc(timeUnixNano) : String(timeUnixNano));
  } catch {
    return null;
  }

  const millis = Number(nanos / BigInt(1_000_000));
  const d = new Date(millis);
  if (Number.isNaN(d.getTime())) return null;

  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parse OTLP Metrics
// ═══════════════════════════════════════════════════════════════════════════

export interface OtlpMetricsRequest {
  resourceMetrics?: {
    resource?: {
      attributes?: OtlpAttribute[];
    };
    scopeMetrics?: {
      scope?: { name?: string };
      metrics?: {
        name: string;
        sum?: {
          dataPoints?: {
            timeUnixNano: string;
            asDouble?: number;
            asInt?: string | number;
            attributes?: OtlpAttribute[];
          }[];
        };
        gauge?: {
          dataPoints?: {
            timeUnixNano: string;
            asDouble?: number;
            asInt?: string | number;
            attributes?: OtlpAttribute[];
          }[];
        };
      }[];
    }[];
  }[];
}

export function parseOtlpMetrics(
  body: OtlpMetricsRequest,
  userId: string
): OtlpParseResult<MetricRow> {
  const metrics: MetricRow[] = [];
  let skipped = 0;

  for (const resourceMetrics of asArray(body?.resourceMetrics)) {
    const resourceAttrs = resourceMetrics?.resource?.attributes;

    for (const scopeMetrics of asArray(resourceMetrics?.scopeMetrics)) {
      // Only process claude_code metrics
      if (scopeMetrics?.scope?.name && !scopeMetrics.scope.name.includes('claude')) {
        continue;
      }

      for (const metric of asArray(scopeMetrics?.metrics)) {
        const metricName = safeString(metric?.name, 200);
        const dataPoints = asArray(metric?.sum?.dataPoints).length
          ? asArray(metric?.sum?.dataPoints)
          : asArray(metric?.gauge?.dataPoints);

        for (const dp of dataPoints) {
          const timestamp = parseTimestamp(dp?.timeUnixNano);
          if (!metricName || timestamp === null) {
            skipped++;
            continue;
          }

          const dpAttrs = dp?.attributes;
          const value = safeNumber(dp?.asDouble ?? dp?.asInt, 0);

          // Extract type attribute (token_type, line_type and time_type all
          // come from the one `type` attribute, per metric).
          const typeAttr = safeString(getAttr(dpAttrs, 'type'), 100);

          // Extract code_edit_tool.decision specific attributes
          const isCodeEditDecision = metricName.includes('code_edit_tool.decision');
          const isSessionCount = metricName.includes('session.count');

          metrics.push({
            timestamp,
            user_id: userId,
            session_id: safeString(pickAttr(dpAttrs, resourceAttrs, 'session.id'), 256),
            metric_name: metricName,
            value,
            model: safeString(getAttr(dpAttrs, 'model'), 100),
            token_type: metricName.includes('token') ? typeAttr : '',
            line_type: metricName.includes('lines_of_code') ? typeAttr : '',
            // active_time.total splits by `type` too: "user" is keyboard time,
            // "cli" is tool execution and model responses. Both datapoints land
            // on the same timestamp, so without this column they are one row.
            time_type: metricName.includes('active_time') ? typeAttr : '',
            terminal_type: safeString(pickAttr(dpAttrs, resourceAttrs, 'terminal.type'), 100),
            // service.version is the resource-level spelling of the Claude Code version.
            app_version: safeString(pickAttr(dpAttrs, resourceAttrs, 'app.version', 'service.version'), 100),
            account_uuid: safeString(pickAttr(dpAttrs, resourceAttrs, 'user.account_uuid', 'user.account_id'), 256),
            organization_id: safeString(pickAttr(dpAttrs, resourceAttrs, 'organization.id'), 256),
            // code_edit_tool.decision attributes. `tool` was renamed `tool_name`
            // (we keep the column name); `source` was never read at all.
            tool: isCodeEditDecision ? safeString(getAttr(dpAttrs, 'tool_name') ?? getAttr(dpAttrs, 'tool'), 50) : '',
            decision: isCodeEditDecision ? safeString(getAttr(dpAttrs, 'decision'), 20) : '',
            language: isCodeEditDecision ? safeString(getAttr(dpAttrs, 'language'), 50) : '',
            source: isCodeEditDecision ? safeString(getAttr(dpAttrs, 'source'), 50) : '',
            // Attribution attributes on cost.usage / token.usage. query_source is
            // main vs subagent vs auxiliary — without it every subagent token is
            // indistinguishable from a main-thread one.
            query_source: safeString(getAttr(dpAttrs, 'query_source'), 20),
            speed: safeString(getAttr(dpAttrs, 'speed'), 20),
            effort: safeString(getAttr(dpAttrs, 'effort'), 20),
            agent_name: safeString(getAttr(dpAttrs, 'agent.name'), 200),
            skill_name: safeString(getAttr(dpAttrs, 'skill.name'), 200),
            plugin_name: safeString(getAttr(dpAttrs, 'plugin.name'), 200),
            // The marketplace a plugin came from. Sent alongside plugin.name,
            // so two plugins of the same name from different marketplaces are
            // two rows rather than one.
            marketplace_name: safeString(getAttr(dpAttrs, 'marketplace.name'), 200),
            mcp_server_name: safeString(getAttr(dpAttrs, 'mcp_server.name'), 200),
            mcp_tool_name: safeString(getAttr(dpAttrs, 'mcp_tool.name'), 200),
            // session.count: fresh | resume | continue | agents_view
            start_type: isSessionCount ? safeString(getAttr(dpAttrs, 'start_type'), 20) : '',
          });
        }
      }
    }
  }

  return { rows: metrics, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════
// Parse OTLP Logs/Events
// ═══════════════════════════════════════════════════════════════════════════

export interface OtlpLogsRequest {
  resourceLogs?: {
    resource?: {
      attributes?: OtlpAttribute[];
    };
    scopeLogs?: {
      scope?: { name?: string };
      logRecords?: {
        timeUnixNano: string;
        attributes?: OtlpAttribute[];
        body?: {
          stringValue?: string;
        };
      }[];
    }[];
  }[];
}

export function parseOtlpEvents(
  body: OtlpLogsRequest,
  userId: string
): OtlpParseResult<EventRow> {
  const events: EventRow[] = [];
  let skipped = 0;

  for (const resourceLogs of asArray(body?.resourceLogs)) {
    const resourceAttrs = resourceLogs?.resource?.attributes;

    for (const scopeLogs of asArray(resourceLogs?.scopeLogs)) {
      for (const logRecord of asArray(scopeLogs?.logRecords)) {
        const attrs = logRecord?.attributes;
        const eventName = safeString(getAttr(attrs, 'event.name'), 100);
        const timestamp = parseTimestamp(logRecord?.timeUnixNano);

        // A record with no event.name or no timestamp is one we cannot file:
        // every query selects on event_name, and timestamp is in the row
        // identity. Counted, not silently dropped.
        if (!eventName || timestamp === null) {
          skipped++;
          continue;
        }

        // Normalize event names to include claude_code. prefix for schema compatibility
        const normalizedEventName = eventName.startsWith('claude_code.')
          ? eventName
          : `claude_code.${eventName}`;

        // NOTE: `prompt` / `prompt_text` (user_prompt), `response` / `body`
        // (assistant_response, api_*_body) and `tool_parameters` /
        // `tool_input` (tool_result, tool_decision) are deliberately never
        // read. We store prompt LENGTH, never prompt text, and never a tool's
        // arguments — do not add them here.
        events.push({
          timestamp,
          user_id: userId,
          session_id: safeString(pickAttr(attrs, resourceAttrs, 'session.id'), 256),
          event_name: normalizedEventName,
          prompt_length: safeNumber(getAttr(attrs, 'prompt_length'), 0, 1_000_000), // Max 1M chars
          tool_name: safeString(getAttr(attrs, 'tool_name'), 200),
          tool_success: getAttr(attrs, 'success') === true || getAttr(attrs, 'success') === 'true' ? 1 : 0,
          tool_duration_ms: safeNumber(getAttr(attrs, 'duration_ms'), 0, 3600000), // Max 1 hour
          model: safeString(getAttr(attrs, 'model'), 100),
          cost_usd: safeNumber(getAttr(attrs, 'cost_usd'), 0, 1000), // Max $1000 per event
          input_tokens: safeNumber(getAttr(attrs, 'input_tokens'), 0),
          output_tokens: safeNumber(getAttr(attrs, 'output_tokens'), 0),
          cache_read_tokens: safeNumber(getAttr(attrs, 'cache_read_tokens'), 0),
          cache_write_tokens: safeNumber(getAttr(attrs, 'cache_creation_tokens'), 0),
          // Kept, because an error is how a user learns their setup is broken —
          // but absolute paths in it are stripped before storage.
          error_message: safeString(redactAbsolutePaths(String(getAttr(attrs, 'error') ?? '')), 2000),
          // tool_result's short classification ("Error:ENOENT", "ShellError").
          // Carries no path, and separates two failures in one millisecond.
          error_type: safeString(getAttr(attrs, 'error_type'), 100),
          status_code: safeNumber(getAttr(attrs, 'status_code'), 0, 999),
          duration_ms: safeNumber(getAttr(attrs, 'duration_ms'), 0, 3600000), // Max 1 hour
          // tool_result / tool_decision attributes. tool_result renamed these to
          // `decision_type` / `decision_source`; tool_decision still sends the
          // old `decision` / `source`, so read new-then-old on both.
          decision: safeString(getAttr(attrs, 'decision_type') ?? getAttr(attrs, 'decision'), 20),   // accept, reject
          source: safeString(getAttr(attrs, 'decision_source') ?? getAttr(attrs, 'source'), 50),     // config, user_permanent, etc.
          tool_use_id: safeString(getAttr(attrs, 'tool_use_id'), 100),
          // tool_decision: builtin | mcp | sdk_host_builtin_mcp.
          tool_source: safeString(getAttr(attrs, 'tool_source'), 50),
          // Correlation + attribution. prompt.id joins a prompt to the api_request
          // calls it caused; query_source separates main from subagent traffic.
          prompt_id: safeString(getAttr(attrs, 'prompt.id'), 100),
          request_id: safeString(getAttr(attrs, 'request_id'), 100),
          // The client-side id, present even when the server never answered —
          // which is exactly when request_id is empty and two api_errors in the
          // same millisecond would otherwise be one row.
          client_request_id: safeString(getAttr(attrs, 'client_request_id'), 100),
          // The user message a prompt event belongs to.
          message_uuid: safeString(getAttr(attrs, 'message.uuid'), 100),
          // 0-based per-process counter. The docs name it as THE tie-breaker
          // for events sharing a timestamp, which makes it the one attribute
          // that keeps any two same-millisecond records apart — including the
          // event types this schema has no other columns for.
          event_sequence: safeSequence(getAttr(attrs, 'event.sequence')),
          query_source: safeString(getAttr(attrs, 'query_source'), 20),
          speed: safeString(getAttr(attrs, 'speed'), 20),
          effort: safeString(getAttr(attrs, 'effort'), 20),
          agent_name: safeString(getAttr(attrs, 'agent.name'), 200),
          skill_name: safeString(getAttr(attrs, 'skill.name'), 200),
          marketplace_name: safeString(getAttr(attrs, 'marketplace.name'), 200),
          // user_prompt slash-command attribution (Claude Code 2.1.117+).
          // command_source: builtin | custom | mcp — see PROMPT_EVENT_SQL.
          command_name: safeString(getAttr(attrs, 'command_name'), 200),
          command_source: safeString(getAttr(attrs, 'command_source'), 20),
          terminal_type: safeString(pickAttr(attrs, resourceAttrs, 'terminal.type'), 100),
          app_version: safeString(pickAttr(attrs, resourceAttrs, 'app.version', 'service.version'), 100),
          account_uuid: safeString(pickAttr(attrs, resourceAttrs, 'user.account_uuid', 'user.account_id'), 256),
          organization_id: safeString(pickAttr(attrs, resourceAttrs, 'organization.id'), 256),
        });
      }
    }
  }

  return { rows: events, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /otel/v1/metrics
 * Receive OTLP metrics from Claude Code
 */
otel.post('/v1/metrics', requireOtelAuth, async (c) => {
  try {
    // Check content length
    const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
    if (contentLength > MAX_METRICS_BODY_SIZE) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    const otelUser = c.get('otelUser') as OtelContext;
    const decoded = decodeOtlpBody<OtlpMetricsRequest>(
      new Uint8Array(await c.req.arrayBuffer()),
      c.req.header('Content-Encoding'),
      c.req.header('Content-Type'),
      MAX_METRICS_BODY_SIZE,
      'resourceMetrics'
    );
    if (!decoded.ok) {
      console.warn(`[OTel] Rejected metrics from ${otelUser.username}: ${decoded.error}`);
      return c.json({ error: decoded.error }, decoded.status);
    }

    const { rows: metrics, skipped } = parseOtlpMetrics(decoded.body, otelUser.userId);

    if (skipped > 0) {
      console.warn(
        `[OTel] Skipped ${skipped} unreadable datapoint(s) from ${otelUser.username} ` +
        `(kept ${metrics.length})`
      );
    }

    // Only a batch with nothing usable in it is an error. Answering 4xx on a
    // batch that was partly good would make the exporter drop the good part
    // too — delta temporality means it is never re-sent.
    if (metrics.length === 0 && skipped > 0) {
      return c.json({ error: `No readable datapoints in ${skipped} received` }, 400);
    }

    if (metrics.length > 0) {
      await insertMetrics(metrics);
      console.log(`[OTel] Received ${metrics.length} metrics from ${otelUser.username}`);
    }

    // OTLP's own partial-failure channel: the exporter logs the rejection and
    // keeps the accepted datapoints, instead of retrying the whole batch.
    return c.json({
      partialSuccess: skipped > 0
        ? { rejectedDataPoints: skipped, errorMessage: 'Datapoint missing a name or timestamp' }
        : {},
    });
  } catch (error) {
    console.error('[OTel] Error processing metrics:', error);
    return c.json({ error: 'Failed to process metrics' }, 500);
  }
});

/**
 * POST /otel/v1/logs
 * Receive OTLP logs/events from Claude Code
 */
otel.post('/v1/logs', requireOtelAuth, async (c) => {
  try {
    // Check content length
    const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
    if (contentLength > MAX_LOGS_BODY_SIZE) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    const otelUser = c.get('otelUser') as OtelContext;
    const decoded = decodeOtlpBody<OtlpLogsRequest>(
      new Uint8Array(await c.req.arrayBuffer()),
      c.req.header('Content-Encoding'),
      c.req.header('Content-Type'),
      MAX_LOGS_BODY_SIZE,
      'resourceLogs'
    );
    if (!decoded.ok) {
      console.warn(`[OTel] Rejected logs from ${otelUser.username}: ${decoded.error}`);
      return c.json({ error: decoded.error }, decoded.status);
    }

    const { rows: events, skipped } = parseOtlpEvents(decoded.body, otelUser.userId);

    if (skipped > 0) {
      console.warn(
        `[OTel] Skipped ${skipped} unreadable log record(s) from ${otelUser.username} ` +
        `(kept ${events.length})`
      );
    }

    if (events.length === 0 && skipped > 0) {
      return c.json({ error: `No readable log records in ${skipped} received` }, 400);
    }

    if (events.length > 0) {
      await insertEvents(events);
      console.log(`[OTel] Received ${events.length} events from ${otelUser.username}`);
    }

    return c.json({
      partialSuccess: skipped > 0
        ? { rejectedLogRecords: skipped, errorMessage: 'Log record missing event.name or a timestamp' }
        : {},
    });
  } catch (error) {
    console.error('[OTel] Error processing logs:', error);
    return c.json({ error: 'Failed to process logs' }, 500);
  }
});

/**
 * GET /otel/health
 * Health check for OTel endpoint
 */
otel.get('/health', async (c) => {
  return c.json({ status: 'ok' });
});

export default otel;
