import { describe, expect, it } from "bun:test";
import { createProgress, progressBar, renderProgressLine } from "./progress";

/** A writer plus a clock we control, so the throttle is testable at all. */
function harness(isTTY: boolean, total: number, extra: Record<string, unknown> = {}) {
  const writes: string[] = [];
  let clock = 0;
  const progress = createProgress({
    label: "Reading transcripts",
    total,
    isTTY,
    color: false,
    write: (text) => writes.push(text),
    now: () => clock,
    ...extra,
  });
  return { progress, writes, tick: (ms: number) => { clock += ms; } };
}

describe("progressBar", () => {
  it("fills in tenths", () => {
    expect(progressBar(0)).toBe("▕░░░░░░░░░░▏");
    expect(progressBar(0.34)).toBe("▕███░░░░░░░▏");
    expect(progressBar(0.55)).toBe("▕██████░░░░▏");
    expect(progressBar(1)).toBe("▕██████████▏");
  });

  it("is always exactly as wide as it was asked for", () => {
    for (const fraction of [-1, 0, 0.001, 0.5, 0.999, 1, 2, NaN, Infinity]) {
      const bar = progressBar(fraction);
      expect([...bar].length).toBe(12); // 10 cells plus the two end caps
    }
  });
});

describe("renderProgressLine", () => {
  it("is the shape the owner approved", () => {
    expect(renderProgressLine({ label: "Reading transcripts", done: 1234, total: 3645 }))
      .toBe("Reading transcripts  1,234 / 3,645  ▕███░░░░░░░▏ 33%");
  });

  it("names the unit when given one", () => {
    expect(renderProgressLine({ label: "Uploading", done: 12, total: 40, unit: "batches" }))
      .toBe("Uploading  12 / 40 batches  ▕███░░░░░░░▏ 30%");
  });

  it("floors the percentage, so 99.9% never reads as done", () => {
    expect(renderProgressLine({ label: "x", done: 999, total: 1000 })).toContain(" 99%");
    expect(renderProgressLine({ label: "x", done: 1000, total: 1000 })).toContain(" 100%");
  });

  it("calls nothing-to-do done rather than NaN", () => {
    expect(renderProgressLine({ label: "x", done: 0, total: 0 }))
      .toBe("x  0 / 0  ▕██████████▏ 100%");
  });

  it("carries no control characters, ever", () => {
    const line = renderProgressLine({ label: "Reading transcripts", done: 5, total: 9 });
    expect(line).not.toInclude("\r");
    expect(line).not.toInclude("\x1b");
  });
});

describe("on a TTY", () => {
  it("rewrites one line in place and clears it at the end", () => {
    const { progress, writes, tick } = harness(true, 100);

    progress.update(1);
    tick(200);
    progress.update(50);
    progress.finish();

    expect(writes[0]).toBe("\r\x1b[KReading transcripts  1 / 100  ▕░░░░░░░░░░▏ 1%");
    expect(writes[1]).toBe("\r\x1b[KReading transcripts  50 / 100  ▕█████░░░░░▏ 50%");
    expect(writes[2]).toBe("\r\x1b[K");
    expect(writes.every((w) => !w.includes("\n"))).toBe(true);
  });

  it("throttles to about ten redraws a second", () => {
    const { progress, writes, tick } = harness(true, 1000);

    progress.update(1);
    for (let i = 2; i <= 500; i++) {
      tick(1);
      progress.update(i);
    }

    // 500ms of updates — five windows' worth, plus the first draw.
    expect(writes.length).toBeLessThanOrEqual(7);
    expect(writes.length).toBeGreaterThanOrEqual(5);
  });

  it("always draws the last update, throttle or not", () => {
    const { progress, writes } = harness(true, 10);

    progress.update(1);
    progress.update(10); // same millisecond as the draw above

    expect(writes[writes.length - 1]).toContain("10 / 10");
    expect(writes[writes.length - 1]).toContain("100%");
  });

  it("prints a note on its own line and puts the bar back under it", () => {
    const { progress, writes, tick } = harness(true, 40);

    tick(200);
    progress.update(12);
    progress.note("  rate limited — waiting 30s");

    expect(writes[1]).toBe("\r\x1b[K  rate limited — waiting 30s\n");
    expect(writes[2]).toBe("\r\x1b[KReading transcripts  12 / 40  ▕███░░░░░░░▏ 30%");
  });

  it("clears nothing it never drew", () => {
    const { progress, writes } = harness(true, 10);
    progress.finish();
    expect(writes).toEqual([]);
  });
});

describe("off a TTY", () => {
  it("prints a plain line about every 10% and no control characters", () => {
    const { progress, writes } = harness(false, 100);

    for (let i = 1; i <= 100; i++) progress.update(i);
    progress.finish();

    // The first update, then each new tenth: 11 lines for 100 updates.
    expect(writes.length).toBe(11);
    expect(writes[0]).toBe("Reading transcripts  1 / 100  ▕░░░░░░░░░░▏ 1%\n");
    expect(writes[1]).toBe("Reading transcripts  10 / 100  ▕█░░░░░░░░░▏ 10%\n");
    expect(writes[10]).toBe("Reading transcripts  100 / 100  ▕██████████▏ 100%\n");
    expect(writes.every((w) => !w.includes("\r") && !w.includes("\x1b"))).toBe(true);
  });

  it("closes a loop that ended short of the total", () => {
    const { progress, writes } = harness(false, 100);

    progress.update(30);
    progress.finish();

    expect(writes.length).toBe(2);
    expect(writes[1]).toBe("Reading transcripts  30 / 100  ▕███░░░░░░░▏ 30%\n");
  });

  it("writes a note as the plain line it is", () => {
    const { progress, writes } = harness(false, 40);
    progress.note("  rate limited — waiting 30s");
    expect(writes).toEqual(["  rate limited — waiting 30s\n"]);
  });
});

describe("color", () => {
  it("dims the line when colour is on", () => {
    const writes: string[] = [];
    const progress = createProgress({
      label: "x",
      total: 2,
      isTTY: true,
      color: true,
      write: (text) => writes.push(text),
      now: () => 0,
    });
    progress.update(1);
    expect(writes[0]).toBe("\r\x1b[K\x1b[2mx  1 / 2  ▕█████░░░░░▏ 50%\x1b[0m");
  });

  it("is off by default when NO_COLOR is set", () => {
    const before = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const writes: string[] = [];
      const progress = createProgress({
        label: "x",
        total: 2,
        isTTY: true,
        write: (text) => writes.push(text),
        now: () => 0,
      });
      progress.update(1);
      expect(writes[0]).toBe("\r\x1b[Kx  1 / 2  ▕█████░░░░░▏ 50%");
    } finally {
      if (before === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = before;
    }
  });
});

describe("status", () => {
  it("rides on the end of the bar on a TTY until the next update", () => {
    const { progress, writes, tick } = harness(true, 4, { unit: "batches" });
    progress.update(1);
    progress.status("  waiting for a slot (5s)");
    expect(writes.at(-1)).toBe("\r\x1b[KReading transcripts  1 / 4 batches  ▕███░░░░░░░▏ 25%  waiting for a slot (5s)");
    progress.status("  waiting for a slot (3s)");
    expect(writes.filter((w) => w.includes("\n"))).toHaveLength(0);

    // Inside the throttle window, and still redrawn: the stale wait must go.
    tick(1);
    progress.update(2);
    expect(writes.at(-1)).toBe("\r\x1b[KReading transcripts  2 / 4 batches  ▕█████░░░░░▏ 50%");
  });

  it("is a plain line off a TTY", () => {
    const { progress, writes } = harness(false, 4);
    progress.update(1);
    progress.status("  waiting for a slot (5s)");
    expect(writes.at(-1)).toBe("waiting for a slot (5s)\n");
  });
});
