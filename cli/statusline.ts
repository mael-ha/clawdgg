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
import { isOurStatusLineCommand, readStatusLineCommand } from "./settings";
import { markTokenRevoked, mergeState, readState } from "./token-state";
import { parseRateLimits } from "../src/lib/plan-usage";

// Fallback for callers that don't pass an absolute binary path (and the shape
// `isOurStatusLine` recognises in a settings.json written by an older CLI).
export const STATUSLINE_COMMAND = "clawdgg statusline";

const DEBUG_LOG_FILE = join(CONFIG_DIR, "statusline-debug.log");

// The prompt render waits on this process, so the network gets a hard ceiling.
const POST_TIMEOUT_MS = 1500;
/**
 * How long a wrapped status line gets.
 *
 * Claude Code waits for the whole statusLine command, so this is time the user
 * spends looking at a half-drawn prompt — and it is time THEY chose, by
 * configuring that script, except that we are now the thing being blamed for
 * it. 3s is well inside what Claude Code tolerates before it gives up on a
 * status line, and a status line that needs longer than three seconds is
 * broken whoever runs it.
 */
const WRAPPED_TIMEOUT_MS = 3000;

/** How long we keep draining their pipes after the process is gone. */
const DRAIN_GRACE_MS = 150;

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

export type StatusLineWrapAction = "wrapped" | "already-ours" | "absent" | "unwrappable";

export interface StatusLineWrapResult {
  action: StatusLineWrapAction;
  /** The `statusLine` value as it was, to be stored and restored verbatim. */
  original?: unknown;
  /** Just the command string out of it, for the notice. */
  originalCommand?: string;
}

/**
 * Run someone else's status line THROUGH ours, in place.
 *
 * The alternative, and what this used to be, is to leave a foreign status line
 * alone — correct about ownership and a dead end in practice: `rate_limits`
 * reaches no other hook, so anyone who already had a status line never
 * reported a plan-usage percentage, and nothing on the page said why.
 *
 * Only the `command` is replaced. Every other key of the object — `padding`,
 * `type`, anything Claude Code adds later — is carried over untouched, and the
 * whole original value is handed back for `disable` to put back byte for byte.
 */
export function wrapStatusLineSetting(
  settings: Record<string, any>,
  buildWrapper: (original: string) => string
): StatusLineWrapResult {
  const existing = statusLineCommandOf(settings);
  if (existing === null) return { action: "absent" };
  // Ours already, wrapper or not. Never wrap ourselves: that is a status line
  // that runs a status line that runs a status line.
  if (isOurStatusLine(existing)) return { action: "already-ours" };

  const original = settings.statusLine;
  settings.statusLine =
    typeof original === "object" && original !== null
      ? { ...original, command: buildWrapper(existing) }
      : { type: "command", command: buildWrapper(existing) };

  return { action: "wrapped", original, originalCommand: existing };
}

export type StatusLineRemovalAction = "removed" | "restored" | "not-ours" | "absent";

/**
 * Drop our statusLine again, leaving anyone else's alone.
 *
 * `original` is what `setup` recorded before wrapping, and it goes back exactly
 * as it was — a string stays a string, an object keeps its `padding` and its
 * key order. Without it (an older config, or a `disable` on another machine)
 * the wrapper still carries the command it wraps, so the command is recovered
 * from our own argv and the rest of the object is already untouched.
 */
export function removeStatusLineSetting(
  settings: Record<string, any>,
  original?: unknown
): StatusLineRemovalAction {
  const existing = statusLineCommandOf(settings);
  if (existing === null) return "absent";

  const shape = readStatusLineCommand(existing);
  if (!shape.ours) return "not-ours";

  if (shape.wrapped !== undefined) {
    if (original !== undefined) {
      settings.statusLine = original;
    } else {
      const current = settings.statusLine;
      settings.statusLine =
        typeof current === "object" && current !== null
          ? { ...current, command: shape.wrapped }
          : shape.wrapped;
    }
    return "restored";
  }

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

/** The throttle check, the handoff and the throttle write. Never throws. */
async function reportPlanUsage(input: StatusLineInput): Promise<void> {
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
 * Read a stream as it arrives, keeping every chunk.
 *
 * `bytes()` is whatever has been read so far, callable at any point —
 * including after the process it came from was killed.
 */
function collect(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>;
  bytes: () => Uint8Array;
} {
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        if (value) chunks.push(value);
      }
    } catch {
      // A stream torn down under us has given us all it is going to.
    }
  })();

  return {
    done,
    bytes: () => {
      const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
      const all = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
      }
      return all;
    },
  };
}

export interface WrappedStatusLine {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Run the user's own status line and collect its bytes.
 *
 * Through a shell, because that is how Claude Code runs a `statusLine` and the
 * string was written to be read that way — pipes, `&&`, a `$(…)` in it all
 * have to keep working. Same stdin (the JSON blob, byte for byte), same cwd,
 * same environment: this process is standing in for Claude Code, and anything
 * it changes about the context is a difference the user would have to debug.
 *
 * Nothing here throws. A command that is missing, that fails, or that hangs
 * still returns what it managed to print, and the caller prints exactly that
 * — never our own text in its place. A status line that goes blank when a
 * script breaks is the user's own bug, visible and theirs; a status line that
 * silently turns into ours is us lying about what they configured.
 */
export async function runWrappedStatusLine(
  command: string,
  stdin: string,
  timeoutMs: number = WRAPPED_TIMEOUT_MS
): Promise<WrappedStatusLine> {
  const empty = { stdout: new Uint8Array(), stderr: new Uint8Array() };
  try {
    const child = Bun.spawn(["/bin/sh", "-c", command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Drained chunk by chunk, starting before the write: a command that prints
    // more than a pipe buffer holds cannot deadlock against us, and — the
    // reason for a reader rather than `new Response(stream).bytes()` — what it
    // printed before a kill is still in hand afterwards. Tearing the stream
    // down loses a buffered response; it cannot lose chunks already read.
    const out = collect(child.stdout);
    const err = collect(child.stderr);

    try {
      child.stdin.write(stdin);
      child.stdin.end();
    } catch {
      // A command that closed stdin without reading it (`date`) is normal.
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const exitCode = await child.exited;
    clearTimeout(timer);

    // A grace window, not a wait: after a clean exit both streams end at once,
    // but a killed `sh` can leave a grandchild holding the write end open, and
    // that must not become our hang. Whatever has been read by then is what
    // gets printed — a partial line beats a blank one.
    await Promise.race([
      Promise.all([out.done, err.done]),
      new Promise((resolve) => setTimeout(resolve, DRAIN_GRACE_MS)),
    ]);
    return { stdout: out.bytes(), stderr: err.bytes(), exitCode, timedOut };
  } catch (error) {
    return {
      ...empty,
      stderr: new TextEncoder().encode(`clawdgg: could not run your status line (${error})\n`),
      exitCode: 127,
      timedOut: false,
    };
  }
}

export async function cmdStatusline(wrapped?: string): Promise<void> {
  const raw = await readStdinSafely();
  await appendDebugCapture(raw);

  let input: StatusLineInput = {};
  try {
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    // Unparseable stdin still gets a status line.
  }

  // A wrapper around ourselves would recurse until the machine gave up. Setup
  // never writes one; a hand-edited settings.json could. Fall back to our own
  // line, which is the one thing here that cannot recurse.
  if (wrapped !== undefined && !isOurStatusLineCommand(wrapped)) {
    // The report goes FIRST when wrapping: it is a file read and a spawn, a
    // couple of milliseconds, and doing it here means a user status line that
    // hangs for its whole timeout does not also cost us the plan-usage
    // snapshot. Then the prompt gets their output and nothing else.
    await reportPlanUsage(input);

    const result = await runWrappedStatusLine(wrapped, raw);
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    // Their exit code is the exit code. process.exitCode rather than
    // process.exit(), which can cut a write short.
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  // Print first, always: the prompt gets its line whatever happens below.
  process.stdout.write(`${formatStatusLine(input)}\n`);
  await reportPlanUsage(input);
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
