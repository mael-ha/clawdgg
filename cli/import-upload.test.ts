import { describe, expect, it } from "bun:test";
import {
  IMPORT_WAIT_BUDGET_MS,
  ImportAbortedError,
  importBatches,
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

describe("importBatches", () => {
  const rows = (day: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ timestamp: `${day} 10:00:${String(i % 60).padStart(2, "0")}.000`, i }));
  const days = (batch: { events: { timestamp: string }[] }) => [...new Set(batch.events.map((e) => e.timestamp.slice(0, 10)))];

  it("packs whole days up to the cap and never splits one", () => {
    const all = [...rows("2026-03-01", 3), ...rows("2026-03-02", 4), ...rows("2026-03-03", 2), ...rows("2026-03-04", 5)];
    const batches = importBatches(all, 8);

    expect(batches.map(days)).toEqual([["2026-03-01", "2026-03-02"], ["2026-03-03", "2026-03-04"]]);
    expect(batches.map((b) => b.openDay)).toEqual([null, null]);
    expect(batches.flatMap((b) => b.events)).toEqual(all);
  });

  it("gives a day over the cap batches of its own, open until its last", () => {
    const all = [...rows("2026-03-01", 2), ...rows("2026-03-02", 7), ...rows("2026-03-03", 1)];
    const batches = importBatches(all, 3);

    expect(batches.map((b) => [days(b), b.events.length, b.openDay])).toEqual([
      [["2026-03-01"], 2, null],
      [["2026-03-02"], 3, "2026-03-02"],
      [["2026-03-02"], 3, "2026-03-02"],
      [["2026-03-02"], 1, null],
      [["2026-03-03"], 1, null],
    ]);
    expect(batches.flatMap((b) => b.events)).toEqual(all);
  });

  it("treats a day exactly at the cap as whole", () => {
    const batches = importBatches([...rows("2026-03-01", 3), ...rows("2026-03-02", 3)], 3);
    expect(batches.map((b) => [days(b), b.openDay])).toEqual([[["2026-03-01"], null], [["2026-03-02"], null]]);
  });

  it("has no batch for no rows", () => {
    expect(importBatches([], 5)).toEqual([]);
  });

  it("no batch ends in a day the next one continues, unless it says so", () => {
    const all = Array.from({ length: 40 }, (_, d) => rows(`2026-04-${String(d % 28 + 1).padStart(2, "0")}`, (d * 7) % 13 + 1))
      .flat()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const batches = importBatches(all, 10);
    for (let i = 0; i + 1 < batches.length; i++) {
      const lastDay = batches[i]!.events.at(-1)!.timestamp.slice(0, 10);
      const nextDay = batches[i + 1]!.events[0]!.timestamp.slice(0, 10);
      expect(batches[i]!.openDay).toBe(lastDay === nextDay ? lastDay : null);
      expect(batches[i]!.events.length).toBeLessThanOrEqual(10);
    }
    expect(batches.flatMap((b) => b.events)).toEqual(all);
  });
});
