import { describe, expect, it } from "bun:test";
import {
  IMPORT_WAIT_BUDGET_MS,
  ImportAbortedError,
  postImportWithRetry,
  retryAfterSeconds,
  sleep,
} from "./import-upload";

const busy = (retryAfter: string | null = "5") =>
  new Response(JSON.stringify({ error: "Import busy" }), {
    status: 429,
    headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
  });
const ok = () => new Response(JSON.stringify({ inserted: 7 }), { status: 200 });

/** A fake clock that sleeps by moving forward, and a log of what happened. */
function harness(responses: Array<() => Response | Promise<Response>>, random = () => 0.5) {
  let clock = 0;
  const waits: number[] = [];
  const notes: string[] = [];
  let attempts = 0;
  const deps = {
    post: async () => {
      const next = responses[Math.min(attempts, responses.length - 1)]!;
      attempts++;
      return next();
    },
    note: (text: string) => notes.push(text),
    sleep: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    random,
  };
  return { deps, waits, notes, attempts: () => attempts, clock: () => clock };
}

describe("retryAfterSeconds", () => {
  it("takes the server's seconds, capped", () => {
    expect(retryAfterSeconds("2")).toBe(2);
    expect(retryAfterSeconds("8")).toBe(8);
    expect(retryAfterSeconds("2.4")).toBe(3);
    expect(retryAfterSeconds("600")).toBe(30);
  });

  it("falls back to 5s on anything unusable", () => {
    for (const header of [null, "", "soon", "0", "-3", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      expect(retryAfterSeconds(header)).toBe(5);
    }
  });
});

describe("postImportWithRetry", () => {
  it("waits out many 429s at the server's pace, then succeeds", async () => {
    const h = harness([...Array.from({ length: 40 }, () => () => busy("6")), ok]);
    const result = await postImportWithRetry<{ inserted: number }>(h.deps);

    expect(result.inserted).toBe(7);
    expect(h.attempts()).toBe(41);
    // 6 s from Retry-After plus half of the one-second jitter.
    expect(h.waits).toEqual(Array.from({ length: 40 }, () => 6_500));
    expect(h.notes[0]).toBe("  waiting for a slot (6s)");
    expect(h.notes).toHaveLength(40);
  });

  it("jitters each wait by up to a second", async () => {
    const draws = [0, 0.999];
    const h = harness([() => busy("3"), () => busy("3"), ok], () => draws.shift() ?? 0);
    await postImportWithRetry(h.deps);
    expect(h.waits).toEqual([3_000, 3_999]);
  });

  it("gives up once the waits would pass the total budget", async () => {
    const h = harness([() => busy("8")]);
    await expect(postImportWithRetry(h.deps)).rejects.toThrow(/too busy .* 10 minutes.*re-run `clawdgg setup`/);

    // Never sleeps past the budget, and got close to it.
    expect(h.clock()).toBeLessThanOrEqual(IMPORT_WAIT_BUDGET_MS);
    expect(h.clock()).toBeGreaterThan(IMPORT_WAIT_BUDGET_MS - 8_500);
    expect(h.attempts()).toBe(Math.floor(IMPORT_WAIT_BUDGET_MS / 8_500) + 1);
  });

  it("backs off 1, 2, 4, 8 s on a 5xx, then fails saying the import is resumable", async () => {
    const h = harness([() => new Response("oops", { status: 503 })]);
    const failure = postImportWithRetry(h.deps);

    await expect(failure).rejects.toThrow("Couldn't upload to clawd.gg (HTTP 503) after 5 attempts.");
    await expect(failure).rejects.toThrow(/re-run `clawdgg setup`.*never counted twice/);
    expect(h.waits).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(h.attempts()).toBe(5);
  });

  it("recovers from a network error and a 5xx", async () => {
    const h = harness([
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("bad gateway", { status: 502 }),
      ok,
    ]);
    const result = await postImportWithRetry<{ inserted: number }>(h.deps);
    expect(result.inserted).toBe(7);
    expect(h.waits).toEqual([1_000, 2_000]);
    expect(h.notes[0]).toBe("  upload failed (fetch failed) — retrying in 1s");
  });

  it("does not retry a 4xx other than 429", async () => {
    const h = harness([() => new Response("bad rows", { status: 400 })]);
    await expect(postImportWithRetry(h.deps)).rejects.toThrow("Import rejected (HTTP 400): bad rows");
    expect(h.attempts()).toBe(1);
  });

  it("stops a wait in progress on abort", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const started = Date.now();
    const pending = postImportWithRetry({
      post: async () => {
        attempts++;
        return busy("30");
      },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toBeInstanceOf(ImportAbortedError);
    expect(attempts).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a request in flight on abort, without retrying it", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = postImportWithRetry({
      post: (signal) => {
        attempts++;
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ImportAbortedError);
    expect(attempts).toBe(1);
  });

  it("does not start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    await expect(
      postImportWithRetry({ post: async () => (attempts++, ok()), signal: controller.signal })
    ).rejects.toBeInstanceOf(ImportAbortedError);
    expect(attempts).toBe(0);
  });
});

describe("sleep", () => {
  it("resolves after the time", async () => {
    await sleep(1);
  });

  it("rejects at once on abort", async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ImportAbortedError);
  });
});
