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
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { insertMetrics, insertEvents, type MetricRow, type EventRow } from '../db/clickhouse';
import { verifyBearerToken } from '../lib/session';

const otel = new Hono();

// ═══════════════════════════════════════════════════════════════════════════
// Request Size Limits
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Auth Middleware - Validate bearer token
// ═══════════════════════════════════════════════════════════════════════════

interface OtelContext {
  userId: string;
  username: string;
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
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  // Verify token signature and expiry using the proper session library
  const userId = await verifyBearerToken(token);
  if (!userId) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  // Verify user exists in database
  const validUser = await db
    .select({ id: users.id, username: users.githubUsername })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!validUser) {
    return c.json({ error: 'User not found' }, 401);
  }

  // Set user context
  c.set('otelUser', { userId: validUser.id, username: validUser.username });

  await next();
}

// ═══════════════════════════════════════════════════════════════════════════
// OTLP Parsing Helpers
// ═══════════════════════════════════════════════════════════════════════════

type OtlpAttribute = {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
};

function getAttr(attrs: OtlpAttribute[], key: string): string | number | boolean | null {
  const attr = attrs.find(a => a.key === key);
  if (!attr) return null;
  const v = attr.value;
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null;
}

function parseTimestamp(timeUnixNano: string | number): string {
  const nanos = typeof timeUnixNano === 'string' ? BigInt(timeUnixNano) : BigInt(timeUnixNano);
  const millis = Number(nanos / BigInt(1_000_000));
  // ClickHouse DateTime64 expects format without 'Z' suffix: "YYYY-MM-DD HH:MM:SS.sss"
  const d = new Date(millis);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parse OTLP Metrics
// ═══════════════════════════════════════════════════════════════════════════

interface OtlpMetricsRequest {
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

function parseOtlpMetrics(body: OtlpMetricsRequest, userId: string): MetricRow[] {
  const metrics: MetricRow[] = [];

  for (const resourceMetrics of body.resourceMetrics || []) {
    const resourceAttrs = resourceMetrics.resource?.attributes || [];
    const sessionId = safeString(getAttr(resourceAttrs, 'session.id'), 256);
    const terminalType = safeString(getAttr(resourceAttrs, 'terminal.type'), 100);
    const appVersion = safeString(getAttr(resourceAttrs, 'app.version'), 100);
    const accountUuid = safeString(getAttr(resourceAttrs, 'user.account_uuid'), 256);

    for (const scopeMetrics of resourceMetrics.scopeMetrics || []) {
      // Only process claude_code metrics
      if (scopeMetrics.scope?.name && !scopeMetrics.scope.name.includes('claude')) {
        continue;
      }

      for (const metric of scopeMetrics.metrics || []) {
        const metricName = safeString(metric.name, 200);
        const dataPoints = metric.sum?.dataPoints || metric.gauge?.dataPoints || [];

        for (const dp of dataPoints) {
          const dpAttrs = dp.attributes || [];
          const value = safeNumber(dp.asDouble ?? dp.asInt, 0);

          // Extract type attribute (used for both token_type and line_type)
          const typeAttr = safeString(getAttr(dpAttrs, 'type'), 100);

          // Extract code_edit_tool.decision specific attributes
          const isCodeEditDecision = metricName.includes('code_edit_tool.decision');

          metrics.push({
            timestamp: parseTimestamp(dp.timeUnixNano),
            user_id: userId,
            session_id: sessionId,
            metric_name: metricName,
            value,
            model: safeString(getAttr(dpAttrs, 'model'), 100),
            token_type: metricName.includes('token') ? typeAttr : '',
            line_type: metricName.includes('lines_of_code') ? typeAttr : '',
            terminal_type: terminalType,
            app_version: appVersion,
            account_uuid: accountUuid,
            // code_edit_tool.decision attributes
            tool: isCodeEditDecision ? safeString(getAttr(dpAttrs, 'tool'), 50) : '',
            decision: isCodeEditDecision ? safeString(getAttr(dpAttrs, 'decision'), 20) : '',
            language: isCodeEditDecision ? safeString(getAttr(dpAttrs, 'language'), 50) : '',
          });
        }
      }
    }
  }

  return metrics;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parse OTLP Logs/Events
// ═══════════════════════════════════════════════════════════════════════════

interface OtlpLogsRequest {
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

function parseOtlpEvents(body: OtlpLogsRequest, userId: string): EventRow[] {
  const events: EventRow[] = [];

  for (const resourceLogs of body.resourceLogs || []) {
    const resourceAttrs = resourceLogs.resource?.attributes || [];
    const sessionId = safeString(getAttr(resourceAttrs, 'session.id'), 256);

    for (const scopeLogs of resourceLogs.scopeLogs || []) {
      for (const logRecord of scopeLogs.logRecords || []) {
        const attrs = logRecord.attributes || [];
        const eventName = safeString(getAttr(attrs, 'event.name'), 100);

        // Skip non-events
        if (!eventName) continue;

        // Normalize event names to include claude_code. prefix for schema compatibility
        const normalizedEventName = eventName.startsWith('claude_code.')
          ? eventName
          : `claude_code.${eventName}`;

        events.push({
          timestamp: parseTimestamp(logRecord.timeUnixNano),
          user_id: userId,
          session_id: sessionId,
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
          error_message: safeString(getAttr(attrs, 'error'), 2000), // Longer for error messages
          status_code: safeNumber(getAttr(attrs, 'status_code'), 0, 999),
          duration_ms: safeNumber(getAttr(attrs, 'duration_ms'), 0, 3600000), // Max 1 hour
          // tool_result / tool_decision attributes
          decision: safeString(getAttr(attrs, 'decision'), 20),      // accept, reject
          source: safeString(getAttr(attrs, 'source'), 50),          // config, user_permanent, etc.
          tool_parameters: safeString(getAttr(attrs, 'tool_parameters'), 5000), // JSON string
        });
      }
    }
  }

  return events;
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
    const body = await c.req.json() as OtlpMetricsRequest;

    const metrics = parseOtlpMetrics(body, otelUser.userId);

    if (metrics.length > 0) {
      await insertMetrics(metrics);
      console.log(`[OTel] Received ${metrics.length} metrics from ${otelUser.username}`);
    }

    return c.json({
      partialSuccess: {} // OTLP success response format
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
    const body = await c.req.json() as OtlpLogsRequest;

    const events = parseOtlpEvents(body, otelUser.userId);

    if (events.length > 0) {
      await insertEvents(events);
      console.log(`[OTel] Received ${events.length} events from ${otelUser.username}`);
    }

    return c.json({
      partialSuccess: {} // OTLP success response format
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
