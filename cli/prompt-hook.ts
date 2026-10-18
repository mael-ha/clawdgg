// `clawdgg prompt-hook` — the UserPromptSubmit hook, for the ultrathink counter.
//
// It answers one question about each prompt — does it contain the word
// "ultrathink"? — and sends the ANSWER, never the question. The text is read in
// this process, matched against one regex, and dropped.
//
// THE CONTRACT (verified against https://code.claude.com/docs/en/hooks on
// 2026-10-18, Claude Code 2.1.30x):
//   - stdin is JSON: { session_id, transcript_path, cwd, permission_mode,
//     hook_event_name: "UserPromptSubmit", prompt }. The typed text is `prompt`.
//   - UserPromptSubmit is one of the four events where plain stdout on exit 0
//     is INJECTED INTO CLAUDE'S CONTEXT as a system reminder. So this hook
//     prints absolutely nothing — a stray byte would end up in the
//     conversation, which is both a surprise and a cost.
//   - exit 2 BLOCKS the prompt and shows stderr to the user. We never exit 2.
//     Any other non-zero exit is a non-blocking failure, but we exit 0 anyway.
//   - the event takes no matcher (one is silently ignored), so we register a
//     single bare hook entry.
//
// Nothing blocks the prompt: the report goes to a DETACHED child and this
// process returns immediately, exactly as cli/statusline.ts does. Claude Code
// waits for the hook to exit before the prompt goes anywhere, so every
// millisecond here is a millisecond the user waits.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { API_BASE_URL, CONFIG_FILE, tokenIsForThisOrigin } from "./paths";
import { parseReportArgv, spawnDetachedReporter } from "./reporter";
import { isOurPromptHookCommand } from "./settings";
import { markTokenRevoked } from "./token-state";
import { containsUltrathink } from "../src/lib/ultrathink";

/** Fallback command shape, and what an older settings.json may contain. */
export const PROMPT_HOOK_COMMAND = "clawdgg prompt-hook";

/** The hook event we register for. */
export const PROMPT_HOOK_EVENT = "UserPromptSubmit";

/**
 * Seconds Claude Code waits for us. The default is 30, which is 30 seconds a
 * broken network could cost someone mid-prompt; we exit in milliseconds, so a
 * low ceiling only ever bounds a pathology.
 */
export const PROMPT_HOOK_TIMEOUT_SECONDS = 5;

const POST_TIMEOUT_MS = 2000;

// The matcher itself lives in src/lib/ultrathink.ts: the history import has to
// apply the SAME rule, and two copies of it would quietly diverge.
export { containsUltrathink };

// ============= SETTINGS.JSON MERGE =============

export type PromptHookMergeAction = "added" | "already-ours" | "malformed";

export interface PromptHookMergeResult {
  action: PromptHookMergeAction;
}

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

/** Every command string registered for the event, whoever wrote it. */
function registeredCommands(settings: Record<string, any>): string[] {
  const groups = settings?.hooks?.[PROMPT_HOOK_EVENT];
  if (!Array.isArray(groups)) return [];
  const commands: string[] = [];
  for (const group of groups as HookGroup[]) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const entry of group.hooks) {
      if (entry && typeof entry.command === "string") commands.push(entry.command);
    }
  }
  return commands;
}

export function hasOurPromptHook(settings: Record<string, any>): boolean {
  return registeredCommands(settings).some(isOurPromptHookCommand);
}

/**
 * Register our hook, in place, WITHOUT displacing anybody else's.
 *
 * Unlike `statusLine` — a single value, so ours and theirs cannot coexist and a
 * foreign one is a conflict — hooks are a list. Someone else's UserPromptSubmit
 * hook keeps running alongside ours, so there is no conflict case to ask about
 * and nothing of theirs to remember for `disable`.
 *
 * `malformed` means `hooks.UserPromptSubmit` exists but is not the shape the
 * docs describe. We refuse to guess at it: re-shaping a structure we do not
 * understand is how a hook configuration gets destroyed.
 */
export function applyPromptHookSetting(
  settings: Record<string, any>,
  command: string = PROMPT_HOOK_COMMAND
): PromptHookMergeResult {
  if (hasOurPromptHook(settings)) return { action: "already-ours" };

  const hooks = settings.hooks;
  if (hooks !== undefined && (hooks === null || typeof hooks !== "object" || Array.isArray(hooks))) {
    return { action: "malformed" };
  }
  const existing = hooks?.[PROMPT_HOOK_EVENT];
  if (existing !== undefined && !Array.isArray(existing)) return { action: "malformed" };

  const entry: HookGroup = {
    // No matcher: the docs say UserPromptSubmit does not support one and
    // silently ignores it, so writing one would be noise that looks like intent.
    hooks: [{ type: "command", command, timeout: PROMPT_HOOK_TIMEOUT_SECONDS }],
  };

  settings.hooks ??= {};
  settings.hooks[PROMPT_HOOK_EVENT] ??= [];
  settings.hooks[PROMPT_HOOK_EVENT].push(entry);
  return { action: "added" };
}

export type PromptHookRemovalAction = "removed" | "absent";

/**
 * Take our hook back out, leaving every other entry — and every other event —
 * exactly as it was. Empty containers we created are tidied away, so a
 * settings.json that had no `hooks` before `setup` has none after `disable`.
 */
export function removePromptHookSetting(settings: Record<string, any>): PromptHookRemovalAction {
  const groups = settings?.hooks?.[PROMPT_HOOK_EVENT];
  if (!Array.isArray(groups)) return "absent";

  let removed = false;
  const kept: HookGroup[] = [];
  for (const group of groups as HookGroup[]) {
    if (!group || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const entries = group.hooks.filter((entry) => {
      const ours = entry && typeof entry.command === "string" && isOurPromptHookCommand(entry.command);
      if (ours) removed = true;
      return !ours;
    });
    // A group that held only our entry goes with it; one that held others, and
    // any group carrying keys we do not recognise, stays.
    if (entries.length > 0 || Object.keys(group).length > 1) {
      kept.push({ ...group, hooks: entries });
    }
  }

  if (!removed) return "absent";

  if (kept.length > 0) {
    settings.hooks[PROMPT_HOOK_EVENT] = kept;
  } else {
    delete settings.hooks[PROMPT_HOOK_EVENT];
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  return "removed";
}

// ============= THE HOOK ITSELF =============

export interface PromptHookInput {
  session_id?: string;
  hook_event_name?: string;
  prompt?: string;
}

/** Only ever the flag. Never the prompt, never its length, never its hash. */
export interface UltrathinkReport {
  session_id: string;
  timestamp: string;
  ultrathink: true;
}

export function buildReport(input: PromptHookInput, now: Date = new Date()): UltrathinkReport {
  return {
    session_id: typeof input.session_id === "string" ? input.session_id : "",
    timestamp: now.toISOString(),
    ultrathink: true,
  };
}

async function readStdinSafely(): Promise<string> {
  try {
    if (process.stdin.isTTY) return "";
    return await Bun.stdin.text();
  } catch {
    return "";
  }
}

// Deliberately not index.ts's loadConfig(): that one migrates legacy config
// directories and prints notices, and on this path a printed byte lands in
// Claude's context.
async function readTokenQuietly(): Promise<string | null> {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
    if (!tokenIsForThisOrigin(parsed?.apiOrigin)) return null;
    if (typeof parsed?.token === "string" && parsed.token) return parsed.token;
  } catch {
    // No readable config means no report. It never means a broken prompt.
  }
  return null;
}

async function postUltrathink(report: UltrathinkReport, token: string): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/cli/ultrathink`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (response.status === 401) await markTokenRevoked(token);
  } catch {
    // A dropped flag is a missed count. It is never worth a visible failure.
  }
}

/**
 * Hand the report to a detached copy of ourselves and return.
 *
 * The payload is the REPORT, not the raw stdin: the child has no reason to see
 * the prompt, and a prompt that never enters a second process cannot be logged
 * by one. It goes on the argv, through the shared channel in cli/reporter.ts —
 * which is also where the measurement behind that choice lives.
 *
 * Safe on the argv precisely because of what the report is: a session id, a
 * timestamp and a boolean. No prompt, no length, nothing anyone's `ps` should
 * not see.
 */
function spawnReporter(report: UltrathinkReport): boolean {
  return spawnDetachedReporter("prompt-hook-report", report);
}

/**
 * The hook. Prints nothing, exits 0, blocks nothing.
 *
 * Note what it does NOT do: no config migration, no token refresh, no retry, no
 * logging. The only work on the critical path is a JSON parse, a regex, and —
 * for a prompt that matched — one spawn.
 */
export async function cmdPromptHook(): Promise<void> {
  try {
    const raw = await readStdinSafely();
    if (!raw.trim()) return;

    let input: PromptHookInput;
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }

    if (!containsUltrathink(input.prompt)) return;

    const report = buildReport(input);
    if (!spawnReporter(report)) {
      // A platform or sandbox that refuses to spawn: send it here rather than
      // lose the count, still bounded by POST_TIMEOUT_MS.
      const token = await readTokenQuietly();
      if (token) await postUltrathink(report, token);
    }
  } catch {
    // Whatever went wrong, the prompt goes through and nothing is printed.
  }
}

/**
 * `clawdgg prompt-hook-report` — the detached half. Claude Code never calls it.
 *
 * Takes the report as its one argument; see spawnReporter for why not stdin.
 */
export async function cmdPromptHookReport(raw: string | undefined): Promise<void> {
  const report = parseReportArgv<UltrathinkReport>(raw);
  if (report?.ultrathink !== true) return;

  const token = await readTokenQuietly();
  if (!token) return;
  await postUltrathink(report, token);
}
