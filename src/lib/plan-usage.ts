/**
 * Plan usage (Pro/Max rate-limit windows) captured from Claude Code's statusLine hook.
 *
 * Claude Code runs the configured statusLine command on session events and feeds
 * it a JSON blob on stdin. For subscribers, that blob carries a `rate_limits`
 * object once the session has had its first API response:
 *
 *   "rate_limits": {
 *     "five_hour":   { "used_percentage": 42.5, "resets_at": 1790000000 },
 *     "seven_day":   { ... },
 *     "spend_limit": { ... }
 *   }
 *
 * There is no REST or OTel source for this — statusLine is the only channel —
 * and the shape is documented but not contractual. Every window may be
 * independently absent, and the whole object is absent before the first API
 * response and for non-subscribers. So: parse defensively, reject rather than
 * coerce anything out of range, and never throw.
 */

export const PLAN_USAGE_WINDOWS = ['five_hour', 'seven_day', 'spend_limit'] as const;
export type PlanUsageWindow = (typeof PLAN_USAGE_WINDOWS)[number];

export interface ParsedPlanUsageWindow {
  windowType: PlanUsageWindow;
  usedPercentage: number;  // 0-100
  resetsAt: number | null; // unix epoch seconds, null when absent/implausible
}

export interface ParsedPlanUsage {
  windows: ParsedPlanUsageWindow[];
  /** Known windows that were present but unusable (bad percentage). Surfaced so
   *  shape drift shows up in the API response instead of vanishing silently. */
  rejected: PlanUsageWindow[];
}

// Plausible unix epoch SECONDS: 2001-09 .. 2096-10. Anything outside is either
// milliseconds (normalized below) or garbage.
const MIN_EPOCH_SECONDS = 1_000_000_000;
const MAX_EPOCH_SECONDS = 4_000_000_000;

/**
 * Accept epoch seconds, transparently downgrade epoch milliseconds. The two
 * magnitudes are unambiguous, so this is reversible rather than a guess — it
 * protects us if Claude Code ever switches units. Everything else is null.
 */
export function normalizeEpochSeconds(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;

  if (num >= MIN_EPOCH_SECONDS && num <= MAX_EPOCH_SECONDS) return Math.floor(num);
  if (num >= MIN_EPOCH_SECONDS * 1000 && num <= MAX_EPOCH_SECONDS * 1000) {
    return Math.floor(num / 1000);
  }
  return null;
}

function parsePercentage(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  // Reject rather than clamp: a fabricated 100% is worse than a missing row.
  if (num < 0 || num > 100) return null;
  return num;
}

/**
 * Pull the usable windows out of a raw `rate_limits` object. Missing, partial
 * and malformed payloads all resolve to an empty (or partial) result.
 */
export function parseRateLimits(raw: unknown): ParsedPlanUsage {
  const result: ParsedPlanUsage = { windows: [], rejected: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;

  const source = raw as Record<string, unknown>;

  for (const windowType of PLAN_USAGE_WINDOWS) {
    const entry = source[windowType];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const usedPercentage = parsePercentage((entry as Record<string, unknown>).used_percentage);
    if (usedPercentage === null) {
      result.rejected.push(windowType);
      continue;
    }

    result.windows.push({
      windowType,
      usedPercentage,
      resetsAt: normalizeEpochSeconds((entry as Record<string, unknown>).resets_at),
    });
  }

  return result;
}

export interface StoredPlanUsageSnapshot {
  usedPercentage: number;
  resetsAt: number | null;
  capturedAt: number;
}

/**
 * Heartbeat floor: re-record an unchanged window at most this often.
 * statusLine fires many times per minute, so change-detection does the real
 * work; the heartbeat only exists so a flat stretch is distinguishable from
 * "the CLI stopped reporting" when we later chart this.
 */
export const PLAN_USAGE_HEARTBEAT_SECONDS = 5 * 60;

/**
 * Dedup rule: insert when the window moved (percentage or reset boundary), or
 * when the last row for it is older than the heartbeat floor. Everything else
 * is a no-op, which is the common case — Claude Code re-renders the status line
 * on every prompt, tool result and token update.
 */
export function shouldInsertSnapshot(
  latest: StoredPlanUsageSnapshot | null | undefined,
  incoming: ParsedPlanUsageWindow,
  capturedAt: number,
  heartbeatSeconds: number = PLAN_USAGE_HEARTBEAT_SECONDS
): boolean {
  if (!latest) return true;
  if (latest.usedPercentage !== incoming.usedPercentage) return true;
  if (latest.resetsAt !== incoming.resetsAt) return true;
  return capturedAt - latest.capturedAt >= heartbeatSeconds;
}
