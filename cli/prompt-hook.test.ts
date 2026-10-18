import { describe, expect, it } from "bun:test";
import {
  PROMPT_HOOK_TIMEOUT_SECONDS,
  applyPromptHookSetting,
  buildReport,
  hasOurPromptHook,
  removePromptHookSetting,
} from "./prompt-hook";
import { buildPromptHookCommand } from "./settings";

const OURS = "clawdgg prompt-hook";
const THEIRS = "~/bin/my-own-hook.sh";

describe("buildPromptHookCommand", () => {
  it("quotes an argv with spaces in it, like every other hook command", () => {
    expect(buildPromptHookCommand(["/Users/a b/.local/bin/clawdgg"])).toBe(
      "'/Users/a b/.local/bin/clawdgg' prompt-hook"
    );
  });
});

describe("applyPromptHookSetting", () => {
  it("registers the hook with no matcher, since the event takes none", () => {
    const settings: Record<string, any> = {};
    expect(applyPromptHookSetting(settings, OURS).action).toBe("added");

    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: OURS, timeout: PROMPT_HOOK_TIMEOUT_SECONDS }] },
    ]);
    expect(settings.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
  });

  it("is a no-op when ours is already there", () => {
    const settings: Record<string, any> = {};
    applyPromptHookSetting(settings, OURS);
    const snapshot = JSON.parse(JSON.stringify(settings));

    expect(applyPromptHookSetting(settings, OURS).action).toBe("already-ours");
    expect(settings).toEqual(snapshot);
  });

  it("recognises ours through a wrapper or an absolute path", () => {
    for (const command of [
      "/Users/me/.local/bin/clawdgg prompt-hook",
      "'/Users/a b/.local/bin/clawdgg' prompt-hook",
      "bun ~/src/clawdgg/cli/index.ts prompt-hook",
    ]) {
      const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ command }] }] } };
      expect(hasOurPromptHook(settings)).toBe(true);
      expect(applyPromptHookSetting(settings, OURS).action).toBe("already-ours");
    }
  });

  // Hooks are a list, unlike statusLine: ours coexists instead of conflicting.
  it("adds itself alongside someone else's hook, displacing nothing", () => {
    const settings: Record<string, any> = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: THEIRS }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: THEIRS }] }],
      },
    };
    expect(applyPromptHookSetting(settings, OURS).action).toBe("added");

    const commands = settings.hooks.UserPromptSubmit.flatMap((g: any) =>
      g.hooks.map((h: any) => h.command)
    );
    expect(commands).toEqual([THEIRS, OURS]);
    // Their other event is untouched.
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(THEIRS);
  });

  it("joins an existing group's event without reshaping it", () => {
    const settings: Record<string, any> = {
      hooks: { UserPromptSubmit: [{ matcher: "*", hooks: [{ command: THEIRS }] }] },
    };
    applyPromptHookSetting(settings, OURS);
    expect(settings.hooks.UserPromptSubmit[0]).toEqual({ matcher: "*", hooks: [{ command: THEIRS }] });
  });

  // A shape we do not understand is left alone: reshaping one is how somebody's
  // hook configuration gets destroyed.
  it.each([
    [{ hooks: { UserPromptSubmit: "my-hook.sh" } }],
    [{ hooks: { UserPromptSubmit: { command: "x" } } }],
    [{ hooks: [] }],
    [{ hooks: "none" }],
  ])("refuses a malformed hooks block (%p)", (settings: any) => {
    const before = JSON.parse(JSON.stringify(settings));
    expect(applyPromptHookSetting(settings, OURS).action).toBe("malformed");
    expect(settings).toEqual(before);
  });

  it("does not claim a command that merely mentions us", () => {
    const settings = {
      hooks: { UserPromptSubmit: [{ hooks: [{ command: "~/bin/log.sh --tag clawdgg --no-prompt-hook" }] }] },
    };
    expect(hasOurPromptHook(settings)).toBe(false);
  });
});

describe("removePromptHookSetting", () => {
  it("removes ours and tidies the containers it created", () => {
    const settings: Record<string, any> = {};
    applyPromptHookSetting(settings, OURS);

    expect(removePromptHookSetting(settings)).toBe("removed");
    // Back to exactly what it was before setup, not an empty husk.
    expect(settings).toEqual({});
  });

  it("leaves someone else's hook, and the event, in place", () => {
    const settings: Record<string, any> = {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: THEIRS }] }] },
    };
    applyPromptHookSetting(settings, OURS);

    expect(removePromptHookSetting(settings)).toBe("removed");
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: THEIRS }] },
    ]);
  });

  it("keeps a group that carries keys of its own, even when emptied", () => {
    const settings: Record<string, any> = {
      hooks: { UserPromptSubmit: [{ matcher: "*", hooks: [{ command: OURS }] }] },
    };
    expect(removePromptHookSetting(settings)).toBe("removed");
    expect(settings.hooks.UserPromptSubmit).toEqual([{ matcher: "*", hooks: [] }]);
  });

  it("reports absent when there is nothing of ours", () => {
    expect(removePromptHookSetting({})).toBe("absent");
    expect(
      removePromptHookSetting({ hooks: { UserPromptSubmit: [{ hooks: [{ command: THEIRS }] }] } })
    ).toBe("absent");
    expect(removePromptHookSetting({ hooks: { UserPromptSubmit: "nonsense" } })).toBe("absent");
  });
});

describe("buildReport", () => {
  const now = new Date("2026-10-18T09:00:00.000Z");

  it("carries the flag, the session and the time — and nothing else", () => {
    const report = buildReport(
      { session_id: "s1", prompt: "ultrathink this secret plan", hook_event_name: "UserPromptSubmit" },
      now
    );
    expect(report).toEqual({
      session_id: "s1",
      timestamp: "2026-10-18T09:00:00.000Z",
      ultrathink: true,
    });

    // The prompt must not survive anywhere in the payload, including as a length.
    const json = JSON.stringify(report);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("plan");
    expect(Object.keys(report).sort()).toEqual(["session_id", "timestamp", "ultrathink"]);
  });

  it("tolerates a payload with no session id", () => {
    expect(buildReport({ prompt: "ultrathink" }, now).session_id).toBe("");
  });
});
