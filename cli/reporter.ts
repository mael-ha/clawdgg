// The one way a hook hands work to a detached copy of ourselves.
//
// Both hooks on the prompt's critical path (`statusline`, `prompt-hook`) do the
// same thing: decide there is something to report, hand it off, and exit
// without waiting for the network. The handoff is what lives here, because
// getting it wrong is invisible — a report that never arrives looks exactly
// like a report that was never due.
//
// THE PAYLOAD GOES ON THE ARGV, NEVER DOWN A STDIN PIPE. Measured on Bun 1.3.4
// (darwin-arm64/x64, compiled binary and `bun cli/index.ts` alike), with the
// child replaced by a script that records what it receives:
//
//   parent                                    child received
//   ----------------------------------------  --------------------
//   `statusline`   (fs reads/writes + stdout   the full payload, 3/3
//                   before the spawn)
//   `prompt-hook`  (parse, spawn, exit)        ZERO bytes, 3/3
//
// Same spawn shape, same machine, same binary. Bun pushes a `stdin` buffer into
// the pipe from the event loop, so whether it lands depends on how much work
// the parent still has pending when it exits — `statusline` wins that race
// today only because of the fs work and the status line it prints first, which
// is an accident of what it happens to do, not a guarantee. One output change
// and plan usage stops arriving with nothing to show it. An argv is part of
// execve: there is no flush to lose.
//
// Which means: NOTHING SECRET MAY EVER BE PASSED THROUGH HERE. `ps` shows an
// argv to every user on the machine. The reports are deliberately shaped for
// it — a window percentage, a session id, a boolean — and the child reads the
// bearer token itself, out of the 0600 config, where it already lives.

import { selfArgv } from "./paths";

/**
 * Ceiling on an argv payload.
 *
 * Headroom, not a real limit: the biggest report anybody sends is a rate_limits
 * blob with three windows in it, around 200 bytes. The cap exists so a payload
 * that is somehow enormous degrades to the in-process send instead of dying in
 * execve — Linux caps a single argument at 128 KiB (MAX_ARG_STRLEN) and macOS
 * caps the whole argv at 1 MiB, and `Bun.spawn` reports neither nicely.
 */
export const MAX_REPORT_BYTES = 32 * 1024;

/**
 * Hand `payload` to `clawdgg <subcommand>` in a detached child and return
 * immediately.
 *
 * Returns false when the handoff did not happen — the payload is too big, it
 * will not serialise, or the platform refused the spawn (a sandbox, a
 * container with no fork). A false answer is the caller's cue to send the
 * report in-process instead of dropping it.
 */
export function spawnDetachedReporter(subcommand: string, payload: unknown): boolean {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (!json || Buffer.byteLength(json, "utf8") > MAX_REPORT_BYTES) return false;

  try {
    const child = Bun.spawn([...selfArgv(), subcommand, json], {
      // Nothing is read from it, and an inherited stdin would be the hook's own
      // pipe from Claude Code.
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    // Let this process exit while the child keeps going.
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The argv payload, parsed back. Returns null for anything unusable. */
export function parseReportArgv<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
