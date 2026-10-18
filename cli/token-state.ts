// ~/.config/clawdgg/statusline-state.json — the small mutable state two hooks
// share, and the one channel that turns a server-side revocation into a LOUD
// local failure.
//
// How that works: the statusLine hook and `doctor` both talk to the API. When
// either gets a 401 they record a fingerprint of the token that was refused
// here. `otel-headers` reads it, and if the token it is about to print is that
// one it exits non-zero instead — so Claude Code shows
// "otelHeadersHelper failed; telemetry is not being exported" at the next
// start. Without it, a revoked token means the exporter 401s forever and the
// user sees nothing (the May 2026 token cliff).
//
// A fingerprint, not the token: this file is state, not a credential store.
//
// Every function takes its path explicitly so the tests run against a fixture
// directory instead of the real ~/.config/clawdgg.

import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./paths";

export const STATE_FILE = join(CONFIG_DIR, "statusline-state.json");

export interface CliState {
  /** statusLine POST throttle (epoch seconds). */
  lastPostAt?: number;
  /** The rate_limits snapshot the last POST carried. */
  fingerprint?: string;
  /** tokenFingerprint() of a token the server answered 401 for. */
  revokedTokenFingerprint?: string;
  /** When we saw that 401. */
  revokedAt?: string;
}

/** Stable, non-reversible id for a token. 16 hex chars is plenty here. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

export async function readState(path: string = STATE_FILE): Promise<CliState> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge a patch into the state file. Merge rather than replace: the throttle
 * and the revocation flag are written by different processes, and whichever
 * wrote last must not drop the other's field.
 */
export async function mergeState(
  patch: Partial<CliState>,
  path: string = STATE_FILE
): Promise<void> {
  try {
    const next = { ...(await readState(path)), ...patch };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete (next as Record<string, unknown>)[key];
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(next), { mode: 0o600 });
    await chmod(path, 0o600);
  } catch {
    // Losing this state costs an extra request, or one missed warning. It is
    // never worth breaking a prompt render or a doctor run over.
  }
}

/** Record that the server refused this token. */
export async function markTokenRevoked(
  token: string,
  path: string = STATE_FILE
): Promise<void> {
  await mergeState(
    { revokedTokenFingerprint: tokenFingerprint(token), revokedAt: new Date().toISOString() },
    path
  );
}

/** Clear the flag — on a successful call, or after a fresh login. */
export async function clearTokenRevoked(path: string = STATE_FILE): Promise<void> {
  const state = await readState(path);
  if (state.revokedTokenFingerprint === undefined && state.revokedAt === undefined) return;
  await mergeState({ revokedTokenFingerprint: undefined, revokedAt: undefined }, path);
}

/**
 * Is THIS token the one that was refused? Comparing fingerprints means a new
 * login clears the alarm by itself: a different token simply doesn't match.
 */
export async function isTokenRevoked(
  token: string,
  path: string = STATE_FILE
): Promise<boolean> {
  const state = await readState(path);
  return (
    typeof state.revokedTokenFingerprint === "string" &&
    state.revokedTokenFingerprint === tokenFingerprint(token)
  );
}
