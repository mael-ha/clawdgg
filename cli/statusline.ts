// `clawdgg statusline` — the statusLine hook Claude Code runs on session events.
//
// Claude Code pipes a JSON blob on stdin and renders whatever we print on
// stdout. For Pro/Max subscribers that blob carries `rate_limits` (the
// five_hour / seven_day / spend_limit windows) once the session has had its
// first API response — the only channel that exposes them, so we forward them
// to clawd.gg from here.
//
// Two hard rules on this path:
//   1. Nothing but the status line goes to stdout. That's why this file does
//      not reuse index.ts's loadConfig(), which migrates legacy config dirs and
//      prints notices — those would land inside the user's prompt.
//   2. Nothing blocks the prompt. The report is handed to a DETACHED child
//      process and this one exits immediately — Claude Code waits for us, so
//      even a 1.5s timeout is 1.5s of the user staring at a half-drawn prompt.

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { API_BASE_URL, CONFIG_DIR, CONFIG_FILE, tokenIsForThisOrigin } from "./paths";
import { parseReportArgv, spawnDetachedReporter } from "./reporter";
import { isOurStatusLineCommand } from "./settings";
import { markTokenRevoked, mergeState, readState } from "./token-state";
import { parseRateLimits } from "../src/lib/plan-usage";

// Fallback for callers that don't pass an absolute binary path (and the shape
// `isOurStatusLine` recognises in a settings.json written by an older CLI).
export const STATUSLINE_COMMAND = "clawdgg statusline";

const DEBUG_LOG_FILE = join(CONFIG_DIR, "statusline-debug.log");

// The prompt render waits on this process, so the network gets a hard ceiling.
const POST_TIMEOUT_MS = 1500;
// Client-side twin of the server's dedup: don't re-send an identical snapshot
// more than once per this interval. The server is still authoritative — this
// only keeps us from spending a request (and an /api/* rate-limit slot) on
// every single prompt re-render.
const POST_THROTTLE_SECONDS = 5 * 60;

interface StatusLineInput {
  model?: { display_name?: string; id?: string };
  session_id?: string;
  rate_limits?: unknown;
}

// ============= SETTINGS.JSON MERGE =============

export type StatusLineMergeAction = "added" | "already-ours" | "conflict";

export interface StatusLineMergeResult {
  action: StatusLineMergeAction;
  /** The foreign command we refused to replace, for the "add it yourself" notice. */
  existing?: string;
}

function statusLineCommandOf(settings: Record<string, any>): string | null {
  const configured = settings?.statusLine;
  if (typeof configured === "string") return configured;
  if (configured && typeof configured === "object" && typeof configured.command === "string") {
    return configured.command;
  }
  return null;
}

/**
 * Ours iff the command's LAST argv word is the `statusline` subcommand and an
 * earlier word names us. `npx clawdgg statusline`, a quoted absolute path to
 * the binary and `bun ~/src/clawdgg/cli/index.ts statusline` all qualify.
 *
 * The old substring test (`includes("clawdgg") && includes("statusline")`) also
 * claimed things like `~/bin/prompt.sh --theme clawdgg --no-statusline`, and
 * claiming someone else's status line means deleting it on `disable`.
 */
function isOurStatusLine(command: string): boolean {
  return isOurStatusLineCommand(command);
}

/**
 * Register our statusLine in a parsed settings object, in place.
 * Never overwrites a statusLine that isn't ours, and re-running is a no-op
 * (including when the user invokes us through their own wrapper).
 */
export function applyStatusLineSetting(
  settings: Record<string, any>,
  command: string = STATUSLINE_COMMAND
): StatusLineMergeResult {
  const existing = statusLineCommandOf(settings);

  if (existing !== null) {
    if (isOurStatusLine(existing)) return { action: "already-ours" };
    return { action: "conflict", existing };
  }

  settings.statusLine = { type: "command", command };
  return { action: "added" };
}

export type StatusLineRemovalAction = "removed" | "not-ours" | "absent";

/** Drop our statusLine again, leaving anyone else's alone. */
export function removeStatusLineSetting(settings: Record<string, any>): StatusLineRemovalAction {
  const existing = statusLineCommandOf(settings);
  if (existing === null) return "absent";
  if (!isOurStatusLine(existing)) return "not-ours";
  delete settings.statusLine;
  return "removed";
}

// ============= STATUS LINE =============

/**
 * PLACEHOLDER format — deliberately minimal until the real design lands.
 */
export function formatStatusLine(input: StatusLineInput): string {
  const parts: string[] = [];

  const model = input?.model?.display_name || input?.model?.id;
  if (model) parts.push(String(model));

  const sevenDay = parseRateLimits(input?.rate_limits).windows.find(
    (w) => w.windowType === "seven_day"
  );
  if (sevenDay) parts.push(`7d ${Math.round(sevenDay.usedPercentage)}%`);

  return parts.join(" · ") || "clawd.gg";
}

// ============= REPORTING =============

async function readStdinSafely(): Promise<string> {
  try {
    if (process.stdin.isTTY) return "";
    return await Bun.stdin.text();
  } catch {
    return "";
  }
}

// CLAWDGG_STATUSLINE_DEBUG=1 captures what Claude Code actually sends us. The
// shape is documented but unconfirmed, so this is how we verify it in the wild.
// Written as JSONL (compacted, or wrapped when it isn't even JSON).
async function appendDebugCapture(raw: string): Promise<void> {
  if (process.env.CLAWDGG_STATUSLINE_DEBUG !== "1" || !raw.trim()) return;
  try {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    let line: string;
    try {
      line = JSON.stringify(JSON.parse(raw));
    } catch {
      line = JSON.stringify({ unparseable: raw });
    }
    await appendFile(DEBUG_LOG_FILE, `${line}\n`, { mode: 0o600 });
  } catch {
    // A debug capture is never worth breaking the prompt over.
  }
}

// Deliberately NOT index.ts's loadConfig — see the header note about stdout.
// The origin check is the same one, though: a token is a credential for the
// server that issued it, and this path POSTs to API_BASE_URL.
async function readTokenQuietly(): Promise<string | null> {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
    if (!tokenIsForThisOrigin(parsed?.apiOrigin)) return null;
    if (typeof parsed?.token === "string" && parsed.token) return parsed.token;
  } catch {
    // Unreadable config: no token, no report. Never a thrown prompt.
  }
  return null;
}

/**
 * What travels to the child, and what the server is sent — the plan-usage
 * windows and nothing else.
 *
 * Deliberately NOT the raw stdin blob, which also carries `cwd` and
 * `transcript_path`: this payload goes on an argv that `ps` shows to everyone
 * on the machine, so it holds only what the server is getting anyway.
 * `capturedAt` is stamped here, in the parent, because that is when the
 * snapshot was true.
 */
export interface PlanUsageReport {
  rate_limits: unknown;
  sessionId?: string;
  capturedAt: number;
}

export function buildPlanUsageReport(input: StatusLineInput, now: Date = new Date()): PlanUsageReport {
  return {
    rate_limits: input?.rate_limits,
    sessionId: typeof input?.session_id === "string" ? input.session_id : undefined,
    capturedAt: Math.floor(now.getTime() / 1000),
  };
}

/** The POST itself. Only ever runs in the detached child (or as its fallback). */
async function postPlanUsage(report: PlanUsageReport, token: string): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/plan-usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });

    // This is the earliest place a revocation shows up — the status line talks
    // to the API far more often than `doctor` does. Record it so `otel-headers`
    // fails loudly at the next Claude Code start instead of the exporter 401ing
    // in silence.
    if (response.status === 401) await markTokenRevoked(token);
  } catch {
    // Network down, server 500 — none of it is the user's problem while they
    // are waiting for a prompt.
  }
}

/**
 * Worth sending? Decided in the parent, because the throttle is what keeps us
 * from spawning a process per prompt re-render.
 *
 * Returns the token and the fingerprint to record, or null when nothing is
 * due. It does NOT write the throttle: see recordPostAttempt.
 */
async function planUsageIsDue(
  input: StatusLineInput
): Promise<{ token: string; fingerprint: string } | null> {
  try {
    const rateLimits = input?.rate_limits;
    if (!rateLimits || typeof rateLimits !== "object") return null;
    if (parseRateLimits(rateLimits).windows.length === 0) return null;

    const token = await readTokenQuietly();
    if (!token) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const fingerprint = JSON.stringify(rateLimits);
    const state = await readState();
    if (
      state.fingerprint === fingerprint &&
      typeof state.lastPostAt === "number" &&
      nowSeconds - state.lastPostAt < POST_THROTTLE_SECONDS
    ) {
      return null;
    }

    return { token, fingerprint };
  } catch {
    return null;
  }
}

/**
 * Close the throttle window — AFTER the report has been handed off or sent.
 *
 * It used to be written before, which meant a handoff that silently failed
 * also silenced itself for the next five minutes: nothing arrived, and nothing
 * tried again. It still records on a failed POST, which is the property that
 * kept it there — a server that is down must not be hammered on every prompt.
 */
async function recordPostAttempt(fingerprint: string): Promise<void> {
  try {
    await mergeState({ lastPostAt: Math.floor(Date.now() / 1000), fingerprint });
  } catch {
    // A throttle we could not write is a report sent slightly too often.
  }
}

export async function cmdStatusline(): Promise<void> {
  const raw = await readStdinSafely();
  await appendDebugCapture(raw);

  let input: StatusLineInput = {};
  try {
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    // Unparseable stdin still gets a status line.
  }

  // Print first, always: the prompt gets its line whatever happens below.
  process.stdout.write(`${formatStatusLine(input)}\n`);

  const due = await planUsageIsDue(input);
  if (!due) return;

  // Claude Code waits for this process to exit before it draws the prompt, so
  // the POST goes to a detached child — see cli/reporter.ts for why the payload
  // travels on its argv and not down a pipe.
  const report = buildPlanUsageReport(input);
  if (!spawnDetachedReporter("statusline-report", report)) {
    // A platform or a sandbox that refuses to spawn: send it here rather than
    // drop plan usage altogether, bounded by POST_TIMEOUT_MS.
    await postPlanUsage(report, due.token);
  }
  await recordPostAttempt(due.fingerprint);
}

/**
 * `clawdgg statusline-report` — the detached half of the above. Not in the
 * help: Claude Code never calls it, we do.
 *
 * Takes the report as its one argument. It used to read stdin, which is how a
 * report arrives empty; cli/reporter.ts has the measurement.
 */
export async function cmdStatuslineReport(raw: string | undefined): Promise<void> {
  const report = parseReportArgv<PlanUsageReport>(raw);
  // No windows means nothing to record — and it is the shape an empty payload
  // would take, so refusing it is also the guard against a lost handoff
  // turning into a row of nulls on the server.
  if (!report || parseRateLimits(report.rate_limits).windows.length === 0) return;

  const token = await readTokenQuietly();
  if (!token) return;
  await postPlanUsage(report, token);
}
