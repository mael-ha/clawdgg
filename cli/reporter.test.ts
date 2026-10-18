import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REPORT_BYTES, parseReportArgv, spawnDetachedReporter } from "./reporter";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "clawdgg-reporter-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * THE REGRESSION TEST.
 *
 * A real parent process that prints NOTHING, spawns the reporter and exits
 * immediately — the shape in which the old stdin pipe lost the payload every
 * time. The "binary" the child runs is a recorder script (via CLAWDGG_BIN), so
 * this asserts what the detached process actually received, not what the parent
 * meant to send.
 */
describe("spawnDetachedReporter, from a parent that exits at once", () => {
  async function handOff(payload: unknown, opts: { print?: boolean; expectNothing?: boolean } = {}) {
    const dir = scratch();
    const received = join(dir, "received.txt");

    // $1 is the subcommand, $2 the payload: exactly the argv the real binary
    // is dispatched with.
    const recorder = join(dir, "recorder.sh");
    writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n%s' "$1" "$2" > ${received}\n`, { mode: 0o755 });

    // The parent: no output, one handoff, immediate exit.
    const parent = join(dir, "parent.ts");
    writeFileSync(
      parent,
      [
        `import { spawnDetachedReporter } from ${JSON.stringify(join(import.meta.dir, "reporter.ts"))};`,
        `const handed = spawnDetachedReporter("statusline-report", JSON.parse(process.argv[2]));`,
        opts.print ? `process.stdout.write("status line\\n");` : ``,
        `if (!handed) process.exit(3);`,
      ].join("\n")
    );

    const proc = Bun.spawn([process.execPath, parent, JSON.stringify(payload)], {
      env: { ...process.env, CLAWDGG_BIN: recorder },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    // The child outlives the parent, so give it a moment to be scheduled. A
    // case that expects nothing waits briefly and no more — it cannot prove a
    // negative by waiting longer, it can only slow the suite down.
    const attempts = opts.expectNothing ? 10 : 60;
    for (let i = 0; i < attempts && !existsSync(received); i++) {
      await Bun.sleep(50);
    }

    return {
      exitCode,
      stdout,
      stderr,
      got: existsSync(received) ? readFileSync(received, "utf-8") : null,
    };
  }

  it("delivers the payload although the parent printed nothing", async () => {
    const report = {
      rate_limits: { seven_day: { used_percentage: 41.6, resets_at: 1790400000 } },
      sessionId: "sess-1",
      capturedAt: 1792343539,
    };
    const result = await handOff(report);

    expect(result.exitCode).toBe(0);
    // The premise: a parent on this path writes nothing at all.
    expect(result.stdout).toBe("");
    expect(result.got).not.toBeNull();

    const [subcommand, payload] = result.got!.split("\n");
    expect(subcommand).toBe("statusline-report");
    expect(JSON.parse(payload ?? "")).toEqual(report);
  });

  it("delivers it just the same when the parent does print", async () => {
    const result = await handOff({ rate_limits: {}, capturedAt: 1 }, { print: true });
    expect(result.stdout).toBe("status line\n");
    expect(JSON.parse(result.got!.split("\n")[1] ?? "")).toEqual({ rate_limits: {}, capturedAt: 1 });
  });

  it("refuses a payload too big for an argv instead of spawning one", async () => {
    // Over the cap: the caller must learn this so it can send in-process.
    const result = await handOff({ blob: "x".repeat(MAX_REPORT_BYTES) }, { expectNothing: true });
    expect(result.exitCode).toBe(3);
    expect(result.got).toBeNull();
  });
});

describe("spawnDetachedReporter", () => {
  it("says no to a payload that will not serialise", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(spawnDetachedReporter("statusline-report", circular)).toBe(false);
  });
});

describe("parseReportArgv", () => {
  it("parses an object payload", () => {
    expect(parseReportArgv<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("rejects a missing, malformed, oversized or non-object payload", () => {
    expect(parseReportArgv(undefined)).toBeNull();
    expect(parseReportArgv("")).toBeNull();
    expect(parseReportArgv("not json")).toBeNull();
    expect(parseReportArgv("[1,2]")).toBeNull();
    expect(parseReportArgv("null")).toBeNull();
    expect(parseReportArgv("42")).toBeNull();
    expect(parseReportArgv(`{"blob":"${"x".repeat(MAX_REPORT_BYTES)}"}`)).toBeNull();
  });
});
