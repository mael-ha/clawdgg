// `clawdgg otel-headers` — the `otelHeadersHelper` Claude Code runs to get the
// Authorization header for its OTLP exporter.
//
// Contract (code.claude.com/docs/en/monitoring-usage, "Dynamic headers"):
//   - print a flat JSON object of string→string header pairs on stdout
//   - Claude Code runs it at startup and every 29 minutes thereafter
//     (CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS), so it must be fast and
//     must not depend on the network
//   - on failure, exports stop and Claude Code shows
//     "otelHeadersHelper failed; telemetry is not being exported" once per
//     session, plus a line in /status
//
// That last point is the reason this command exists. The previous design baked
// a bearer token into OTEL_EXPORTER_OTLP_HEADERS; when the token was revoked
// the exporter 401'd forever in silence (the May 2026 token cliff). A helper
// that exits non-zero turns the same failure into a visible startup warning.
//
// Nothing but the JSON goes to stdout — diagnostics go to stderr.

/**
 * A per-device token: `cgt_<32 hex>.<64 hex>`. The prefix before the dot is
 * device_tokens.id, which is also how `clawdgg devices` marks "this machine".
 */
const DEVICE_TOKEN_RE = /^cgt_([0-9a-f]{32})\.[0-9a-f]{64}$/;

export function isDeviceToken(token: unknown): token is string {
  return typeof token === "string" && DEVICE_TOKEN_RE.test(token);
}

/** The device id inside a per-device token, or null. */
export function deviceTokenId(token: unknown): string | null {
  if (typeof token !== "string") return null;
  return DEVICE_TOKEN_RE.exec(token)?.[1] ?? null;
}

/**
 * The pre-2.0 format: an HMAC-signed payload, `<json>.<hex>`. Still issued to
 * nobody, still accepted by the server, and `doctor` tells whoever holds one to
 * re-login so they get an individually revocable token instead.
 */
export function isLegacySignedToken(token: unknown): token is string {
  if (typeof token !== "string") return false;
  // A device token also happens to end in 64 hex chars; the prefix is what
  // tells them apart, and `doctor` keys its "re-login to upgrade" on that.
  if (token.startsWith("cgt_")) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const signature = token.slice(dot + 1);
  return signature.length >= 32 && /^[0-9a-f]+$/.test(signature);
}

/**
 * Structural check only: a truncated or placeholder value is caught here
 * without a round-trip. Server-side validity is `clawdgg doctor`'s job.
 */
export function isWellFormedToken(token: unknown): token is string {
  return isDeviceToken(token) || isLegacySignedToken(token);
}

/** The one line this command prints on success, newline included. */
export function otelHeadersLine(token: string): string {
  return `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`;
}

/**
 * True for an `OTEL_EXPORTER_OTLP_*HEADERS` value that WE wrote — the static
 * bearer the pre-2.0 CLI baked into settings.json.
 *
 * This is the test that decides whether `disable` may delete a header key. A
 * header we don't recognise belongs to someone else's collector and is left
 * alone: deleting it would break their exporter, and "restoring" it later would
 * aim our Authorization at a third party.
 */
export function isOurStaticAuthHeader(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;

  // The list is `k=v,k=v`, but a legacy token's JSON payload contains commas
  // of its own — so the value is NOT split on them. Instead the candidate is
  // everything after `Authorization=Bearer ` with any trailing `,k=v` pairs
  // peeled off from the right until something is a well-formed token.
  const forms = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) forms.push(decoded);
  } catch {
    // Not valid percent-encoding; the raw form is all we have.
  }

  for (const form of forms) {
    const match = /authorization\s*=\s*bearer(?:\s|%20)+/i.exec(form);
    if (!match) continue;
    const candidates: string[] = [];
    let candidate = form.slice(match.index + match[0].length).trim();
    while (candidate) {
      candidates.push(candidate);
      const comma = candidate.lastIndexOf(",");
      if (comma < 0) break;
      candidate = candidate.slice(0, comma).trim();
    }
    if (candidates.some((c) => isWellFormedToken(c))) return true;
  }
  return false;
}

export const MISSING_TOKEN_MESSAGE =
  "clawdgg: no valid clawd.gg token found — run `clawdgg login` to restore telemetry";

/**
 * What `otel-headers` prints to stderr when the server has told us this token
 * is dead. Exiting non-zero is the point: Claude Code then shows
 * "otelHeadersHelper failed; telemetry is not being exported" instead of
 * dropping every batch in silence, which is exactly how the May 2026 token
 * cliff went unnoticed for months.
 */
export const REVOKED_TOKEN_MESSAGE =
  "clawdgg: this device's clawd.gg token was revoked — run `clawdgg login` to restore telemetry";
