/**
 * Endpoints the `clawdgg` CLI calls on its own behalf.
 *
 * Mounted at /api/cli, so the /api/* rate limiter applies the same way it does
 * to the rest of the API. Every route here is BEARER-ONLY (requireBearerAuth):
 * a cookie session is refused, because these are called by a local binary and
 * accepting the cookie would make "revoke all my devices" a CSRF one-liner.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
} from '../db/clickhouse';
import {
  computeCostUsd,
  isBuiltinSlashCommand,
  type ImportEventRow,
  type ImportMetricRow,
} from '../lib/session-import';

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
// mapper (src/lib/session-import.ts) and posts the resulting rows here.
//
// The client is the user's own machine, so nothing it says about a measurement
// is taken on trust. What survives from the payload is timestamps, model ids
// and token COUNTS; everything derived from them is computed here:
//
//   1. user_id comes from the bearer token, never from the payload.
//   2. provenance is always 'import'.
//   3. cost_usd is RECOMPUTED from model + tokens with the shared pricing
//      table. A client that claims $40,000 of Opus gets priced like everyone
//      else — the leaderboard is ranked on this number.
//   4. metrics are DERIVED from the sanitized api_request events. The client's
//      metrics array is ignored outright: it is the same information twice,
//      and accepting both lets one of them lie.
//   5. token counts are clamped to what one request can plausibly hold, and
//      timestamps outside [2025-02-01, cutoff) are refused.
//   6. the cutoff is min(users.otel_setup_at, first live event), computed here.
//   7. a UTC day that already holds rows of ANY provenance is skipped whole.

export const MAX_IMPORT_BODY_SIZE = 8 * 1024 * 1024; // 8MB
export const MAX_IMPORT_ROWS = 20_000;

/**
 * Claude Code did not exist before this, so a row claiming to predate it is
 * either a clock problem or a forgery. Either way it is not history.
 */
export const EARLIEST_PLAUSIBLE_MS = Date.parse('2025-02-01T00:00:00.000Z');

/**
 * Per-request ceilings. A single api_request cannot exceed the context window
 * (1M today) by any margin that matters, and the output cap is ~128K. These are
 * generous multiples of both: the point is that one forged row cannot add a
 * trillion tokens to a leaderboard, not to second-guess a real one.
 */
export const MAX_INPUT_TOKENS_PER_REQUEST = 2_000_000;
export const MAX_OUTPUT_TOKENS_PER_REQUEST = 500_000;
export const MAX_CACHE_TOKENS_PER_REQUEST = 2_000_000;
export const MAX_PROMPT_LENGTH = 1_000_000;

const ALLOWED_EVENT_NAMES = new Set([
  'claude_code.user_prompt',
  'claude_code.api_request',
  'claude_code.tool_result',
]);

/** Claude Code 2.1.117+ user_prompt attribution. */
const ALLOWED_COMMAND_SOURCES = new Set(['builtin', 'custom', 'mcp']);

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/**
 * Identifiers are reduced to a charset that cannot carry a quote or a comment.
 * Session ids are UUIDs and tool/model names are identifiers, so nothing real
 * is lost — and the sanitized value is what gets inserted, so the row identity
 * is computed over exactly what is stored.
 */
function safeIdentifier(value: unknown, maxLen: number): string {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._:\-]/g, '')
    .slice(0, maxLen);
}

interface ClampResult {
  value: number;
  clamped: boolean;
}

function safeCount(value: unknown, max: number): ClampResult {
  const num = Number(value);
  // Infinity and NaN are nonsense rather than "very large": they become 0,
  // never a clamped maximum that would inflate someone's totals.
  if (!Number.isFinite(num) || num < 0) return { value: 0, clamped: false };
  const floored = Math.floor(num);
  return floored > max ? { value: max, clamped: true } : { value: floored, clamped: false };
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
  /** Rows claiming to predate Claude Code. */
  skippedBeforeEpoch: number;
  /** Built-in slash commands, which are not prompts. */
  skippedBuiltinCommand: number;
  /** Rows dropped because that whole UTC day is already on record. */
  skippedCoveredDay: number;
  /** Rows identical to another row in the same batch. */
  skippedDuplicate: number;
  /** Token counts that exceeded a per-request maximum and were capped. */
  clamped: number;
  /** Client-sent metric rows thrown away — we derive our own. */
  ignoredClientMetrics: number;
}

export interface ImportResult extends ImportCounts {
  cutoff: string;
  /** The UTC days we refused, so the CLI can say which and why. */
  skippedDays: string[];
}

export interface ImportDeps {
  /** Rows at or after this instant are refused. */
  cutoffMs: number;
  /** UTC days (YYYY-MM-DD) that already hold rows of ANY provenance. */
  coveredDays: Set<string>;
  insertEvents(rows: EventRow[]): Promise<void>;
  insertMetrics(rows: MetricRow[]): Promise<void>;
}

/**
 * ImportEventRow plus the two user_prompt attribution columns. Both exist on
 * clickhouse.ts's EventRow and in the DDL, but not yet on the shared mapper's
 * row type in src/lib/session-import.ts — widening here keeps the validation
 * server-side without reaching into that file.
 */
type SanitizedEventRow = ImportEventRow & {
  command_name?: string;
  command_source?: string;
};

interface Sanitized {
  events: SanitizedEventRow[];
  /** Derived here from the events above — never taken from the payload. */
  metrics: ImportMetricRow[];
  rejected: number;
  skippedAfterCutoff: number;
  skippedBeforeEpoch: number;
  skippedBuiltinCommand: number;
  clamped: number;
  ignoredClientMetrics: number;
}

/**
 * Metric rows for one api_request, byte-identical to what the shared mapper
 * emits for the same line.
 *
 * They have to be: `metricRowId` hashes timestamp + session + metric + model +
 * token_type + provenance, so a row derived here and the same row produced by
 * the operator-run backfill collapse onto each other under ReplacingMergeTree
 * instead of double-counting.
 */
function deriveMetrics(event: SanitizedEventRow): ImportMetricRow[] {
  const base = {
    timestamp: event.timestamp,
    user_id: event.user_id,
    session_id: event.session_id,
    model: event.model ?? '',
    provenance: event.provenance,
  };
  const metrics: ImportMetricRow[] = [];

  const tokens: [string, number][] = [
    ['input', event.input_tokens ?? 0],
    ['output', event.output_tokens ?? 0],
    ['cacheRead', event.cache_read_tokens ?? 0],
    ['cacheCreation', event.cache_write_tokens ?? 0],
  ];
  for (const [tokenType, value] of tokens) {
    if (value > 0) {
      metrics.push({
        ...base,
        metric_name: 'claude_code.token.usage',
        value,
        token_type: tokenType,
      });
    }
  }

  if ((event.cost_usd ?? 0) > 0) {
    metrics.push({
      ...base,
      metric_name: 'claude_code.cost.usage',
      value: event.cost_usd!,
      pricing_source: event.pricing_source,
    });
  }

  return metrics;
}

/** Validate, clamp and re-stamp every row the client sent. Exported for tests. */
export function sanitizeImportRows(userId: string, body: unknown, cutoffMs: number): Sanitized {
  const out: Sanitized = {
    events: [],
    metrics: [],
    rejected: 0,
    skippedAfterCutoff: 0,
    skippedBeforeEpoch: 0,
    skippedBuiltinCommand: 0,
    clamped: 0,
    ignoredClientMetrics: 0,
  };
  const payload = (body ?? {}) as { events?: unknown; metrics?: unknown };

  // Counted, then discarded. Everything they could carry is derived from the
  // events, and two independent copies of one measurement is one copy too many.
  out.ignoredClientMetrics = Array.isArray(payload.metrics) ? payload.metrics.length : 0;

  for (const raw of Array.isArray(payload.events) ? payload.events : []) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const ms = parseRowTimestamp(row.timestamp);
    const eventName = String(row.event_name ?? '');

    if (ms === null || !ALLOWED_EVENT_NAMES.has(eventName)) {
      out.rejected++;
      continue;
    }
    if (ms < EARLIEST_PLAUSIBLE_MS) {
      out.skippedBeforeEpoch++;
      continue;
    }
    if (ms >= cutoffMs) {
      out.skippedAfterCutoff++;
      continue;
    }

    const event: SanitizedEventRow = {
      timestamp: row.timestamp as string,
      user_id: userId,
      session_id: safeIdentifier(row.session_id, 256),
      event_name: eventName,
      provenance: 'import',
    };

    if (eventName === 'claude_code.user_prompt') {
      // The client mapper drops built-in slash commands, but "the client
      // dropped them" is not a guarantee — a built-in is session management,
      // not a prompt, and the prompt count is a ranked metric.
      const commandSource = row.command_source === undefined ? null : String(row.command_source);
      if (commandSource !== null && !ALLOWED_COMMAND_SOURCES.has(commandSource)) {
        out.rejected++;
        continue;
      }
      const commandName = safeIdentifier(row.command_name, 100);
      if (commandSource === 'builtin' || (commandName && isBuiltinSlashCommand(`/${commandName}`))) {
        out.skippedBuiltinCommand++;
        continue;
      }
      if (commandSource) event.command_source = commandSource;
      if (commandName) event.command_name = commandName;

      const prompt = safeCount(row.prompt_length, MAX_PROMPT_LENGTH);
      if (prompt.clamped) out.clamped++;
      event.prompt_length = prompt.value;
    }

    if (eventName === 'claude_code.tool_result') {
      event.tool_name = safeIdentifier(row.tool_name, 200);
      // Part of the row identity: without it, two calls to the same tool in
      // one assistant message hash alike and collapse into one row.
      event.tool_use_id = safeIdentifier(row.tool_use_id, 100);
    }

    if (eventName === 'claude_code.api_request') {
      const model = safeIdentifier(row.model, 100);
      const input = safeCount(row.input_tokens, MAX_INPUT_TOKENS_PER_REQUEST);
      const output = safeCount(row.output_tokens, MAX_OUTPUT_TOKENS_PER_REQUEST);
      const cacheRead = safeCount(row.cache_read_tokens, MAX_CACHE_TOKENS_PER_REQUEST);
      const cacheWrite = safeCount(row.cache_write_tokens, MAX_CACHE_TOKENS_PER_REQUEST);
      // Only ever used for pricing, and only as far as the flat total allows.
      // It is never written to `event`: events_raw has no column for it, and
      // the cost it produces below is the whole reason the client sends it.
      const cacheWrite1h = safeCount(row.cache_write_1h_tokens, cacheWrite.value);
      if (input.clamped || output.clamped || cacheRead.clamped || cacheWrite.clamped) out.clamped++;

      event.model = model;
      event.input_tokens = input.value;
      event.output_tokens = output.value;
      event.cache_read_tokens = cacheRead.value;
      event.cache_write_tokens = cacheWrite.value;

      // The client's cost_usd is not read at all. Same table, same rules, same
      // number as the operator-run backfill would compute for this row.
      const estimate = computeCostUsd(model, {
        input_tokens: input.value,
        output_tokens: output.value,
        cache_read_input_tokens: cacheRead.value,
        cache_creation_input_tokens: cacheWrite.value,
        cache_creation: {
          ephemeral_1h_input_tokens: cacheWrite1h.value,
          ephemeral_5m_input_tokens: cacheWrite.value - cacheWrite1h.value,
        },
      });
      event.cost_usd = estimate.costUsd;
      event.pricing_source = estimate.pricingSource;

      out.metrics.push(...deriveMetrics(event));
    }

    out.events.push(event);
  }

  return out;
}

/** Drop rows duplicated inside this batch. The id is the row's own identity. */
export function dropDuplicates<T>(
  rows: T[],
  rowId: (row: T) => string
): { kept: T[]; skipped: number } {
  const seen = new Set<string>();
  const kept: T[] = [];
  let skipped = 0;

  for (const row of rows) {
    const id = rowId(row);
    if (seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    kept.push(row);
  }

  return { kept, skipped };
}

/**
 * Drop every row falling on a UTC day that is already on record.
 *
 * Day granularity, and every provenance, because the alternatives do not work:
 * `provenance` is part of the row identity, so the same JSONL line hashes
 * differently as 'import' than as 'backfill' or 'legacy' — a row-id check
 * cannot see that the operator backfill, the daily_stats import or live
 * telemetry already counted this history. A day either has been counted or it
 * has not, and that is a question the row identity can't answer but a date can.
 *
 * It also makes a re-import insert exactly nothing, which is the behaviour
 * `clawdgg import` promises when it says it is safe to run again.
 */
export function dropCoveredDays<T extends { timestamp: string }>(
  rows: T[],
  coveredDays: Set<string>
): { kept: T[]; skipped: number; days: string[] } {
  const kept: T[] = [];
  const days = new Set<string>();
  let skipped = 0;

  for (const row of rows) {
    const day = row.timestamp.slice(0, 10);
    if (coveredDays.has(day)) {
      days.add(day);
      skipped++;
      continue;
    }
    kept.push(row);
  }

  return { kept, skipped, days: [...days].sort() };
}

/** The whole import, with its I/O injected so the tests can stub it. */
export async function runImport(
  userId: string,
  body: unknown,
  deps: ImportDeps
): Promise<ImportResult> {
  const sanitized = sanitizeImportRows(userId, body, deps.cutoffMs);

  const eventDays = dropCoveredDays(sanitized.events, deps.coveredDays);
  const metricDays = dropCoveredDays(sanitized.metrics, deps.coveredDays);

  const events = dropDuplicates(eventDays.kept, eventRowId);
  const metrics = dropDuplicates(metricDays.kept, metricRowId);

  if (events.kept.length > 0) await deps.insertEvents(events.kept);
  if (metrics.kept.length > 0) await deps.insertMetrics(metrics.kept);

  return {
    accepted: sanitized.events.length + sanitized.metrics.length,
    inserted: events.kept.length + metrics.kept.length,
    rejected: sanitized.rejected,
    skippedAfterCutoff: sanitized.skippedAfterCutoff,
    skippedBeforeEpoch: sanitized.skippedBeforeEpoch,
    skippedBuiltinCommand: sanitized.skippedBuiltinCommand,
    skippedCoveredDay: eventDays.skipped + metricDays.skipped,
    skippedDuplicate: events.skipped + metrics.skipped,
    clamped: sanitized.clamped,
    ignoredClientMetrics: sanitized.ignoredClientMetrics,
    cutoff: new Date(deps.cutoffMs).toISOString(),
    skippedDays: [...new Set([...eventDays.days, ...metricDays.days])].sort(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Server-side inputs to the above
// ───────────────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' for a ClickHouse Date, whatever shape the driver returns. */
function toDayString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Every UTC day this user already has a raw row on, of any provenance. */
async function fetchCoveredDays(userId: string): Promise<Set<string>> {
  const days = new Set<string>();

  for (const table of ['events_raw', 'metrics_raw'] as const) {
    const rows = await query<{ day: string }>(
      `SELECT DISTINCT toString(toDate(timestamp)) AS day
       FROM ${table}
       WHERE user_id = {userId:String}`,
      { userId }
    );
    for (const row of rows) {
      const day = toDayString(row.day);
      if (day) days.add(day);
    }
  }

  return days;
}

/**
 * The instant the import must stop at: whichever came first, the user's OTEL
 * setup or the first event that actually arrived live.
 *
 * Both, not just otel_setup_at, because they can disagree. A user who set up,
 * streamed for a week and then had otel_setup_at rewritten by a second `setup`
 * would otherwise be allowed to import over a week of live data.
 */
async function computeImportCutoff(userId: string, otelSetupAt: Date | null): Promise<number> {
  const candidates: number[] = [];
  if (otelSetupAt) candidates.push(new Date(otelSetupAt).getTime());

  try {
    for (const table of ['events_raw', 'metrics_raw'] as const) {
      const rows = await query<{ first_live: string }>(
        `SELECT min(timestamp) AS first_live
         FROM ${table}
         WHERE user_id = {userId:String} AND provenance = 'live'`,
        { userId }
      );
      const iso = toIsoOrNull(rows[0]?.first_live);
      if (iso) candidates.push(new Date(iso).getTime());
    }
  } catch (error) {
    // A ClickHouse hiccup must not widen the window. Fall back to what SQLite
    // knows, or to "now" — both are conservative.
    console.error('[cli/import] first-live lookup failed:', error);
  }

  const valid = candidates.filter((ms) => Number.isFinite(ms));
  return valid.length > 0 ? Math.min(...valid) : Date.now();
}

/**
 * The covered-day set, cached for the life of one `clawdgg import` run.
 *
 * It has to be: a full history is more rows than one request carries, and the
 * FIRST batch inserts rows that would make its own day "covered" for the
 * second. The run id makes the snapshot stable across the batches of one run,
 * while a later run recomputes it and so inserts nothing.
 */
const IMPORT_RUN_TTL_MS = 30 * 60 * 1000;
const RUN_ID_RE = /^[0-9a-zA-Z-]{1,64}$/;

const importRuns = new Map<string, { days: Set<string>; expiresAt: number }>();

async function coveredDaysForRun(userId: string, runId: unknown): Promise<Set<string>> {
  const now = Date.now();
  for (const [key, entry] of importRuns) {
    if (entry.expiresAt <= now) importRuns.delete(key);
  }

  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    return fetchCoveredDays(userId);
  }

  const key = `${userId}:${runId}`;
  const cached = importRuns.get(key);
  if (cached) return cached.days;

  const days = await fetchCoveredDays(userId);
  importRuns.set(key, { days, expiresAt: now + IMPORT_RUN_TTL_MS });
  return days;
}

/**
 * A budget for /import on top of the global /api/* limiter.
 *
 * The global one (60/min) is what a browsing user hits; this one bounds how
 * much history a single account can push at us in an afternoon. 300 requests
 * per 10 minutes is ~1.5M rows — far more than any real transcript tree.
 */
const IMPORT_RATE_WINDOW_MS = 10 * 60 * 1000;
const IMPORT_RATE_MAX = 300;

const importRates = new Map<string, { count: number; windowEndsAt: number }>();

export function checkImportRate(
  userId: string,
  now: number = Date.now()
): { ok: boolean; retryAfterSeconds: number } {
  for (const [key, entry] of importRates) {
    if (entry.windowEndsAt <= now) importRates.delete(key);
  }

  const entry = importRates.get(userId);
  if (!entry || entry.windowEndsAt <= now) {
    importRates.set(userId, { count: 1, windowEndsAt: now + IMPORT_RATE_WINDOW_MS });
    return { ok: true, retryAfterSeconds: 0 };
  }

  entry.count++;
  if (entry.count > IMPORT_RATE_MAX) {
    return { ok: false, retryAfterSeconds: Math.ceil((entry.windowEndsAt - now) / 1000) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

cli.post(
  '/import',
  requireBearerAuth,
  // A declared Content-Length is a claim, not a limit: a chunked body has none.
  // This counts the bytes as they arrive and aborts the stream.
  bodyLimit({
    maxSize: MAX_IMPORT_BODY_SIZE,
    onError: (c) =>
      c.json({ error: 'Request body too large', maxBytes: MAX_IMPORT_BODY_SIZE }, 413),
  }),
  async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const rate = checkImportRate(user.id);
    if (!rate.ok) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json(
        { error: 'Too many import requests', retryAfter: rate.retryAfterSeconds },
        429
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const payload = (body ?? {}) as { events?: unknown[]; metrics?: unknown[]; runId?: unknown };
    const rowCount =
      (Array.isArray(payload.events) ? payload.events.length : 0) +
      (Array.isArray(payload.metrics) ? payload.metrics.length : 0);
    if (rowCount > MAX_IMPORT_ROWS) {
      return c.json({ error: 'Too many rows in one batch', maxRows: MAX_IMPORT_ROWS }, 413);
    }

    const row = await db
      .select({ otelSetupAt: users.otelSetupAt })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    try {
      const [cutoffMs, coveredDays] = await Promise.all([
        computeImportCutoff(user.id, row?.otelSetupAt ?? null),
        coveredDaysForRun(user.id, payload.runId),
      ]);

      const result = await runImport(user.id, body, {
        cutoffMs,
        coveredDays,
        insertEvents,
        insertMetrics,
      });


      console.log(
        `[cli/import] ${user.githubUsername}: inserted ${result.inserted}, ` +
          `covered-day ${result.skippedCoveredDay}, dup ${result.skippedDuplicate}, ` +
          `after-cutoff ${result.skippedAfterCutoff}, rejected ${result.rejected}`
      );
      return c.json(result);
    } catch (error) {
      console.error('[cli/import] failed:', error);
      return c.json({ error: 'Import failed' }, 500);
    }
  }
);

export default cli;
