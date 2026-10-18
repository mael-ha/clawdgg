/**
 * Endpoints the `clawdgg` CLI calls on its own behalf.
 *
 * Mounted at /api/cli, so the /api/* rate limiter applies the same way it does
 * to the rest of the API. Every route here is BEARER-ONLY (requireBearerAuth):
 * a cookie session is refused, because these are called by a local binary and
 * accepting the cookie would make "revoke all my devices" a CSRF one-liner.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { requireBearerAuth } from '../lib/auth-middleware';
import {
  listDeviceTokens,
  renameDeviceToken,
  revokeAllDeviceTokens,
  revokeDeviceToken,
} from '../lib/session';
import {
  eventRowId,
  insertEvents,
  insertMetrics,
  metricRowId,
  query,
  type EventRow,
  type MetricRow,
  type RowProvenance,
} from '../db/clickhouse';
import type { ImportEventRow, ImportMetricRow } from '../lib/session-import';

const cli = new Hono();

/**
 * ClickHouse max() over an empty set yields the DateTime64 epoch rather than
 * null, so anything in 1970 means "no rows".
 */
function toIsoOrNull(chTimestamp: unknown): string | null {
  if (typeof chTimestamp !== 'string' || !chTimestamp.trim()) return null;
  if (chTimestamp.startsWith('1970-01-01')) return null;
  const parsed = new Date(`${chTimestamp.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/cli/health — what `clawdgg doctor` needs from the server
// ═══════════════════════════════════════════════════════════════════════════
//
// The point of this endpoint is the silent-drop case: a token that stopped
// working leaves the OTel SDK dropping batches with no user-visible signal.
// `lastLiveEventAt` is how the CLI turns that into "nothing has arrived since
// April" instead of "looks configured, must be fine".
cli.get('/health', requireBearerAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await db
    .select({ otelEnabled: users.otelEnabled, otelSetupAt: users.otelSetupAt })
    .from(users)
    .where(eq(users.id, user.id))
    .get();

  let lastLiveEventAt: string | null = null;
  let lastEventAt: string | null = null;
  let clickhouse = 'ok';

  try {
    const rows = await query<{ last_live: string; last_any: string }>(
      `SELECT
         max(if(provenance = 'live', timestamp, toDateTime64(0, 3))) AS last_live,
         max(timestamp) AS last_any
       FROM events_raw
       WHERE user_id = {userId:String}`,
      { userId: user.id }
    );
    lastLiveEventAt = toIsoOrNull(rows[0]?.last_live);
    lastEventAt = toIsoOrNull(rows[0]?.last_any);
  } catch (error) {
    // A ClickHouse outage is a server problem, not a reason to tell the user
    // their setup is broken — `doctor` reports it as a caveat.
    console.error('[cli/health] ClickHouse query failed:', error);
    clickhouse = 'unavailable';
  }

  return c.json({
    username: user.githubUsername,
    otelEnabled: row?.otelEnabled ?? false,
    otelSetupAt: row?.otelSetupAt ? new Date(row.otelSetupAt).toISOString() : null,
    lastLiveEventAt,
    lastEventAt,
    clickhouse,
    // 'legacy' means a pre-2.0 token_gen bearer: it works, but it can only be
    // revoked by logging every machine out at once. `doctor` says so.
    tokenKind: c.get('tokenKind'),
    deviceId: c.get('deviceTokenId'),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Devices — one revocable token per machine
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/cli/devices — what `clawdgg devices` lists. */
cli.get('/devices', requireBearerAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  return c.json({
    devices: await listDeviceTokens(user.id),
    // Lets the CLI mark one row "this machine" without storing its own id.
    currentDeviceId: c.get('deviceTokenId'),
  });
});

/**
 * POST /api/cli/devices/revoke — { id } or { all: true }
 *
 * `all` also bumps users.token_gen, so a legacy bearer (which has no
 * device_tokens row) dies with the rest.
 */
cli.post('/devices/revoke', requireBearerAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { id?: unknown; all?: unknown };
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.all === true) {
    const revoked = await revokeAllDeviceTokens(user.id);
    return c.json({ success: true, revoked, all: true });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^[0-9a-f]{32}$/.test(id)) {
    return c.json({ error: 'Pass a device id, or { "all": true }' }, 400);
  }

  const revoked = await revokeDeviceToken(user.id, id);
  if (!revoked) return c.json({ error: 'No such live device' }, 404);

  return c.json({
    success: true,
    revoked: 1,
    // The CLI clears its own credentials when it revokes the device it's using.
    wasCurrentDevice: id === c.get('deviceTokenId'),
  });
});

/** PATCH /api/cli/devices/:id — { name }. The CLI sets its hostname after login. */
cli.patch('/devices/:id', requireBearerAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ error: 'Invalid device id' }, 400);

  let body: { name?: unknown };
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!(await renameDeviceToken(user.id, id, body.name))) {
    return c.json({ error: 'No such device' }, 404);
  }

  return c.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/cli/logout — revoke THIS device
// ═══════════════════════════════════════════════════════════════════════════
//
// Only this one. `clawdgg devices revoke --all` is the "log me out everywhere"
// button; logout used to be that by accident, because revocation was a per-user
// token_gen bump.
cli.post('/logout', requireBearerAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const tokenId = c.get('deviceTokenId');

  // A legacy bearer has no row to revoke, so the only lever is the gen bump —
  // which does log every machine out. Said plainly in the response.
  if (!tokenId) {
    const revoked = await revokeAllDeviceTokens(user.id);
    return c.json({ success: true, revokedAllDevices: true, revoked, tokenKind: 'legacy' });
  }

  const revoked = await revokeDeviceToken(user.id, tokenId);
  return c.json({ success: true, revokedAllDevices: false, revoked: revoked ? 1 : 0 });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/cli/import — one-time history backfill from local transcripts
// ═══════════════════════════════════════════════════════════════════════════
//
// `clawdgg import` maps the user's own ~/.claude JSONL files with the shared
// mapper (src/lib/session-import.ts) and posts the resulting rows here. Five
// rules, all enforced on this side because the client is the user's machine:
//
//   1. user_id is taken from the bearer token, never from the payload.
//   2. provenance is always 'import'.
//   3. rows must predate the user's OTEL setup, or live data would be
//      double-counted by an import that overlaps it.
//   4. re-importing inserts nothing: rows whose ReplacingMergeTree key already
//      exists are dropped before the insert.
//   5. a user who still carries a legacy dailyStats snapshot is refused — that
//      snapshot is already added on top of ClickHouse totals, so importing the
//      same history would count it twice.

export const MAX_IMPORT_BODY_SIZE = 8 * 1024 * 1024; // 8MB
export const MAX_IMPORT_ROWS = 20_000;

const ALLOWED_EVENT_NAMES = new Set([
  'claude_code.user_prompt',
  'claude_code.api_request',
  'claude_code.tool_result',
]);
const ALLOWED_METRIC_NAMES = new Set(['claude_code.token.usage', 'claude_code.cost.usage']);
const ALLOWED_TOKEN_TYPES = new Set(['input', 'output', 'cacheRead', 'cacheCreation']);

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/**
 * Identifiers go into a ClickHouse tuple literal for the duplicate lookup, so
 * they are reduced to a charset that cannot carry a quote or a comment. Session
 * ids are UUIDs and tool/model names are identifiers, so nothing real is lost —
 * and the sanitized value is what gets inserted, so the keys still line up.
 */
function safeIdentifier(value: unknown, maxLen: number): string {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._:\-]/g, '')
    .slice(0, maxLen);
}

function safeCount(value: unknown, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.min(Math.floor(num), max);
}

function safeAmount(value: unknown, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.min(num, max);
}

/** ms since epoch for a 'YYYY-MM-DD HH:MM:SS.sss' UTC literal, or null. */
function parseRowTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return null;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export interface ImportCounts {
  accepted: number;
  inserted: number;
  rejected: number;
  skippedAfterCutoff: number;
  skippedDuplicate: number;
}

export interface ImportResult extends ImportCounts {
  cutoff: string;
}

export interface ImportDeps {
  /** Rows at or after this instant are refused. */
  cutoffMs: number;
  /** Which of these row_ids events_raw already holds. */
  existingEventIds(ids: string[]): Promise<Set<string>>;
  /** Which of these row_ids metrics_raw already holds. */
  existingMetricIds(ids: string[]): Promise<Set<string>>;
  insertEvents(rows: EventRow[]): Promise<void>;
  insertMetrics(rows: MetricRow[]): Promise<void>;
}

/**
 * Provenances an imported row could already exist under.
 *
 * `provenance` is part of the row identity, so the same JSONL line hashes to a
 * different row_id per provenance — and a user whose history was already put
 * in by the operator-run backfill, or by the daily_stats import, would get a
 * second copy of every row. Checking all three is what makes the import
 * idempotent across them instead of only against itself.
 */
const IMPORT_EQUIVALENT_PROVENANCES: readonly RowProvenance[] = ['backfill', 'legacy'];

/** Every row_id this row could already be stored under. */
function candidateEventIds(row: ImportEventRow): string[] {
  const base = row as unknown as EventRow;
  return [
    eventRowId(base),
    ...IMPORT_EQUIVALENT_PROVENANCES.map((provenance) => eventRowId({ ...base, provenance })),
  ];
}

function candidateMetricIds(row: ImportMetricRow): string[] {
  const base = row as unknown as MetricRow;
  return [
    metricRowId(base),
    ...IMPORT_EQUIVALENT_PROVENANCES.map((provenance) => metricRowId({ ...base, provenance })),
  ];
}

interface Sanitized {
  events: ImportEventRow[];
  metrics: ImportMetricRow[];
  rejected: number;
  skippedAfterCutoff: number;
}

/** Validate, clamp and re-stamp every row the client sent. Exported for tests. */
export function sanitizeImportRows(userId: string, body: unknown, cutoffMs: number): Sanitized {
  const out: Sanitized = { events: [], metrics: [], rejected: 0, skippedAfterCutoff: 0 };
  const payload = (body ?? {}) as { events?: unknown; metrics?: unknown };

  for (const raw of Array.isArray(payload.events) ? payload.events : []) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const ms = parseRowTimestamp(row.timestamp);
    const eventName = String(row.event_name ?? '');

    if (ms === null || !ALLOWED_EVENT_NAMES.has(eventName)) {
      out.rejected++;
      continue;
    }
    if (ms >= cutoffMs) {
      out.skippedAfterCutoff++;
      continue;
    }

    const event: ImportEventRow = {
      timestamp: row.timestamp as string,
      user_id: userId,
      session_id: safeIdentifier(row.session_id, 256),
      event_name: eventName,
      provenance: 'import',
    };
    if (eventName === 'claude_code.user_prompt') {
      event.prompt_length = safeCount(row.prompt_length, 1_000_000);
    }
    if (eventName === 'claude_code.tool_result') {
      event.tool_name = safeIdentifier(row.tool_name, 200);
      // Part of the row identity: without it, two calls to the same tool in
      // one assistant message hash alike and collapse into one row.
      event.tool_use_id = safeIdentifier(row.tool_use_id, 100);
    }
    if (eventName === 'claude_code.api_request') {
      event.model = safeIdentifier(row.model, 100);
      event.cost_usd = safeAmount(row.cost_usd, 10_000);
      event.input_tokens = safeCount(row.input_tokens, 1e12);
      event.output_tokens = safeCount(row.output_tokens, 1e12);
      event.cache_read_tokens = safeCount(row.cache_read_tokens, 1e12);
      event.cache_write_tokens = safeCount(row.cache_write_tokens, 1e12);
    }
    out.events.push(event);
  }

  for (const raw of Array.isArray(payload.metrics) ? payload.metrics : []) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const ms = parseRowTimestamp(row.timestamp);
    const metricName = String(row.metric_name ?? '');

    if (ms === null || !ALLOWED_METRIC_NAMES.has(metricName)) {
      out.rejected++;
      continue;
    }
    if (ms >= cutoffMs) {
      out.skippedAfterCutoff++;
      continue;
    }

    const tokenType = String(row.token_type ?? '');
    const metric: ImportMetricRow = {
      timestamp: row.timestamp as string,
      user_id: userId,
      session_id: safeIdentifier(row.session_id, 256),
      metric_name: metricName,
      value: safeAmount(row.value, 1e12),
      model: safeIdentifier(row.model, 100),
      provenance: 'import',
    };
    if (ALLOWED_TOKEN_TYPES.has(tokenType)) metric.token_type = tokenType;
    out.metrics.push(metric);
  }

  return out;
}

/**
 * Drop rows already in ClickHouse under any equivalent provenance, and rows
 * duplicated inside this batch. The first candidate id is the row's own.
 */
export function dropDuplicates<T>(
  rows: T[],
  candidateIds: (row: T) => string[],
  existing: Set<string>
): { kept: T[]; skipped: number } {
  const seen = new Set<string>();
  const kept: T[] = [];
  let skipped = 0;

  for (const row of rows) {
    const ids = candidateIds(row);
    if (ids.some((id) => existing.has(id)) || seen.has(ids[0]!)) {
      skipped++;
      continue;
    }
    seen.add(ids[0]!);
    kept.push(row);
  }

  return { kept, skipped };
}

/** The whole import, with its I/O injected so the tests can stub it. */
export async function runImport(
  userId: string,
  body: unknown,
  deps: ImportDeps
): Promise<ImportResult> {
  const sanitized = sanitizeImportRows(userId, body, deps.cutoffMs);

  const events = dropDuplicates(
    sanitized.events,
    candidateEventIds,
    await deps.existingEventIds(sanitized.events.flatMap(candidateEventIds))
  );
  const metrics = dropDuplicates(
    sanitized.metrics,
    candidateMetricIds,
    await deps.existingMetricIds(sanitized.metrics.flatMap(candidateMetricIds))
  );

  // ImportEventRow widens clickhouse.ts's RowProvenance, which doesn't carry
  // 'import' yet; the ClickHouse column is `String DEFAULT 'live'`, so the
  // value itself is fine. insertEvents/insertMetrics fill row_id.
  if (events.kept.length > 0) await deps.insertEvents(events.kept as unknown as EventRow[]);
  if (metrics.kept.length > 0) await deps.insertMetrics(metrics.kept as unknown as MetricRow[]);

  return {
    accepted: sanitized.events.length + sanitized.metrics.length,
    inserted: events.kept.length + metrics.kept.length,
    rejected: sanitized.rejected,
    skippedAfterCutoff: sanitized.skippedAfterCutoff,
    skippedDuplicate: events.skipped + metrics.skipped,
    cutoff: new Date(deps.cutoffMs).toISOString(),
  };
}

/** How many row_ids one lookup query carries. 32 hex chars + quotes each. */
const ID_LOOKUP_CHUNK = 5_000;

/**
 * Which of these row_ids the table already holds.
 *
 * row_id is a 32-char hex hash, so the literal list needs no escaping beyond
 * the shape check — anything that isn't hex never reaches the query.
 */
async function lookupExistingIds(
  table: 'events_raw' | 'metrics_raw',
  userId: string,
  ids: string[]
): Promise<Set<string>> {
  const hexIds = [...new Set(ids)].filter((id) => /^[0-9a-f]{32}$/.test(id));
  const found = new Set<string>();

  for (let i = 0; i < hexIds.length; i += ID_LOOKUP_CHUNK) {
    const chunk = hexIds.slice(i, i + ID_LOOKUP_CHUNK);
    const list = chunk.map((id) => `'${id}'`).join(',');
    const rows = await query<{ row_id: string }>(
      `SELECT DISTINCT row_id FROM ${table}
       WHERE user_id = {userId:String} AND row_id IN (${list})`,
      { userId }
    );
    for (const row of rows) found.add(row.row_id);
  }

  return found;
}

cli.post('/import', requireBearerAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const declaredSize = Number(c.req.header('Content-Length') ?? 0);
  if (declaredSize > MAX_IMPORT_BODY_SIZE) {
    return c.json({ error: 'Request body too large', maxBytes: MAX_IMPORT_BODY_SIZE }, 413);
  }

  const row = await db
    .select({
      otelSetupAt: users.otelSetupAt,
      legacyTotalPrompts: users.legacyTotalPrompts,
      legacyTotalTokens: users.legacyTotalTokens,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .get();

  // src/routes/api.ts still adds users.legacy_total_* on top of the ClickHouse
  // totals for all-time views, so for a user who has that snapshot an import of
  // the same history doubles every number — the same trap
  // docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts warns about.
  // Refuse rather than inflate; this can be lifted with the legacy read paths.
  if ((row?.legacyTotalPrompts ?? 0) > 0 || (row?.legacyTotalTokens ?? 0) > 0) {
    return c.json(
      {
        error: 'Already counted',
        reason: 'legacy-snapshot',
        message:
          'Your pre-OTEL history is already counted from an earlier `clawdgg sync`. ' +
          'Importing it again would double every all-time total, so this import was refused.',
      },
      409
    );
  }

  // No setup timestamp yet means nothing live has arrived, so "now" is the
  // cutoff: everything in the transcripts predates the first exported event.
  const cutoffMs = row?.otelSetupAt ? new Date(row.otelSetupAt).getTime() : Date.now();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const payload = (body ?? {}) as { events?: unknown[]; metrics?: unknown[] };
  const rowCount =
    (Array.isArray(payload.events) ? payload.events.length : 0) +
    (Array.isArray(payload.metrics) ? payload.metrics.length : 0);
  if (rowCount > MAX_IMPORT_ROWS) {
    return c.json({ error: 'Too many rows in one batch', maxRows: MAX_IMPORT_ROWS }, 413);
  }

  try {
    const result = await runImport(user.id, body, {
      cutoffMs,
      existingEventIds: (ids) => lookupExistingIds('events_raw', user.id, ids),
      existingMetricIds: (ids) => lookupExistingIds('metrics_raw', user.id, ids),
      insertEvents,
      insertMetrics,
    });

    console.log(
      `[cli/import] ${user.githubUsername}: inserted ${result.inserted}, ` +
        `dup ${result.skippedDuplicate}, after-cutoff ${result.skippedAfterCutoff}, rejected ${result.rejected}`
    );
    return c.json(result);
  } catch (error) {
    console.error('[cli/import] failed:', error);
    return c.json({ error: 'Import failed' }, 500);
  }
});

export default cli;
