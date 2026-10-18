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
 * Structural check only: the bearer token is an HMAC-signed payload
 * (`<json>.<hex>`), so a truncated or placeholder value is caught here without
 * a round-trip. Server-side validity is `clawdgg doctor`'s job.
 */
export function isWellFormedToken(token: unknown): token is string {
  if (typeof token !== "string") return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const signature = token.slice(dot + 1);
  return signature.length >= 32 && /^[0-9a-f]+$/.test(signature);
}

/** The one line this command prints on success, newline included. */
export function otelHeadersLine(token: string): string {
  return `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`;
}

export const MISSING_TOKEN_MESSAGE =
  "clawdgg: no valid clawd.gg token found — run `clawdgg login` to restore telemetry";
