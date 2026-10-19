import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeStatusLineSetting,
  runWrappedStatusLine,
  wrapStatusLineSetting,
} from "./statusline";
import { buildStatusLineWrapCommand, readStatusLineCommand } from "./settings";

const ARGV = ["/Users/me/.clawdgg/bin/clawdgg"];
const wrapper = (original: string) => buildStatusLineWrapCommand(ARGV, original);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A status line script of someone else's, written to a temp dir. */
function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "clawdgg-statusline-"));
  dirs.push(dir);
  const path = join(dir, "statusline.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("wrapStatusLineSetting", () => {
  it("keeps every other key, replacing only the command", () => {
    const settings: Record<string, any> = {
      statusLine: { type: "command", command: "~/.claude/statusline.sh", padding: 0 },
      env: { FOO: "1" },
    };
    const result = wrapStatusLineSetting(settings, wrapper);

    expect(result.action).toBe("wrapped");
    expect(result.originalCommand).toBe("~/.claude/statusline.sh");
    expect(settings.statusLine).toEqual({
      type: "command",
      command: `${ARGV[0]} statusline --wrap '~/.claude/statusline.sh'`,
      padding: 0,
    });
    expect(settings.env).toEqual({ FOO: "1" });
  });

  it("promotes a bare string to the object form Claude Code also accepts", () => {
    const settings: Record<string, any> = { statusLine: "starship prompt" };
    expect(wrapStatusLineSetting(settings, wrapper).action).toBe("wrapped");
    expect(settings.statusLine).toEqual({
      type: "command",
      command: `${ARGV[0]} statusline --wrap 'starship prompt'`,
    });
  });

  // A status line that runs a status line that runs a status line.
  it("never wraps ourselves, plain or already wrapping", () => {
    for (const command of [
      "clawdgg statusline",
      `${ARGV[0]} statusline`,
      `${ARGV[0]} statusline --wrap '~/.claude/statusline.sh'`,
    ]) {
      const settings: Record<string, any> = { statusLine: { type: "command", command } };
      expect(wrapStatusLineSetting(settings, wrapper).action).toBe("already-ours");
      expect(settings.statusLine.command).toBe(command);
    }
  });

  it("has nothing to wrap when no status line is configured", () => {
    expect(wrapStatusLineSetting({}, wrapper).action).toBe("absent");
  });
});

describe("wrap → disable round trip", () => {
  it.each([
    ["an object with padding", { type: "command", command: "~/bin/mine.sh --fancy", padding: 0 }],
    ["a bare string", "starship prompt"],
    ["unusual keys we do not understand", { type: "command", command: "x.sh", padding: 2, future: { a: 1 } }],
    ["a command needing shell quoting", { type: "command", command: `~/bin/"my prompt".sh --tag 'a b' $PWD` }],
  ])("restores %s byte for byte", (_label, original: any) => {
    const settings: Record<string, any> = { statusLine: original, env: {} };
    const before = JSON.stringify(settings);

    const wrapped = wrapStatusLineSetting(settings, wrapper);
    expect(wrapped.action).toBe("wrapped");
    expect(JSON.stringify(settings)).not.toBe(before);

    expect(removeStatusLineSetting(settings, wrapped.original)).toBe("restored");
    // Byte-identical, which is stricter than deep equality: key order too.
    expect(JSON.stringify(settings)).toBe(before);
  });

  it("recovers the command from our own argv when nothing was recorded", () => {
    // A `disable` on another machine, or a config written before we stored it.
    const settings: Record<string, any> = {
      statusLine: { type: "command", command: "~/bin/mine.sh --fancy", padding: 0 },
    };
    const wrapped = wrapStatusLineSetting(settings, wrapper);
    expect(wrapped.action).toBe("wrapped");

    expect(removeStatusLineSetting(settings)).toBe("restored");
    expect(settings.statusLine).toEqual({
      type: "command",
      command: "~/bin/mine.sh --fancy",
      padding: 0,
    });
  });

  it("leaves a status line the user changed after we wrapped theirs", () => {
    const settings: Record<string, any> = { statusLine: { type: "command", command: "~/bin/new.sh" } };
    expect(removeStatusLineSetting(settings, "~/bin/old.sh")).toBe("not-ours");
    expect(settings.statusLine).toEqual({ type: "command", command: "~/bin/new.sh" });
  });

  it("still deletes our unwrapped status line outright", () => {
    const settings: Record<string, any> = { statusLine: { type: "command", command: "clawdgg statusline" } };
    expect(removeStatusLineSetting(settings)).toBe("removed");
    expect(settings.statusLine).toBeUndefined();
  });
});

describe("readStatusLineCommand", () => {
  it("round-trips a command through the quoting and back", () => {
    for (const original of [
      "~/.claude/statusline.sh",
      "starship prompt",
      `~/bin/"my prompt".sh --tag 'a b'`,
      "echo $PWD | tr a-z A-Z",
      "sh -c 'echo nested'",
    ]) {
      expect(readStatusLineCommand(buildStatusLineWrapCommand(ARGV, original))).toEqual({
        ours: true,
        wrapped: original,
      });
    }
  });

  it("does not claim somebody else's command that mentions --wrap", () => {
    expect(readStatusLineCommand("~/bin/mine.sh --wrap 'clawdgg statusline'").ours).toBe(false);
    expect(readStatusLineCommand("/opt/bin/statusline").ours).toBe(false);
  });
});

describe("runWrappedStatusLine", () => {
  const stdin = JSON.stringify({ model: { display_name: "Opus 5" }, session_id: "s1" });

  it("passes the output through byte for byte, colors and all", async () => {
    // \x1b[36m…\x1b[0m, two lines, and no trailing newline on the last one.
    const path = script(`printf '\\033[36mclawd\\033[0m 42%%\\nsecond line'`);
    const result = await runWrappedStatusLine(path, stdin);

    expect(new TextDecoder().decode(result.stdout)).toBe("\x1b[36mclawd\x1b[0m 42%\nsecond line");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("hands the command the same stdin Claude Code sent us", async () => {
    const path = script(`cat`);
    const result = await runWrappedStatusLine(path, stdin);
    expect(new TextDecoder().decode(result.stdout)).toBe(stdin);
  });

  it("runs it through a shell, so pipes and quotes keep working", async () => {
    const result = await runWrappedStatusLine(`printf 'a b' | tr ' ' '-'`, stdin);
    expect(new TextDecoder().decode(result.stdout)).toBe("a-b");
  });

  it("passes a failure through: their output, their exit code, their stderr", async () => {
    const path = script(`printf 'half a line'\nprintf 'boom\\n' >&2\nexit 3`);
    const result = await runWrappedStatusLine(path, stdin);

    expect(new TextDecoder().decode(result.stdout)).toBe("half a line");
    expect(new TextDecoder().decode(result.stderr)).toBe("boom\n");
    expect(result.exitCode).toBe(3);
  });

  it("survives a command that does not exist", async () => {
    const result = await runWrappedStatusLine("/nonexistent/statusline.sh", stdin);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.length).toBe(0);
  });

  it("kills a hanging command and keeps what it printed", async () => {
    const path = script(`printf 'before the hang'\nsleep 30`);
    const started = Date.now();
    // Long enough to outlast two shell startups — the point is the kill, and a
    // budget tighter than process spawn measures the machine, not the code.
    const result = await runWrappedStatusLine(path, stdin, 1200);
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    // It returned on the deadline, not after `sleep 30`.
    expect(elapsed).toBeGreaterThanOrEqual(1200);
    expect(elapsed).toBeLessThan(5000);
    // A partial line beats a blank one, and beats our own text in its place.
    expect(new TextDecoder().decode(result.stdout)).toBe("before the hang");
  });

  it("prints nothing of its own for a command that prints nothing", async () => {
    const result = await runWrappedStatusLine(script("true"), stdin);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.exitCode).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The deadline bounds the PROCESS, not just the shell
// ═══════════════════════════════════════════════════════════════════════════

/**
 * These run the real CLI as a child, because what is being measured is when
 * OUR PROCESS EXITS — and that is not something a function call can show.
 * Claude Code waits for the statusLine command to exit before it draws the
 * prompt, so a process that returns in 3s and then sits on an open pipe for
 * five more is a five-second prompt, and the in-process timeout said nothing
 * about it.
 */
describe("the wrapped status line as a whole process", () => {
  const CLI = join(import.meta.dir, "index.ts");
  const stdin = JSON.stringify({ model: { display_name: "Opus 5" }, session_id: "s1" });

  async function runCli(wrapped: string) {
    // HOME to a temp dir: this path reads ~/.config/clawdgg for a token, and a
    // test must not find the developer's own.
    const home = mkdtempSync(join(tmpdir(), "clawdgg-home-"));
    dirs.push(home);
    const started = Date.now();
    const child = Bun.spawn(["bun", CLI, "statusline", "--wrap", wrapped], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, CLAWDGG_API_URL: "http://127.0.0.1:1" },
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return { ms: Date.now() - started, stdout: out, stderr: err };
  }

  // 3.5s is WRAPPED_TIMEOUT_MS (3s) plus the drain grace and two process
  // starts. The number that matters is that it is nowhere near 8.
  const BUDGET_MS = 3_500;

  it("stops waiting on a command that hangs after printing", async () => {
    const result = await runCli("echo a; sleep 8");

    expect(result.stdout).toBe("a\n");
    expect(result.ms).toBeLessThan(BUDGET_MS);
    // It really did wait out the deadline rather than giving up early.
    expect(result.ms).toBeGreaterThan(2_000);
  }, 20_000);

  /**
   * The case the old code could not survive at all: `sh` exits in milliseconds
   * and a BACKGROUNDED grandchild keeps the stdout pipe open for eight
   * seconds. Nothing timed out, because nothing was running — the process just
   * could not exit. Measured at 8.08s before the process-group kill.
   */
  it("exits as soon as the shell does, whatever it left running", async () => {
    const result = await runCli("(sleep 8; echo late) & echo hi");

    expect(result.stdout).toBe("hi\n");
    // Nothing of the grandchild's output, which arrives long after the prompt.
    expect(result.stdout).not.toContain("late");
    expect(result.ms).toBeLessThan(BUDGET_MS);
  }, 20_000);

  it("passes a plain status line straight through", async () => {
    const result = await runCli("printf 'clawd 42%%'");
    expect(result.stdout).toBe("clawd 42%");
    expect(result.ms).toBeLessThan(BUDGET_MS);
  }, 20_000);
});
