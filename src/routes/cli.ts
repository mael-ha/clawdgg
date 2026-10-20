/**
 * Endpoints the `clawdgg` CLI calls on its own behalf.
 *
 * Mounted at /api/cli, so the /api/* rate limiter applies the same way it does
 * to the rest of the API. Every route here is BEARER-ONLY (requireBearerAuth):
 * a cookie session is refused, because these are called by a local binary and
 * accepting the cookie would make "revoke all my devices" a CSRF one-liner.
 */

import { Hono, type Context } from 'hono';
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
  ULTRATHINK_EVENT_NAME,
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
  fmtTs,
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
//   8. ULTRATHINK FLAGS ANSWER TO A DIFFERENT CUTOFF — see ImportDeps.flagCutoffMs.

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
  // The ultrathink flag, matched on the client against the user's own history.
  // It carries no payload at all beyond a timestamp and a session id — see
  // src/lib/ultrathink.ts for why the match cannot happen here.
  ULTRATHINK_EVENT_NAME,
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
  /** Flags past the flag cutoff — the hook was already recording them. */
  skippedAfterFlagCutoff: number;
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
  /** The separate boundary the ultrathink flags answered to. */
  flagCutoff: string;
  /** The UTC days we refused, so the CLI can say which and why. */
  skippedDays: string[];
}

export interface ImportDeps {
  /** Measured rows at or after this instant are refused. */
  cutoffMs: number;
  /**
   * Ultrathink flags at or after this instant are refused, and it is
   * deliberately NOT `cutoffMs`.
   *
   * `cutoffMs` is where LIVE TELEMETRY starts, because from there on the server
   * has Claude Code's own measurement and an import would be a second opinion
   * about the same requests. That reasoning does not transfer to the flag:
   * there is no OTEL event for "the prompt said ultrathink", so live telemetry
   * never carried one. Judging flags by the prompt cutoff meant the window
   * between a user's first live event and the day they installed the hook could
   * NEVER be recorded — for the owner, four months of it.
   *
   * So the boundary is where the HOOK starts instead: the user's first
   * 'hook'-provenance flag, or now if they have never run it. Before that
   * instant nothing was recording flags and the import is the only source;
   * after it the hook is, and the import must not add a second one.
   *
   * Widening it is safe because a flag carries no measurement — no token, no
   * dollar, only a count — and the READ side caps that count at the number of
   * prompts the same local day actually holds (CAPPED_ULTRATHINKS_SQL in
   * src/db/clickhouse.ts). A client that sent a flag every millisecond for a
   * year still could not push its ultrathink share over 100%.
   */
  flagCutoffMs: number;
  /** UTC days (YYYY-MM-DD) that already hold rows of ANY provenance. */
  coveredDays: Set<string>;
  /**
   * UTC days that already hold an ultrathink flag.
   *
   * A SEPARATE question from `coveredDays`, because a day being counted for
   * prompts says nothing about whether its flags were recorded — and for every
   * user who imported before the counter existed, every day is covered. Judging
   * flags by the prompt-coverage set would mean the ultrathink count could
   * never be filled in for anyone's existing history.
   */
  ultrathinkDays: Set<string>;
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
  skippedAfterFlagCutoff: number;
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

/**
 * Validate, clamp and re-stamp every row the client sent. Exported for tests.
 *
 * TWO cutoffs, because the two kinds of row are bounded by different facts —
 * see ImportDeps.flagCutoffMs. It defaults to `cutoffMs`, which is the old
 * behaviour, so a caller that has not been taught the difference cannot
 * accidentally widen the window.
 */
export function sanitizeImportRows(
  userId: string,
  body: unknown,
  cutoffMs: number,
  flagCutoffMs: number = cutoffMs
): Sanitized {
  const out: Sanitized = {
    events: [],
    metrics: [],
    rejected: 0,
    skippedAfterCutoff: 0,
    skippedAfterFlagCutoff: 0,
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
    if (eventName === ULTRATHINK_EVENT_NAME) {
      if (ms >= flagCutoffMs) {
        out.skippedAfterFlagCutoff++;
        continue;
      }
    } else if (ms >= cutoffMs) {
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
  const sanitized = sanitizeImportRows(userId, body, deps.cutoffMs, deps.flagCutoffMs);

  // The two kinds of row answer to different coverage sets — see ImportDeps.
  const flags = sanitized.events.filter((row) => row.event_name === ULTRATHINK_EVENT_NAME);
  const measured = sanitized.events.filter((row) => row.event_name !== ULTRATHINK_EVENT_NAME);

  const eventDays = dropCoveredDays(measured, deps.coveredDays);
  const flagDays = dropCoveredDays(flags, deps.ultrathinkDays);
  const metricDays = dropCoveredDays(sanitized.metrics, deps.coveredDays);

  const events = dropDuplicates([...eventDays.kept, ...flagDays.kept], eventRowId);
  const metrics = dropDuplicates(metricDays.kept, metricRowId);

  if (events.kept.length > 0) await deps.insertEvents(events.kept);
  if (metrics.kept.length > 0) await deps.insertMetrics(metrics.kept);

  return {
    accepted: sanitized.events.length + sanitized.metrics.length,
    inserted: events.kept.length + metrics.kept.length,
    rejected: sanitized.rejected,
    skippedAfterCutoff: sanitized.skippedAfterCutoff,
    skippedAfterFlagCutoff: sanitized.skippedAfterFlagCutoff,
    skippedBeforeEpoch: sanitized.skippedBeforeEpoch,
    skippedBuiltinCommand: sanitized.skippedBuiltinCommand,
    skippedCoveredDay: eventDays.skipped + flagDays.skipped + metricDays.skipped,
    skippedDuplicate: events.skipped + metrics.skipped,
    clamped: sanitized.clamped,
    ignoredClientMetrics: sanitized.ignoredClientMetrics,
    cutoff: new Date(deps.cutoffMs).toISOString(),
    flagCutoff: new Date(deps.flagCutoffMs).toISOString(),
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

/**
 * Every UTC day this user already has a MEASURED row on, of any provenance.
 *
 * Ultrathink flags are excluded, and have to be: a flag is a synthetic row with
 * no prompt, no token and no dollar in it, so a day whose only row is one has
 * not been counted — but it used to land in this set and make the import refuse
 * that day's real prompts. The hook runs on every prompt from the day it is
 * installed, so for anyone who installed it before importing, that was most of
 * their history.
 */
async function fetchCoveredDays(userId: string): Promise<Set<string>> {
  const days = new Set<string>();

  const notAFlag = {
    events_raw: `AND event_name != {flagEvent:String}`,
    metrics_raw: '',
  } as const;

  for (const table of ['events_raw', 'metrics_raw'] as const) {
    const rows = await query<{ day: string }>(
      `SELECT DISTINCT toString(toDate(timestamp)) AS day
       FROM ${table}
       WHERE user_id = {userId:String}
         ${notAFlag[table]}`,
      { userId, flagEvent: ULTRATHINK_EVENT_NAME }
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
 * The instant the HOOK took over recording flags, or now.
 *
 * Deliberately 'hook' only. An 'import' flag is a flag this endpoint accepted
 * on an earlier run, so counting those would ratchet the boundary backwards to
 * the oldest thing ever imported and freeze the gap shut after the first run.
 * 'hook' is the only provenance that means "something was watching live".
 */
async function computeFlagCutoff(userId: string): Promise<number> {
  try {
    const rows = await query<{ first_hook: string }>(
      `SELECT min(timestamp) AS first_hook
       FROM events_raw
       WHERE user_id = {userId:String}
         AND event_name = {eventName:String}
         AND provenance = 'hook'`,
      { userId, eventName: ULTRATHINK_EVENT_NAME }
    );
    const iso = toIsoOrNull(rows[0]?.first_hook);
    const ms = iso ? new Date(iso).getTime() : NaN;
    if (Number.isFinite(ms)) return ms;
  } catch (error) {
    // A hiccup must not WIDEN the window past what the hook already covers.
    // 'now' is the open end of the gap, so falling back to it would let an
    // import write over days the hook has recorded. Nothing, then.
    console.error('[cli/import] flag-cutoff lookup failed:', error);
    return 0;
  }
  return Date.now();
}

/** Every UTC day this user already holds an ultrathink flag on. */
async function fetchUltrathinkDays(userId: string): Promise<Set<string>> {
  const days = new Set<string>();
  const rows = await query<{ day: string }>(
    `SELECT DISTINCT toString(toDate(timestamp)) AS day
     FROM events_raw
     WHERE user_id = {userId:String} AND event_name = {eventName:String}`,
    { userId, eventName: ULTRATHINK_EVENT_NAME }
  );
  for (const row of rows) {
    const day = toDayString(row.day);
    if (day) days.add(day);
  }
  return days;
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

export interface RunCoverage {
  days: Set<string>;
  ultrathinkDays: Set<string>;
}

const importRuns = new Map<string, { coverage: RunCoverage; expiresAt: number }>();

async function fetchRunCoverage(userId: string): Promise<RunCoverage> {
  const [days, ultrathinkDays] = await Promise.all([
    fetchCoveredDays(userId),
    fetchUltrathinkDays(userId),
  ]);
  return { days, ultrathinkDays };
}

async function coveredDaysForRun(userId: string, runId: unknown): Promise<RunCoverage> {
  const now = Date.now();
  for (const [key, entry] of importRuns) {
    if (entry.expiresAt <= now) importRuns.delete(key);
  }

  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    return fetchRunCoverage(userId);
  }

  const key = `${userId}:${runId}`;
  const cached = importRuns.get(key);
  if (cached) return cached.coverage;

  const coverage = await fetchRunCoverage(userId);
  importRuns.set(key, { coverage, expiresAt: now + IMPORT_RUN_TTL_MS });
  return coverage;
}

/**
 * What this user's import would be allowed to add, as a question answerable
 * BEFORE the upload.
 *
 * The CLI's preview used to be a count of its own local rows, which overstated
 * what would land by however much of that history the server already held —
 * for the owner's first real run, 37 of 68 days were already covered by a
 * legacy import and the preview said nothing about it.
 *
 * The honesty requirement is that this cannot drift from the guard: both sides
 * read `fetchRunCoverage`, `computeImportCutoff` and `computeFlagCutoff`, and
 * the response is these four values and nothing derived. The one difference
 * that remains is time — this is the live set, while an import snapshots it at
 * its first batch (see `coveredDaysForRun`) — so a day that goes live in
 * between is reported new here and skipped there. That is the right direction
 * to be wrong in: the preview never promises less skipping than happens.
 */
export interface ImportCoverage {
  /** UTC days that already hold a measured row of any provenance (rule 7). */
  days: string[];
  /** UTC days that already hold an ultrathink flag — a separate set (rule 8). */
  ultrathinkDays: string[];
  /** Measured rows at or after this are refused (rule 6). */
  cutoff: string;
  /** Flags at or after this are refused — not the same instant. */
  flagCutoff: string;
}

export function buildImportCoverage(
  coverage: RunCoverage,
  cutoffMs: number,
  flagCutoffMs: number
): ImportCoverage {
  return {
    days: [...coverage.days].sort(),
    ultrathinkDays: [...coverage.ultrathinkDays].sort(),
    cutoff: new Date(cutoffMs).toISOString(),
    flagCutoff: new Date(flagCutoffMs).toISOString(),
  };
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

/**
 * Admission for the import's ClickHouse work: one batch per user, two in all.
 *
 * Every batch runs the coverage guard's scans and an insert, and pages read
 * through a ClickHouse limiter of four on two vCPUs. A launch is tens to
 * hundreds of `clawdgg setup` runs importing at once; unadmitted, they would
 * hold every permit and the site would wait behind them. Beyond the caps the
 * answer is an immediate 429, never a queue: a queue in memory is unbounded by
 * construction, and the CLI already waits out a Retry-After and tries again.
 * The wait is jittered so that the refused do not all come back together.
 *
 * The coverage preview takes the same slots, since it runs the same scans.
 */
export const IMPORT_SLOTS_PER_USER = 1;
export const IMPORT_SLOTS_GLOBAL = 2;
const IMPORT_RETRY_MIN_S = 2;
const IMPORT_RETRY_MAX_S = 8;

const importSlots = new Map<string, number>();
let importSlotsTotal = 0;

/** Would `withImportSlot` admit this user right now? It takes nothing. */
export function importSlotFree(userId: string): boolean {
  return (
    importSlotsTotal < IMPORT_SLOTS_GLOBAL &&
    (importSlots.get(userId) ?? 0) < IMPORT_SLOTS_PER_USER
  );
}

/**
 * Run `work` holding one of this user's slots and one of the global ones, or
 * return `null` at once when either is full. Released however `work` ends.
 */
export async function withImportSlot<T>(
  userId: string,
  work: () => Promise<T>
): Promise<T | null> {
  if (!importSlotFree(userId)) return null;
  importSlots.set(userId, (importSlots.get(userId) ?? 0) + 1);
  importSlotsTotal++;
  try {
    return await work();
  } finally {
    importSlotsTotal--;
    const held = (importSlots.get(userId) ?? 1) - 1;
    if (held > 0) importSlots.set(userId, held);
    else importSlots.delete(userId);
  }
}

/** Slots held right now, for the tests. */
export function importSlotsInUse(): { total: number; users: number } {
  return { total: importSlotsTotal, users: importSlots.size };
}

/** The refusal: 429, a jittered whole-second Retry-After, the usual body. */
export function importBusy(c: Context): Response {
  const span = IMPORT_RETRY_MAX_S - IMPORT_RETRY_MIN_S + 1;
  const retryAfter = IMPORT_RETRY_MIN_S + Math.floor(Math.random() * span);
  c.header('Retry-After', String(retryAfter));
  return c.json({ error: 'Import busy', retryAfter }, 429);
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/cli/import/coverage — what the import would skip, before it runs
// ═══════════════════════════════════════════════════════════════════════════
//
// Two DISTINCT scans of this user's rows, so it answers to the import's own
// budget as well as the global /api/* limiter. It is also the preview for an
// upload, and a client that asks for it is about to spend that budget anyway.
cli.get('/import/coverage', requireBearerAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  // Before the budget, so a busy server does not spend it.
  if (!importSlotFree(user.id)) return importBusy(c);

  const rate = checkImportRate(user.id);
  if (!rate.ok) {
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json({ error: 'Too many import requests', retryAfter: rate.retryAfterSeconds }, 429);
  }

  const answer = await withImportSlot(user.id, async () => {
    const row = await db
      .select({ otelSetupAt: users.otelSetupAt })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    try {
      // The live set, deliberately NOT coveredDaysForRun: seeding a run's
      // snapshot from a preview the user may never confirm would freeze a
      // coverage set for half an hour on the strength of a question.
      const [cutoffMs, flagCutoffMs, coverage] = await Promise.all([
        computeImportCutoff(user.id, row?.otelSetupAt ?? null),
        computeFlagCutoff(user.id),
        fetchRunCoverage(user.id),
      ]);
      return c.json(buildImportCoverage(coverage, cutoffMs, flagCutoffMs));
    } catch (error) {
      console.error('[cli/import/coverage] failed:', error);
      // The CLI falls back to its old preview on anything but a 200, so this
      // never blocks an import.
      return c.json({ error: 'Coverage unavailable' }, 500);
    }
  });
  return answer ?? importBusy(c);
});

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

    // Checked before the body is read, so a refused upload is never held in
    // memory, and before the budget, so a busy server does not spend it. The
    // slot itself is taken after the read (below): a slow upload must not hold
    // one while ClickHouse sits idle.
    if (!importSlotFree(user.id)) return importBusy(c);

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

    const answer = await withImportSlot(user.id, async () => {
      const row = await db
        .select({ otelSetupAt: users.otelSetupAt })
        .from(users)
        .where(eq(users.id, user.id))
        .get();

      try {
        const [cutoffMs, flagCutoffMs, coverage] = await Promise.all([
          computeImportCutoff(user.id, row?.otelSetupAt ?? null),
          computeFlagCutoff(user.id),
          coveredDaysForRun(user.id, payload.runId),
        ]);

        const result = await runImport(user.id, body, {
          cutoffMs,
          flagCutoffMs,
          coveredDays: coverage.days,
          ultrathinkDays: coverage.ultrathinkDays,
          insertEvents,
          insertMetrics,
        });


        console.log(
          `[cli/import] ${user.githubUsername}: inserted ${result.inserted}, ` +
            `covered-day ${result.skippedCoveredDay}, dup ${result.skippedDuplicate}, ` +
            `after-cutoff ${result.skippedAfterCutoff}, ` +
            `after-flag-cutoff ${result.skippedAfterFlagCutoff}, rejected ${result.rejected}`
        );
        return c.json(result);
      } catch (error) {
        console.error('[cli/import] failed:', error);
        return c.json({ error: 'Import failed' }, 500);
      }
    });
    return answer ?? importBusy(c);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/cli/ultrathink — one prompt contained the word. That is all.
// ═══════════════════════════════════════════════════════════════════════════
//
// Body: { session_id, timestamp, ultrathink: true }. There is no field for the
// prompt, its length, or a hash of it, and the hook that posts this
// (cli/prompt-hook.ts) never puts one in: the match happens on the user's
// machine and only the answer travels.
//
// Idempotent for free. The row's identity is its timestamp + session + event
// name + provenance (eventRowId), so a retry — or a second report of the same
// prompt — hashes identically and ReplacingMergeTree collapses it. Two
// DIFFERENT prompts in the same session in the same millisecond also collapse,
// which is the right trade: nobody types two prompts in a millisecond, and the
// alternative is accepting a client-chosen id that could be varied to inflate
// the count.

const ULTRATHINK_BODY_LIMIT = 2 * 1024;

/**
 * How far from OUR clock a hook report may sit, in either direction.
 *
 * This endpoint is for a hook firing on a prompt that is being typed right now,
 * and nothing else. It used to accept any timestamp back to 2025-02-01, which
 * made it a HISTORY endpoint with no coverage check: a client could post a flag
 * onto every day of the past year, and because the row's identity is its
 * timestamp + session + name, varying the millisecond produced unlimited
 * distinct rows. The import endpoint is where history belongs — it dedupes
 * against the days already covered and answers to its own boundary.
 *
 * Five minutes each way covers a machine with a sloppy clock and a request that
 * sat in a retry, and nothing else. Both a slow clock and a fast one are
 * bounded: a flag dated an hour ago is as wrong as one dated an hour ahead,
 * because the hook posts as it fires.
 */
const ULTRATHINK_CLOCK_SLACK_MS = 5 * 60 * 1000;

/**
 * One prompt a second, sustained, per user. A fast typist sends a few hundred
 * prompts a day and only the ultrathink ones report at all, so this bounds a
 * loop rather than a user.
 */
const ULTRATHINK_RATE_WINDOW_MS = 60 * 1000;
const ULTRATHINK_RATE_MAX = 60;

const ultrathinkRates = new Map<string, { count: number; windowEndsAt: number }>();

export function checkUltrathinkRate(
  userId: string,
  now: number = Date.now()
): { ok: boolean; retryAfterSeconds: number } {
  for (const [key, entry] of ultrathinkRates) {
    if (entry.windowEndsAt <= now) ultrathinkRates.delete(key);
  }

  const entry = ultrathinkRates.get(userId);
  if (!entry || entry.windowEndsAt <= now) {
    ultrathinkRates.set(userId, { count: 1, windowEndsAt: now + ULTRATHINK_RATE_WINDOW_MS });
    return { ok: true, retryAfterSeconds: 0 };
  }

  entry.count++;
  if (entry.count > ULTRATHINK_RATE_MAX) {
    return { ok: false, retryAfterSeconds: Math.ceil((entry.windowEndsAt - now) / 1000) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

/**
 * Validate one report into a row, or explain why not. Exported for the tests.
 *
 * The timestamp is the client's and is held to NOW, within five minutes either
 * way — see ULTRATHINK_CLOCK_SLACK_MS. A flag in the future would park itself
 * in a week that has not happened and move the header figure when it arrives; a
 * flag in the past is history, and history comes in through /import, which
 * checks what is already covered.
 */
export function buildUltrathinkRow(
  userId: string,
  body: unknown,
  now: number = Date.now()
): { row: EventRow } | { error: string } {
  const payload = (body ?? {}) as Record<string, unknown>;
  if (payload.ultrathink !== true) return { error: 'Expected { ultrathink: true }' };

  const raw = payload.timestamp;
  const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) return { error: 'Invalid timestamp' };
  if (Math.abs(ms - now) > ULTRATHINK_CLOCK_SLACK_MS) {
    return {
      error:
        'Timestamp is not now. This endpoint records a prompt as it happens; ' +
        'use `clawdgg import` for history.',
    };
  }

  return {
    row: {
      timestamp: fmtTs(new Date(ms)),
      user_id: userId,
      session_id: safeIdentifier(payload.session_id, 256),
      event_name: ULTRATHINK_EVENT_NAME,
      provenance: 'hook',
    },
  };
}

cli.post(
  '/ultrathink',
  requireBearerAuth,
  bodyLimit({
    maxSize: ULTRATHINK_BODY_LIMIT,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const rate = checkUltrathinkRate(user.id);
    if (!rate.ok) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many reports', retryAfter: rate.retryAfterSeconds }, 429);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const built = buildUltrathinkRow(user.id, body);
    if ('error' in built) return c.json({ error: built.error }, 400);

    try {
      await insertEvents([built.row]);
    } catch (error) {
      console.error('[cli/ultrathink] insert failed:', error);
      return c.json({ error: 'Could not record it' }, 500);
    }

    return c.json({ success: true });
  }
);

export default cli;
