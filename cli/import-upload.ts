// One import batch, POSTed until the server takes it.
//
// The server admits one import batch per user and two in all, and turns the
// rest away at once with a 429 and a jittered Retry-After of 2–8 s (see
// withImportSlot in src/routes/cli.ts). On a launch day most of a `clawdgg
// setup` can be that answer, so a 429 is waited out, not counted: the batch
// keeps asking, at the pace the server names, for up to IMPORT_WAIT_BUDGET_MS.
//
// A network error or a 5xx is different — it says something is wrong, not
// busy — so it gets a few quick retries with backoff and then a clear failure.
//
// Retrying a batch is safe. Every insert carries a deduplication token derived
// from its rows, so a batch the server took but whose answer was lost lands
// once. And a whole import is safe to run again: the server skips every day it
// already holds, so a re-run picks up instead of counting anything twice.

/** How long one batch may spend waiting for a slot, all waits together. */
export const IMPORT_WAIT_BUDGET_MS = 10 * 60 * 1000;

/** The longest single wait, whatever Retry-After says. */
const MAX_RETRY_AFTER_S = 30;

/** When a 429 carries no usable Retry-After. */
const DEFAULT_RETRY_AFTER_S = 5;

/** Added to every slot wait, so clients the server spread out stay spread out. */
const SLOT_JITTER_MS = 1_000;

/** Waits before each retry of a network error or 5xx; one retry per entry. */
const FAILURE_BACKOFF_S = [1, 2, 4, 8];

const RESUME_HINT =
  "Nothing is lost: re-run `clawdgg setup` (or `clawdgg import`) to resume — days already uploaded are skipped, never counted twice.";

/** Thrown when the user interrupts the upload. */
export class ImportAbortedError extends Error {
  constructor() {
    super("Import interrupted.");
    this.name = "ImportAbortedError";
  }
}

export interface UploadDeps {
  /** One attempt. `signal` aborts it. */
  post: (signal?: AbortSignal) => Promise<Response>;
  /** Where waits are reported. */
  note?: (text: string) => void;
  /** Ctrl-C. Aborts the attempt in flight and any wait. */
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ImportAbortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ImportAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Seconds to wait from a 429's Retry-After: whole seconds, clamped to 1–30. */
export function retryAfterSeconds(header: string | null): number {
  const seconds = Number(header);
  if (header === null || header.trim() === "" || !Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_RETRY_AFTER_S;
  }
  return Math.min(Math.max(Math.ceil(seconds), 1), MAX_RETRY_AFTER_S);
}

export async function postImportWithRetry<T>(deps: UploadDeps): Promise<T> {
  const note = deps.note ?? (() => {});
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const { signal } = deps;

  const startedAt = now();
  let failures = 0;

  for (;;) {
    if (signal?.aborted) throw new ImportAbortedError();

    let response: Response | null = null;
    let failure = "";
    try {
      response = await deps.post(signal);
    } catch (error) {
      if (signal?.aborted) throw new ImportAbortedError();
      failure = error instanceof Error ? error.message : String(error);
    }

    if (response) {
      if (response.ok) return (await response.json()) as T;

      if (response.status === 429) {
        failures = 0;
        const seconds = retryAfterSeconds(response.headers.get("Retry-After"));
        const ms = seconds * 1000 + Math.floor(random() * SLOT_JITTER_MS);
        if (now() - startedAt + ms > IMPORT_WAIT_BUDGET_MS) {
          throw new Error(
            `clawd.gg was too busy to take the upload for ${Math.round(IMPORT_WAIT_BUDGET_MS / 60_000)} minutes. ${RESUME_HINT}`
          );
        }
        note(`  waiting for a slot (${seconds}s)`);
        await wait(ms, signal);
        continue;
      }

      if (response.status < 500) {
        throw new Error(`Import rejected (HTTP ${response.status}): ${await response.text()}`);
      }
      failure = `HTTP ${response.status}`;
    }

    if (failures >= FAILURE_BACKOFF_S.length) {
      throw new Error(
        `Couldn't upload to clawd.gg (${failure}) after ${failures + 1} attempts. ${RESUME_HINT}`
      );
    }
    const seconds = FAILURE_BACKOFF_S[failures++]!;
    note(`  upload failed (${failure}) — retrying in ${seconds}s`);
    await wait(seconds * 1000, signal);
  }
}
