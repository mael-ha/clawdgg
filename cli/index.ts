#!/usr/bin/env bun
// clawdgg — the clawd.gg CLI.
//
// Everything it does is one of three things:
//   1. link a GitHub account (`login`)
//   2. point Claude Code's OTLP exporter at clawd.gg (`setup` / `disable`)
//   3. tell the user whether data is actually flowing (`status` / `doctor`)
//
// Auth for the exporter goes through `otel-headers` (an otelHeadersHelper), not
// a token baked into settings.json — see cli/otel-headers.ts for why.

import { readFile, writeFile, mkdir, chmod, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  API_BASE_URL,
  API_URL_RESOLUTION,
  tokenIsForThisOrigin,
  CLAUDE_HISTORY_PATH,
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SETTINGS_PATH,
  CONFIG_DIR,
  CONFIG_FILE,
  INSTALLED_BINARY,
  selfArgv,
  selfCommand,
} from "./paths";
import {
  computeCostUsd,
  describeTranscriptPath,
  fillPromptGapsFromHistory,
  mapHistoryText,
  mapJsonlText,
  type ImportEventRow,
} from "../src/lib/session-import";
import {
  applyOtelSettings,
  backupSettings,
  buildHelperCommand,
  buildPromptHookCommand,
  buildStatusLineCommand,
  desiredOtelEnv,
  detectManagedSettings,
  isOurHelperCommand,
  loadSettings,
  planOtelSettings,
  restoreOtelSettings,
  SettingsParseError,
  settingsDir,
  SIGNAL_SPECIFIC_KEYS,
  writeSettingsAtomic,
  type OtelOriginals,
} from "./settings";
import {
  applyStatusLineSetting,
  cmdStatusline,
  cmdStatuslineReport,
  removeStatusLineSetting,
  type StatusLineMergeResult,
} from "./statusline";
import {
  applyPromptHookSetting,
  cmdPromptHook,
  cmdPromptHookReport,
  hasOurPromptHook,
  removePromptHookSetting,
  type PromptHookMergeResult,
} from "./prompt-hook";
import {
  deviceTokenId,
  isDeviceToken,
  isWellFormedToken,
  MISSING_TOKEN_MESSAGE,
  otelHeadersLine,
  REVOKED_TOKEN_MESSAGE,
} from "./otel-headers";
import { clearTokenRevoked, isTokenRevoked, markTokenRevoked } from "./token-state";
import { version } from "./version";

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

// Helper functions for colored output
const log = {
  info: (msg: string) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg: string) =>
    console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg: string) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warn: (msg: string) =>
    console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  title: (msg: string) =>
    console.log(`\n${colors.bright}${colors.cyan}${msg}${colors.reset}\n`),
  dim: (msg: string) => console.log(`${colors.dim}${msg}${colors.reset}`),
};

// ============= CONFIG =============

interface Config {
  token?: string;
  userId?: string;
  username?: string;
  /** device_tokens.id of our own token — what `devices` marks as "this machine". */
  deviceId?: string;
  /** The API origin that issued the token. It is never sent anywhere else. */
  apiOrigin?: string;
  /** ISO timestamp of the consent that enabled telemetry. */
  consentAt?: string;
  /** Values in ~/.claude/settings.json that `setup` displaced, for `disable`. */
  otelOriginals?: OtelOriginals;
  /** Where we copied settings.json before our first write. */
  settingsBackup?: string;
  /** ISO timestamp of the last successful history import. */
  importedAt?: string;
  // Celebration detection for `status`
  lastKnownBadges?: string[];
  lastKnownRank?: number;
  lastKnownLongestStreak?: number;
}

/** True when the saved token belongs to a different server than this run. */
let tokenOriginMismatch: string | null = null;

/**
 * Read the saved config.
 *
 * A token pinned to another origin is REMOVED from what this returns (in
 * memory only — the file is left alone). Every command then behaves as if we
 * were not logged in, which is the one behaviour that cannot leak a bearer to
 * a server that did not issue it.
 */
async function loadConfig(): Promise<Config> {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};

    const config = parsed as Config;
    if (!tokenIsForThisOrigin(config.apiOrigin)) {
      tokenOriginMismatch = config.apiOrigin ?? null;
      const { token, deviceId, ...rest } = config;
      return rest;
    }
    return config;
  } catch {
    return {};
  }
}

async function saveConfig(config: Config): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    // writeFile's mode is ignored when the file already exists.
    await chmod(CONFIG_FILE, 0o600);
  } catch (error) {
    throw new Error(`Failed to save config: ${error}`);
  }
}

// ============= PROMPTS =============

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/**
 * y/N confirmation. Non-interactive stdin answers "no" rather than hanging —
 * scripted callers pass `--yes`.
 */
async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    log.error("Not a terminal, and no --yes flag. Refusing to assume consent.");
    return false;
  }
  const answer = (await ask(`${question} ${colors.dim}[y/N]${colors.reset} `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ============= API =============

const API_TIMEOUT_MS = 15_000;

interface ProfileData {
  username: string;
  rank: number;
  totalUsers: number;
  percentile: number;
  archetype: string;
  archetypeDescription: string;
  totalPrompts: number;
  totalTokens: number;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalLines: number;
  totalCommits: number;
  outputLeverage: number;
  cacheEfficiency: number;
  totalMessages: number;
  totalSessions: number;
  totalToolCalls: number;
  currentStreak: number;
  longestStreak: number;
  badges: string[];
}

async function apiFetch(
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<Response> {
  const { token, headers, ...rest } = init;
  return fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

async function fetchProfile(token: string): Promise<ProfileData | null> {
  try {
    const response = await apiFetch("/api/me", { token });
    if (!response.ok) return null;
    return (await response.json()) as ProfileData;
  } catch {
    return null;
  }
}

// ============= LOGIN =============

/**
 * The server issues a device token before it can know what to call it (the
 * token is minted in the browser's OAuth callback, not here), so the CLI names
 * it the moment it has one. Cosmetic: a failure leaves it "unnamed device".
 */
async function nameThisDevice(config: Config): Promise<void> {
  if (!config.token || !config.deviceId) return;
  try {
    await apiFetch(`/api/cli/devices/${config.deviceId}`, {
      method: "PATCH",
      token: config.token,
      body: JSON.stringify({ name: hostname() }),
    });
  } catch {
    // `clawdgg devices rename` is the manual path.
  }
}

const DEVICE_POLL_INTERVAL_MS = 5_000;
const DEVICE_MAX_WAIT_MS = 10 * 60 * 1000;
/** Consecutive network failures tolerated while polling before we give up. */
const DEVICE_MAX_POLL_FAILURES = 5;

async function startDeviceFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
}> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await apiFetch("/auth/device", { method: "POST", body: "{}" });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  throw new Error(`Could not reach ${API_BASE_URL} to start login (${lastError})`);
}

async function initiateLogin(): Promise<Config> {
  const { deviceCode, userCode, verificationUrl, expiresIn } = await startDeviceFlow();

  log.title("Let's link your GitHub");
  console.log(`${colors.bright}Your code:${colors.reset} ${colors.yellow}${userCode}${colors.reset}`);
  console.log(`\n${colors.dim}Opening${colors.reset} ${colors.cyan}${verificationUrl}${colors.reset}\n`);
  log.dim("Browser didn't open? Copy the URL above.");

  const openCmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([openCmd, verificationUrl], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No browser (headless, container). The URL is on screen.
  }

  log.info("Waiting for you to authorize...");
  const deadline = Date.now() + Math.min(expiresIn * 1000 || DEVICE_MAX_WAIT_MS, DEVICE_MAX_WAIT_MS);
  let failures = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DEVICE_POLL_INTERVAL_MS));

    let response: Response;
    try {
      response = await apiFetch("/auth/device/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode }),
      });
    } catch (error) {
      // A dropped connection mid-flow shouldn't abandon a login the user is
      // halfway through authorizing in the browser.
      if (++failures > DEVICE_MAX_POLL_FAILURES) {
        throw new Error(`Lost contact with ${API_BASE_URL} while waiting (${error})`);
      }
      continue;
    }
    failures = 0;

    if (response.ok) {
      const { token, userId, username } = await response.json();
      const previous = await loadConfig();
      const config: Config = {
        ...previous,
        token,
        userId,
        username,
        deviceId: deviceTokenId(token) ?? undefined,
        // Pinned here, checked on every read: this token is for this server.
        apiOrigin: API_BASE_URL,
      };
      await saveConfig(config);
      // A fresh token means whatever we recorded as revoked is history.
      await clearTokenRevoked();
      await nameThisDevice(config);
      log.success(`Linked! Welcome, ${colors.bright}${username}${colors.reset}`);
      log.dim("    This machine has its own token — logging in elsewhere leaves it alone.");
      return config;
    }

    // 428 = still waiting on the browser.
    if (response.status !== 428) {
      throw new Error(`Authentication failed: ${await response.text()}`);
    }
  }

  throw new Error("Authentication timed out — run `clawdgg login` to try again.");
}

/** Return a config with a server-verified token, logging in if needed. */
async function requireLogin(): Promise<{ config: Config; profile: ProfileData | null }> {
  let config = await loadConfig();

  if (config.token) {
    const profile = await fetchProfile(config.token);
    if (profile) return { config, profile };
    log.warn("Your saved token is no longer valid — re-authenticating.");
  }

  config = await initiateLogin();
  return { config, profile: config.token ? await fetchProfile(config.token) : null };
}

// ============= CONSENT =============

/**
 * Everything clawd.gg stores, and nothing it doesn't.
 *
 * This list is the contract. It is written against the columns the ingest path
 * actually writes (src/routes/otel.ts), not against what we'd prefer to admit
 * to — including the parts a user would be surprised by, which is exactly why
 * the names section exists. If a column is added there, it belongs here on the
 * same commit.
 */
function showConsent(): void {
  const plus = `  ${colors.green}+${colors.reset}`;
  const minus = `  ${colors.red}-${colors.reset}`;
  const dim = (text: string) => `${colors.dim}${text}${colors.reset}`;

  console.log(`${colors.bright}What we store — the numbers${colors.reset}`);
  console.log(`${plus} timestamps and session ids`);
  console.log(`${plus} which model ran, and token counts ${dim("(input / output / cache read / cache write)")}`);
  console.log(`${plus} cost ${dim("— the API-equivalent price Claude Code computes, not what you pay")}`);
  console.log(`${plus} how long each prompt was ${dim("— the character count, never the text")}`);
  console.log(`${plus} which tools ran, whether each succeeded, and how long it took`);
  console.log(`${plus} lines added/removed, commits, PRs, and active time`);
  console.log(`${plus} your Pro/Max limit percentages ${dim("(5h / 7d), via the status line")}`);
  console.log(`${plus} whether a prompt said "ultrathink" ${dim("— a local hook checks each prompt for the word 'ultrathink'; only a yes/no leaves your machine")}`);
  console.log();
  console.log(`${colors.bright}What we store — the names ${dim("(read this part)")}${colors.reset}`);
  console.log(`${plus} your Anthropic ${colors.bright}account id${colors.reset} and ${colors.bright}organization id${colors.reset}`);
  console.log(`${plus} tool names, and the names of agents, skills and plugins you run`);
  console.log(`${plus} ${colors.bright}MCP server and MCP tool names${colors.reset} ${dim("— these can name internal systems")}`);
  console.log(`${plus} slash command names ${dim("— a custom command's name, not its content")}`);
  console.log(`${plus} the language of files you edit, and whether you accepted each edit`);
  console.log(`${plus} your Claude Code version and terminal`);
  console.log(`${plus} error messages ${dim("— with absolute file paths stripped out server-side")}`);
  console.log();
  console.log(`${colors.bright}What never leaves your machine${colors.reset}`);
  console.log(`${minus} your prompts ${dim("(we store the length, never the words)")}`);
  console.log(`${minus} Claude's responses`);
  console.log(`${minus} tool parameters ${dim("— no command lines, no file paths, no arguments")}`);
  console.log(`${minus} file contents, code, diffs`);
  console.log(`${minus} environment variables, secrets`);
  console.log();
  console.log(dim("Importing your history sends the same fields, nothing more."));
  console.log(dim("This turns on Claude Code telemetry globally (~/.claude/settings.json)."));
  console.log(`${dim("Undo any time with")} ${colors.cyan}clawdgg disable${colors.reset}${dim(" — which also restores whatever")}`);
  console.log(dim("OpenTelemetry settings you had before. It stops the stream; it does not"));
  console.log(dim("delete what is already on clawd.gg. Ask us and we will."));
  console.log();
}

// ============= SETTINGS.JSON =============

interface SettingsWriteResult {
  originals: OtelOriginals;
  backup: string | null;
  statusLine: StatusLineMergeResult;
  promptHook: PromptHookMergeResult;
  removedStaticHeaders: string[];
  unchanged: boolean;
}

/**
 * Point Claude Code at clawd.gg. Aborts rather than overwrite a settings.json
 * we can't parse, backs it up before writing, and asks before touching any
 * OTEL value it does not recognise as ours.
 */
async function writeOtelSettings(
  argv: string[],
  assumeYes: boolean
): Promise<SettingsWriteResult | null> {
  const helperCommand = buildHelperCommand(argv);
  const desired = desiredOtelEnv(API_BASE_URL);

  let loaded: Awaited<ReturnType<typeof loadSettings>>;
  try {
    loaded = await loadSettings(CLAUDE_SETTINGS_PATH);
  } catch (error) {
    if (error instanceof SettingsParseError) {
      log.error(error.message);
      return null;
    }
    throw error;
  }

  const plan = planOtelSettings(loaded.settings, desired, helperCommand, API_BASE_URL);

  if (plan.unmanaged.length > 0) {
    log.dim(`Leaving your other OTEL settings alone: ${plan.unmanaged.join(", ")}`);
  }

  // An admin-pinned OTEL key wins over anything we write, so say so before the
  // user spends a consent on a change that will have no effect.
  const managed = await detectManagedSettings();
  if (managed.length > 0) {
    log.warn("Your machine has enterprise managed settings that pin OpenTelemetry:");
    for (const entry of managed) {
      console.log(`    ${colors.dim}${entry.key}${colors.reset} = ${entry.value}`);
      log.dim(`      from ${entry.path}`);
    }
    console.log();
    log.dim("Those override ~/.claude/settings.json, so our block may be ignored.");
    if (!(await confirm("Configure settings.json anyway?", assumeYes))) {
      log.info("Left your settings.json alone.");
      return null;
    }
    console.log();
  }

  // Only a value that is NOT ours needs consent. Keys we don't manage are
  // never touched, so listing them is a note, not a question.
  if (plan.conflicts.length > 0) {
    log.warn("Your settings.json already points OpenTelemetry somewhere else:");
    for (const c of plan.conflicts) {
      console.log(`    ${colors.dim}${c.key}${colors.reset} = ${c.current}`);
      console.log(`      ${colors.dim}→ would become${colors.reset} ${c.next}`);
      if (c.kind === "signal-specific") {
        log.dim("      (a per-signal override beats the generic endpoint, so it has to go)");
      }
      if (c.kind === "static-header") {
        log.dim("      (we won't send our Authorization header to someone else's collector)");
      }
    }
    console.log();
    log.dim("Claude Code can only export to one endpoint, so this replaces yours.");
    log.dim("We'll remember these values and put them back on `clawdgg disable`.");
    console.log();
    if (!(await confirm("Replace them with clawd.gg?", assumeYes))) {
      log.info("Left your settings.json alone.");
      return null;
    }
  }

  const backup = await backupSettings(CLAUDE_SETTINGS_PATH);
  const originals = applyOtelSettings(loaded.settings, desired, helperCommand, {
    apiBaseUrl: API_BASE_URL,
    replaceForeign: plan.conflicts.length > 0,
  });
  const statusLine = applyStatusLineSetting(loaded.settings, buildStatusLineCommand(argv));
  const promptHook = applyPromptHookSetting(loaded.settings, buildPromptHookCommand(argv));

  await mkdir(settingsDir(loaded.path), { recursive: true });
  await writeSettingsAtomic(loaded.path, loaded.settings);

  return {
    originals,
    backup,
    statusLine,
    promptHook,
    removedStaticHeaders: plan.staticHeaders,
    unchanged: plan.unchanged,
  };
}

/**
 * Take our block back out of settings.json. Shared by `disable` and `logout`,
 * because leaving a block that authenticates with a revoked token in place
 * would make Claude Code warn on every start.
 *
 * Backs up first — every write does — and reports what it chose to leave.
 */
async function removeOtelSettings(
  originals: OtelOriginals | undefined
): Promise<{
  existed: boolean;
  outcome: ReturnType<typeof restoreOtelSettings>;
  statusLine: ReturnType<typeof removeStatusLineSetting>;
  promptHook: ReturnType<typeof removePromptHookSetting>;
} | null> {
  const loaded = await loadSettings(CLAUDE_SETTINGS_PATH);
  if (!loaded.exists) {
    return {
      existed: false,
      outcome: { removed: [], restored: [], leftAlone: [] },
      statusLine: "absent",
      promptHook: "absent",
    };
  }

  const statusLine = removeStatusLineSetting(loaded.settings);
  const promptHook = removePromptHookSetting(loaded.settings);
  const outcome = restoreOtelSettings(loaded.settings, originals, {
    apiBaseUrl: API_BASE_URL,
    desired: desiredOtelEnv(API_BASE_URL),
  });

  // Nothing of ours in there: do not rewrite the file at all. `clawdgg logout`
  // on a machine we never set up must leave the user's own collector untouched,
  // down to the file's mtime.
  if (
    outcome.removed.length === 0 &&
    outcome.restored.length === 0 &&
    statusLine !== "removed" &&
    promptHook !== "removed"
  ) {
    return { existed: true, outcome, statusLine, promptHook };
  }

  await backupSettings(CLAUDE_SETTINGS_PATH);
  await writeSettingsAtomic(loaded.path, loaded.settings);
  return { existed: true, outcome, statusLine, promptHook };
}

// Report what happened to the user's statusLine. We never replace one we
// didn't write, so a conflict gets instructions instead of a silent overwrite.
function reportStatusLineMerge(result: StatusLineMergeResult, command: string): void {
  if (result.action === "already-ours") return;

  if (result.action === "added") {
    log.success("Status line registered — your plan limits (5h / 7d) sync too.");
    return;
  }

  log.warn("You already have a status line configured, so we left it alone:");
  log.dim(`    ${result.existing}`);
  console.log();
  console.log(`  ${colors.dim}To sync plan usage too, call${colors.reset} ${colors.cyan}${command} statusline${colors.reset} ${colors.dim}from your own`);
  console.log(`  status line, or set${colors.reset} ${colors.cyan}"statusLine": { "type": "command", "command": "${command} statusline" }${colors.reset}`);
  console.log(`  ${colors.dim}in ${CLAUDE_SETTINGS_PATH}.${colors.reset}`);
  console.log();
}

/**
 * Say what happened to the prompt hook.
 *
 * Unlike the status line there is no conflict case: hooks are a list, so ours
 * runs alongside anyone else's. The only thing that can go wrong is a
 * `hooks.UserPromptSubmit` we do not recognise the shape of, which we refuse to
 * reshape — guessing at someone's hook configuration is how one gets destroyed.
 */
function reportPromptHookMerge(result: PromptHookMergeResult, command: string): void {
  if (result.action === "already-ours") return;

  if (result.action === "added") {
    log.success("Ultrathink counter registered — a local hook, checking for one word.");
    log.dim("    It prints nothing, blocks nothing, and sends only yes or no.");
    return;
  }

  log.warn("Your settings.json has a hooks.UserPromptSubmit we don't recognise,");
  log.dim("    so we left it alone and the ultrathink counter is off.");
  console.log();
  console.log(`  ${colors.dim}To turn it on, add${colors.reset} ${colors.cyan}{ "type": "command", "command": "${command} prompt-hook" }${colors.reset}`);
  console.log(`  ${colors.dim}to that hook's own list in ${CLAUDE_SETTINGS_PATH}.${colors.reset}`);
  console.log();
}

/**
 * Tell the server which wall clock this machine keeps.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is the zone the OS is set
 * to — the same one Claude Code's own timestamps are shown in — so it needs no
 * question put to the user. The server validates it against the IANA database
 * and keeps UTC if it does not recognise it.
 *
 * Returns the zone it managed to register, or null.
 */
async function reportTimezone(token: string | undefined): Promise<string | null> {
  if (!token) return null;

  let timezone: string;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (!timezone) return null;

  try {
    const response = await apiFetch("/api/me/timezone", {
      method: "PUT",
      token,
      body: JSON.stringify({ timezone }),
    });
    if (!response.ok) {
      log.dim(`Couldn't set your timezone (HTTP ${response.status}) — times will read in UTC.`);
      return null;
    }
    log.success(`Timezone set to ${timezone}.`);
    return timezone;
  } catch {
    log.dim("Couldn't set your timezone — times will read in UTC until you set it on the site.");
    return null;
  }
}

// ============= COMMANDS =============

async function cmdLogin(): Promise<void> {
  await initiateLogin();
}

interface SetupFlags {
  assumeYes: boolean;
  skipImport: boolean;
}

async function cmdSetup(flags: SetupFlags): Promise<void> {
  log.title("clawd.gg setup");

  // 1. Account
  const { config, profile } = await requireLogin();
  if (!config.token) {
    log.error("Login didn't complete. Run `clawdgg setup` again.");
    process.exit(1);
  }
  log.success(`Account: ${colors.cyan}@${profile?.username ?? config.username}${colors.reset}`);
  console.log();

  // 2. Consent — telemetry is global, so it is never implicit.
  showConsent();
  if (!(await confirm("Stream your Claude Code usage to clawd.gg?", flags.assumeYes))) {
    log.info("Nothing changed. Run `clawdgg setup` whenever you're ready.");
    process.exit(1);
  }
  console.log();

  // 3. settings.json
  const argv = selfArgv();
  const binaryCommand = selfCommand();
  const written = await writeOtelSettings(argv, flags.assumeYes);
  if (!written) process.exit(1);

  // First-recorded wins: a second `setup` would otherwise "remember" the
  // values we ourselves wrote, and `disable` would restore clawd.gg's own
  // exporter instead of whatever the user had before us.
  await saveConfig({
    ...config,
    consentAt: new Date().toISOString(),
    otelOriginals: config.otelOriginals ?? written.originals,
    ...(written.backup ? { settingsBackup: written.backup } : {}),
  });

  if (written.backup) log.dim(`Backed up your settings.json → ${written.backup}`);
  if (written.removedStaticHeaders.length > 0) {
    log.success("Removed the old static bearer token from settings.json.");
    log.dim("    Auth now runs through `clawdgg otel-headers`, so a revoked token");
    log.dim("    shows up as a Claude Code warning instead of silence.");
  }
  log.success(`Exporter configured → ${API_BASE_URL}/otel`);
  reportStatusLineMerge(written.statusLine, binaryCommand);
  reportPromptHookMerge(written.promptHook, binaryCommand);

  if (argv[0] !== INSTALLED_BINARY && !argv[0]?.startsWith("/")) {
    log.warn(`settings.json now calls \`${binaryCommand}\`, which only resolves here.`);
    log.dim("    Install the binary (curl -fsSL https://clawd.gg/install | sh) and re-run setup.");
  }

  // 4. Tell the server, so the dashboard knows to read OTEL data.
  try {
    const response = await apiFetch("/api/otel/enable", { method: "POST", token: config.token });
    if (!response.ok) log.warn(`Server didn't confirm OTEL enable (HTTP ${response.status}).`);
  } catch (error) {
    log.warn(`Couldn't tell the server you're streaming (${error}). \`clawdgg doctor\` will retry.`);
  }

  // 4b. And which clock to read the timestamps in. Every "when" on the profile
  // — peak hour, the weekday ring, this week — is wrong by the UTC offset
  // without it. Best-effort: a failure here costs an accurate peak hour, not a
  // working setup, and the zone is changeable on the site afterwards.
  await reportTimezone(config.token);

  // 5. History import (B2 adds the implementation).
  if (!flags.skipImport) {
    console.log();
    await offerImport(config, flags.assumeYes);
  }

  console.log();
  console.log(`  ${colors.yellow}${colors.bright}⚠  RESTART CLAUDE CODE${colors.reset}${colors.yellow} to start streaming${colors.reset}`);
  console.log();
  console.log(`  Then: ${colors.cyan}${colors.bright}clawd.gg/u/${profile?.username ?? config.username}${colors.reset}`);
  console.log();
}

/** Say what `restoreOtelSettings` decided — especially what it refused to touch. */
function reportRestore(outcome: ReturnType<typeof restoreOtelSettings>): void {
  if (outcome.removed.length > 0) {
    log.success("Removed our OTEL block from ~/.claude/settings.json.");
  }
  if (outcome.restored.length > 0) {
    log.success(`Restored the OTEL values you had before: ${outcome.restored.join(", ")}`);
  }
  if (outcome.leftAlone.length > 0) {
    log.dim(`Left alone (not ours, or changed since): ${outcome.leftAlone.join(", ")}`);
  }
  if (
    outcome.removed.length === 0 &&
    outcome.restored.length === 0 &&
    outcome.leftAlone.length === 0
  ) {
    log.info("Nothing of ours was in ~/.claude/settings.json.");
  }
}

async function cmdDisable(purge: boolean): Promise<void> {
  log.title("Turning off streaming");

  const config = await loadConfig();

  try {
    const result = await removeOtelSettings(config.otelOriginals);
    if (!result?.existed) {
      log.info("No ~/.claude/settings.json — nothing to undo there.");
    } else {
      reportRestore(result.outcome);
      if (result.statusLine === "removed") log.success("Status line hook removed.");
      if (result.statusLine === "not-ours") log.dim("Left your own status line alone.");
      if (result.promptHook === "removed") log.success("Ultrathink prompt hook removed.");
    }
  } catch (error) {
    if (error instanceof SettingsParseError) {
      log.error(error.message);
      log.warn("Telemetry may still be configured. Fix that file and re-run `clawdgg disable`.");
    } else {
      throw error;
    }
  }

  if (config.token) {
    try {
      await apiFetch("/api/otel/disable", { method: "POST", token: config.token });
    } catch {
      // The local side is what stops the data flowing.
    }
  }

  if (purge) {
    await rm(CONFIG_DIR, { recursive: true, force: true });
    log.success(`Deleted ${CONFIG_DIR}.`);
  } else {
    const { otelOriginals, settingsBackup, consentAt, ...keep } = config;
    await saveConfig(keep);
    log.dim(`Kept your login in ${CONFIG_FILE} (clawdgg disable --purge removes it).`);
  }

  console.log();
  log.dim("Restart Claude Code for this to take effect.");
  log.dim("Your stats already on clawd.gg stay there.");
  console.log();
}

async function cmdLogout(): Promise<void> {
  log.title("Logging out");

  const config = await loadConfig();
  if (!config.token) {
    log.info("You weren't logged in.");
    return;
  }

  try {
    const response = await apiFetch("/api/cli/logout", { method: "POST", token: config.token });
    if (response.ok) {
      const result = (await response.json()) as { revokedAllDevices?: boolean };
      if (result.revokedAllDevices) {
        // Only a pre-2.0 token lands here: it has no device row, so the sole
        // lever is the per-user generation bump.
        log.success("Token revoked server-side.");
        log.warn("That was a pre-2.0 token, which can only be revoked for every machine");
        log.dim("    at once — so any other clawdgg login is logged out too. Re-run");
        log.dim("    `clawdgg login` on each machine to get per-device tokens.");
      } else {
        log.success("This device's token is revoked. Your other machines keep streaming.");
        log.dim("    `clawdgg devices revoke --all` is the log-out-everywhere button.");
      }
    } else if (response.status === 401) {
      log.dim("Server already considered that token invalid.");
    } else {
      log.warn(`Server returned HTTP ${response.status} — revoke may not have applied.`);
    }
  } catch (error) {
    log.warn(`Couldn't reach the server to revoke (${error}).`);
    log.dim("    Clearing local credentials anyway.");
  }

  // Our settings.json block authenticates with the token we just revoked, so
  // leaving it in place would make Claude Code warn on every start. Anything
  // that isn't ours stays — including on a machine we never set up, where this
  // must not touch the user's own collector at all.
  try {
    const result = await removeOtelSettings(config.otelOriginals);
    if (result?.existed) reportRestore(result.outcome);
  } catch (error) {
    if (error instanceof SettingsParseError) {
      log.warn(`Left ~/.claude/settings.json alone: ${error.message}`);
    } else {
      throw error;
    }
  }

  await saveConfig({});
  await clearTokenRevoked();
  log.success("Local credentials cleared.");
  console.log();
}

/** Prints the Authorization header for Claude Code's OTLP exporter. */
async function cmdOtelHeaders(): Promise<void> {
  const config = await loadConfig();
  if (!isWellFormedToken(config.token)) {
    process.stderr.write(`${MISSING_TOKEN_MESSAGE}\n`);
    process.exit(1);
  }
  // A token the server has already refused must FAIL here rather than be
  // handed to the exporter, which would 401 every batch without telling anyone.
  if (await isTokenRevoked(config.token)) {
    process.stderr.write(`${REVOKED_TOKEN_MESSAGE}\n`);
    process.exit(1);
  }
  process.stdout.write(otelHeadersLine(config.token));
}

// ============= DEVICES =============

interface DeviceRow {
  id: string;
  name: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

async function fetchDevices(
  token: string
): Promise<{ devices: DeviceRow[]; currentDeviceId: string | null }> {
  const response = await apiFetch("/api/cli/devices", { token });
  if (response.status === 401) {
    await markTokenRevoked(token);
    throw new Error("Server rejected your token — run `clawdgg login`.");
  }
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  return (await response.json()) as { devices: DeviceRow[]; currentDeviceId: string | null };
}

async function cmdDevices(args: string[]): Promise<void> {
  const config = await loadConfig();
  if (!config.token) {
    log.error("Not logged in. Run `clawdgg login` first.");
    process.exit(1);
  }

  const sub = args[0];

  if (sub === "revoke") {
    await revokeDevice(config, args.slice(1));
    return;
  }
  if (sub === "rename") {
    await renameDevice(config, args.slice(1));
    return;
  }
  if (sub && sub !== "list") {
    log.error(`Unknown: clawdgg devices ${sub}`);
    log.dim("    clawdgg devices [list] | revoke <id|--all> | rename <id> <name>");
    process.exit(1);
  }

  log.title("Your devices");
  const { devices, currentDeviceId } = await fetchDevices(config.token);
  const current = currentDeviceId ?? config.deviceId ?? null;

  if (devices.length === 0) {
    log.info("No per-device tokens on record.");
    if (!isDeviceToken(config.token)) {
      log.dim("    You're on a pre-2.0 token, which isn't tied to a machine.");
      log.dim("    Run `clawdgg login` to upgrade it to a revocable one.");
    }
    console.log();
    return;
  }

  for (const device of devices) {
    const here = device.id === current;
    const label = `${device.name}${here ? `  ${colors.cyan}(this machine)${colors.reset}` : ""}`;
    if (device.revokedAt) {
      log.dim(`✗ ${device.name}  (revoked ${describeAge(device.revokedAt)})`);
    } else {
      console.log(`${colors.green}•${colors.reset} ${label}`);
    }
    const seen = device.lastUsedAt ? `last used ${describeAge(device.lastUsedAt)}` : "never used";
    const added = device.createdAt ? `added ${describeAge(device.createdAt)}` : "";
    log.dim(`    ${device.id}  ${colors.dim}·${colors.reset} ${seen}${added ? ` · ${added}` : ""}`);
  }

  console.log();
  log.dim("Revoke one:  clawdgg devices revoke <id>");
  log.dim("Revoke all:  clawdgg devices revoke --all   (logs out every machine)");
  console.log();
}

async function revokeDevice(config: Config, args: string[]): Promise<void> {
  const token = config.token!;
  const all = args.includes("--all");
  const id = args.find((a) => !a.startsWith("-"));

  if (!all && !id) {
    log.error("Which device? `clawdgg devices revoke <id>` or `--all`.");
    process.exit(1);
  }

  const body = all ? { all: true } : { id };
  const response = await apiFetch("/api/cli/devices/revoke", {
    method: "POST",
    token,
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    await markTokenRevoked(token);
    log.error("Server rejected your token — run `clawdgg login`.");
    process.exit(1);
  }
  if (!response.ok) {
    log.error(`Revoke failed (HTTP ${response.status}): ${await response.text()}`);
    process.exit(1);
  }

  const result = (await response.json()) as { revoked?: number; wasCurrentDevice?: boolean };

  if (all) {
    log.success(`Revoked ${result.revoked ?? 0} device token(s) — every machine is logged out.`);
    await forgetLocalCredentials();
  } else if (result.wasCurrentDevice) {
    log.success("Revoked this machine's token.");
    await forgetLocalCredentials();
  } else {
    log.success(`Revoked ${id}.`);
    log.dim("    That machine stops streaming at its next Claude Code start.");
  }
  console.log();
}

async function renameDevice(config: Config, args: string[]): Promise<void> {
  const [id, ...rest] = args;
  const name = rest.join(" ").trim();
  if (!id || !name) {
    log.error("Usage: clawdgg devices rename <id> <name>");
    process.exit(1);
  }

  const response = await apiFetch(`/api/cli/devices/${id}`, {
    method: "PATCH",
    token: config.token!,
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    log.error(`Rename failed (HTTP ${response.status}): ${await response.text()}`);
    process.exit(1);
  }
  log.success(`Renamed to ${name}.`);
  console.log();
}

/** Drop the local token after we revoked the credential it names. */
async function forgetLocalCredentials(): Promise<void> {
  const { token, deviceId, ...keep } = await loadConfig();
  await saveConfig(keep);
  await clearTokenRevoked();
  log.dim(`    Cleared the token in ${CONFIG_FILE}. Run \`clawdgg login\` to come back.`);
}

// ============= STATUS =============

const BADGE_EMOJIS: Record<string, string> = {
  night_owl: '🦉',
  early_bird: '🐦',
  on_fire: '🔥',
  streak_7: '⚡',
  streak_30: '💪',
  messages_1k: '💬',
  messages_5k: '🗣️',
  messages_10k: '🤖',
  tools_1k: '🛠️',
  tools_5k: '⚙️',
  marathon: '🏃',
  og: '👑',
};

function fmt(n: number): string {
  return n.toLocaleString();
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toString();
}

/**
 * Terminal columns a string occupies. Emoji are a code point each but render
 * two columns wide, which is what throws the ASCII box off if you use .length.
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    // 0x2600 and up: misc symbols, dingbats, CJK, emoji — all double-width.
    // Box-drawing (0x2500–0x257F) stays below the line, which is what we want.
    width += (char.codePointAt(0) ?? 0) >= 0x2600 ? 2 : 1;
  }
  return width;
}

function formatCost(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}K`;
  if (dollars >= 1) return `$${dollars.toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();

  if (!config.token) {
    log.title("clawd.gg");
    log.info("Not linked yet.");
    log.dim("Run `clawdgg setup` to join the leaderboard.");
    console.log();
    return;
  }

  const profile = await fetchProfile(config.token);
  if (!profile) {
    log.title("clawd.gg");
    log.error("Couldn't load your profile — token invalid, or the server is down.");
    log.dim("Run `clawdgg doctor` to find out which.");
    console.log();
    return;
  }

  const boxWidth = 56;
  const innerWidth = boxWidth - 4;
  const centered = (text: string, render: string = text) => {
    const width = displayWidth(text);
    const left = Math.max(0, Math.floor((innerWidth - width) / 2));
    const right = Math.max(0, innerWidth - left - width);
    console.log(`${colors.dim}│${colors.reset}${' '.repeat(left)}${render}${' '.repeat(right)}${colors.dim}│${colors.reset}`);
  };
  const blank = () =>
    console.log(`${colors.dim}│${colors.reset}${' '.repeat(innerWidth)}${colors.dim}│${colors.reset}`);
  const row = (left: string, render: string) =>
    console.log(`${colors.dim}│${colors.reset}  ${render}${' '.repeat(Math.max(0, innerWidth - 2 - displayWidth(left)))}${colors.dim}│${colors.reset}`);
  const statLine = (label: string, value: string, color: string = colors.white) => {
    const pad = ' '.repeat(Math.max(1, 20 - label.length));
    row(
      `${label}${pad}${value}`,
      `${colors.dim}${label}${colors.reset}${pad}${color}${value}${colors.reset}`
    );
  };

  // Celebrations: anything that changed since the last `status`.
  const celebrations: string[] = [];
  if (profile.rank === 1 && config.lastKnownRank !== 1) celebrations.push(`👑 YOU'RE #1`);
  const lastBadges = new Set(config.lastKnownBadges || []);
  const newBadge = profile.badges.find((b) => !lastBadges.has(b));
  if (newBadge) {
    const emoji = BADGE_EMOJIS[newBadge];
    celebrations.push(`NEW BADGE: ${emoji ? `${emoji} ` : ''}${newBadge.replace(/_/g, ' ')}`);
  }
  if (
    config.lastKnownLongestStreak !== undefined &&
    profile.currentStreak > config.lastKnownLongestStreak &&
    profile.currentStreak > 1
  ) {
    celebrations.push(`🔥 ${profile.currentStreak} DAY STREAK`);
  }

  await saveConfig({
    ...config,
    lastKnownBadges: profile.badges,
    lastKnownRank: profile.rank,
    lastKnownLongestStreak: Math.max(profile.currentStreak, config.lastKnownLongestStreak || 0),
  });

  console.log();
  console.log(`${colors.dim}┌${'─'.repeat(boxWidth - 2)}┐${colors.reset}`);
  if (celebrations.length > 0) {
    for (const celebration of celebrations) {
      row(celebration, `${colors.bright}${colors.yellow}${celebration}${colors.reset}`);
    }
    console.log(`${colors.dim}├${'─'.repeat(boxWidth - 2)}┤${colors.reset}`);
  }

  const archetype = (profile.archetype || 'Claude Code User').toUpperCase();
  centered(archetype, `${colors.cyan}${colors.bright}${archetype}${colors.reset}`);
  if (profile.archetypeDescription) {
    centered(profile.archetypeDescription, `${colors.dim}${profile.archetypeDescription}${colors.reset}`);
  }
  blank();

  const costDisplay = formatCost(profile.totalCostCents);
  const costLine = `${costDisplay} invested in Claude`;
  centered(costLine, `${colors.bright}${costDisplay}${colors.reset} ${colors.dim}invested in Claude${colors.reset}`);
  blank();

  const rankLine = `#${profile.rank} of ${fmt(profile.totalUsers)}`;
  const percentile = profile.percentile < 1 ? `Top ${profile.percentile}%` : `Top ${Math.round(profile.percentile)}%`;
  centered(
    `${rankLine}  •  ${percentile}`,
    `${colors.yellow}${rankLine}${colors.reset}  ${colors.dim}•${colors.reset}  ${colors.green}${percentile}${colors.reset}`
  );

  console.log(`${colors.dim}├${'─'.repeat(boxWidth - 2)}┤${colors.reset}`);
  blank();
  statLine('Tokens', formatTokens(profile.totalTokens), colors.yellow);
  statLine('Prompts', fmt(profile.totalPrompts), colors.cyan);
  statLine('Lines Written', fmt(profile.totalLines), colors.green);
  statLine('Commits', fmt(profile.totalCommits), colors.magenta);
  if (profile.outputLeverage > 0) statLine('Output Leverage', `${profile.outputLeverage}x`, colors.dim);
  if (profile.currentStreak > 0) statLine('Streak', `🔥 ${profile.currentStreak} days`, colors.yellow);
  blank();
  statLine('Profile', `clawd.gg/u/${profile.username}`, colors.dim);
  console.log(`${colors.dim}└${'─'.repeat(boxWidth - 2)}┘${colors.reset}`);
  console.log();
}

// ============= DOCTOR =============

type CheckStatus = "ok" | "warn" | "fail";

interface Check {
  status: CheckStatus;
  label: string;
  detail?: string;
  fix?: string;
}

function renderChecks(checks: Check[]): CheckStatus {
  let worst: CheckStatus = "ok";
  for (const check of checks) {
    if (check.status === "fail") worst = "fail";
    else if (check.status === "warn" && worst === "ok") worst = "warn";

    if (check.status === "ok") log.success(check.label);
    else if (check.status === "warn") log.warn(check.label);
    else log.error(check.label);

    if (check.detail) log.dim(`    ${check.detail}`);
    if (check.fix) console.log(`    ${colors.dim}→${colors.reset} ${colors.cyan}${check.fix}${colors.reset}`);
  }
  return worst;
}

/**
 * Run the configured helper command exactly as Claude Code would.
 *
 * Hard timeout: the command comes out of settings.json, so it is whatever is in
 * that file — possibly an interactive prompt, or something that waits on a
 * network it cannot reach. `doctor` must always finish and report.
 */
const PROBE_TIMEOUT_MS = 5_000;

async function probeHelper(command: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    let timedOut = false;
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited.then((code) => {
        timedOut = proc.signalCode === "SIGKILL";
        return code;
      }),
    ]).finally(() => clearTimeout(timer));

    if (timedOut) {
      return { ok: false, detail: `no output after ${PROBE_TIMEOUT_MS / 1000}s — killed it` };
    }
    if (exitCode !== 0) {
      return { ok: false, detail: `exit ${exitCode}: ${stderr.trim() || "(no output)"}` };
    }
    const parsed = JSON.parse(stdout);
    const auth = parsed?.Authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      return { ok: false, detail: "stdout had no Authorization: Bearer header" };
    }
    return { ok: true, detail: `returned a Bearer header (${auth.length} chars)` };
  } catch (error) {
    return { ok: false, detail: `${error}` };
  }
}

function describeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Read-only health check. Never migrates config, never writes settings — it
 * exists to tell the user WHY data stopped arriving, and `clawdgg setup` is
 * the only thing that changes state.
 */
async function cmdDoctor(): Promise<void> {
  log.title("Health check");

  const checks: Check[] = [];
  const config = await loadConfig();
  const argv = selfArgv();
  const binaryCommand = selfCommand();

  // 0. An ignored CLAWDGG_API_URL is worth saying out loud — otherwise "I set
  // the env var and it still talks to clawd.gg" looks like a bug.
  if (API_URL_RESOLUTION.rejected) {
    checks.push({
      status: "warn",
      label: `Ignoring CLAWDGG_API_URL=${API_URL_RESOLUTION.rejected.value}`,
      detail: API_URL_RESOLUTION.rejected.reason,
    });
  }

  // 1. Where we're running from.
  if (argv[0] === INSTALLED_BINARY && argv.length === 1) {
    checks.push({ status: "ok", label: `Binary: ${binaryCommand}` });
  } else if (argv.length === 1 && argv[0]?.startsWith("/")) {
    checks.push({ status: "ok", label: `Binary: ${binaryCommand}`, detail: "not the standard install path, but absolute" });
  } else {
    checks.push({
      status: "warn",
      label: `Running from source: ${binaryCommand}`,
      detail: "settings.json hooks registered from here only work while this checkout exists",
      fix: "curl -fsSL https://clawd.gg/install | sh",
    });
  }

  // 2. Local credentials.
  if (tokenOriginMismatch) {
    checks.push({
      status: "fail",
      label: `Your token was issued by ${tokenOriginMismatch}, not ${API_BASE_URL}`,
      detail: "withheld — a bearer token is a credential for one server only",
      fix: `clawdgg login`,
    });
  }

  if (!isWellFormedToken(config.token)) {
    checks.push({
      status: "fail",
      label: "No local token",
      detail: `nothing usable in ${CONFIG_FILE}`,
      fix: "clawdgg login",
    });
  } else {
    checks.push({ status: "ok", label: `Logged in as @${config.username ?? "?"}` });

    if (!isDeviceToken(config.token)) {
      checks.push({
        status: "warn",
        label: "Pre-2.0 token — re-login to upgrade",
        detail:
          "it still works, but it can only be revoked for every machine at once\n" +
          "    a per-device token is revocable on its own, and `clawdgg devices` lists it",
        fix: "clawdgg login",
      });
    }

    // The flag the statusLine hook and this command write on a 401 — the same
    // one `otel-headers` fails on.
    if (await isTokenRevoked(config.token)) {
      checks.push({
        status: "fail",
        label: "This device's token was revoked",
        detail: "`otel-headers` is failing on purpose, so Claude Code warns at startup",
        fix: "clawdgg login",
      });
    }
  }

  // 3. settings.json — parse, OTEL block, helper, status line.
  let settings: Record<string, any> | null = null;
  try {
    const loaded = await loadSettings(CLAUDE_SETTINGS_PATH);
    if (!loaded.exists) {
      checks.push({
        status: "fail",
        label: "~/.claude/settings.json not found",
        detail: "Claude Code isn't exporting anything",
        fix: "clawdgg setup",
      });
    } else {
      settings = loaded.settings;
      checks.push({ status: "ok", label: "~/.claude/settings.json parses" });
    }
  } catch (error) {
    checks.push({
      status: "fail",
      label: "~/.claude/settings.json is not valid JSON",
      detail: error instanceof SettingsParseError ? "fix that file before anything else" : `${error}`,
    });
  }

  if (settings) {
    const env: Record<string, any> = settings.env ?? {};
    const endpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "");
    if (env.CLAUDE_CODE_ENABLE_TELEMETRY !== "1") {
      checks.push({ status: "fail", label: "Telemetry is off (CLAUDE_CODE_ENABLE_TELEMETRY)", fix: "clawdgg setup" });
    } else if (!endpoint.startsWith(API_BASE_URL)) {
      checks.push({
        status: "warn",
        label: "Exporter points somewhere else",
        detail: endpoint || "(no OTEL_EXPORTER_OTLP_ENDPOINT)",
        fix: "clawdgg setup",
      });
    } else {
      checks.push({ status: "ok", label: `Exporter → ${endpoint}` });
    }

    if (typeof env.OTEL_EXPORTER_OTLP_HEADERS === "string") {
      checks.push({
        status: "warn",
        label: "A static bearer token is still in settings.json",
        detail: "that's the setup that died silently when tokens rotated",
        fix: "clawdgg setup",
      });
    }

    // A per-signal override beats the generic endpoint, so one of these means
    // that signal is not reaching us no matter what else looks right.
    const signalOverrides = SIGNAL_SPECIFIC_KEYS.filter((key) => env[key] !== undefined);
    if (signalOverrides.length > 0) {
      checks.push({
        status: "warn",
        label: "Per-signal OTEL overrides take precedence over our endpoint",
        detail: signalOverrides.map((key) => `${key}=${env[key]}`).join("\n    "),
        fix: "clawdgg setup",
      });
    }

    const helper = settings.otelHeadersHelper;
    if (typeof helper !== "string" || !isOurHelperCommand(helper)) {
      checks.push({
        status: typeof helper === "string" ? "warn" : "fail",
        label:
          typeof helper === "string"
            ? "otelHeadersHelper is someone else's"
            : "otelHeadersHelper is not configured",
        detail:
          typeof helper === "string"
            ? helper
            : "without it Claude Code sends no Authorization header at all",
        fix: "clawdgg setup",
      });
    } else {
      const expected = buildHelperCommand(argv);
      const probe = await probeHelper(helper);
      checks.push({
        status: probe.ok ? "ok" : "fail",
        label: probe.ok ? "otelHeadersHelper works" : "otelHeadersHelper failed",
        detail: `${helper} — ${probe.detail}`,
        fix: probe.ok ? undefined : "clawdgg login",
      });
      if (probe.ok && helper !== expected) {
        checks.push({
          status: "warn",
          label: "otelHeadersHelper points at a different binary than this one",
          detail: `settings.json: ${helper}\n    this run: ${expected}`,
        });
      }
    }

    // An enterprise-managed OTEL key silently wins over everything above.
    const managed = await detectManagedSettings();
    if (managed.length > 0) {
      checks.push({
        status: "warn",
        label: "Enterprise managed settings pin OpenTelemetry",
        detail: managed
          .map((entry) => `${entry.key}=${entry.value}  (${entry.path})`)
          .join("\n    "),
      });
    }

    const statusLineProbe = applyStatusLineSetting({ statusLine: settings.statusLine });
    if (statusLineProbe.action === "already-ours") {
      checks.push({ status: "ok", label: "Status line reports plan usage (5h / 7d)" });
    } else if (statusLineProbe.action === "conflict") {
      checks.push({
        status: "warn",
        label: "Status line is someone else's — plan usage isn't reporting",
        detail: statusLineProbe.existing,
      });
    } else {
      checks.push({ status: "warn", label: "No status line — plan usage isn't reporting", fix: "clawdgg setup" });
    }

    // The ultrathink counter. A missing hook is a warn, not a fail: nothing
    // else depends on it, and the number it feeds is simply absent without it.
    if (hasOurPromptHook(settings)) {
      checks.push({ status: "ok", label: 'Ultrathink counter registered (UserPromptSubmit)' });
    } else {
      checks.push({
        status: "warn",
        label: "No ultrathink counter — that number won't move",
        fix: "clawdgg setup",
      });
    }
  }

  // 4. Server side: is the token good, and is anything arriving?
  if (isWellFormedToken(config.token)) {
    try {
      const startedAt = Date.now();
      const response = await apiFetch("/api/cli/health", { token: config.token });
      const elapsed = Date.now() - startedAt;

      if (response.status === 401) {
        // Record it, so the next Claude Code start shows the warning too.
        await markTokenRevoked(config.token);
        checks.push({
          status: "fail",
          label: "Server rejected your token",
          detail: "revoked — `otel-headers` will now fail loudly instead of 401ing in silence",
          fix: "clawdgg login",
        });
      } else if (!response.ok) {
        checks.push({ status: "warn", label: `Server returned HTTP ${response.status}`, detail: `${API_BASE_URL}/api/cli/health` });
      } else {
        const health = (await response.json()) as {
          username?: string;
          otelEnabled?: boolean;
          lastLiveEventAt?: string | null;
          lastEventAt?: string | null;
          tokenKind?: string | null;
        };
        // The server accepted it, so whatever we had recorded as revoked is stale.
        await clearTokenRevoked();
        checks.push({ status: "ok", label: `Token valid (${elapsed}ms)` });

        if (health.otelEnabled === false) {
          checks.push({ status: "warn", label: "Server has you marked as not streaming", fix: "clawdgg setup" });
        }
        if (health.lastLiveEventAt) {
          const ageMs = Date.now() - new Date(health.lastLiveEventAt).getTime();
          const stale = ageMs > 7 * 24 * 60 * 60 * 1000;
          checks.push({
            status: stale ? "warn" : "ok",
            label: `Last live event: ${describeAge(health.lastLiveEventAt)}`,
            detail: stale ? "nothing in over a week — telemetry is probably not flowing" : undefined,
          });
        } else {
          checks.push({
            status: "warn",
            label: "The server has never received a live event from you",
            detail: "restart Claude Code after `clawdgg setup`, then use it once",
          });
        }
      }
    } catch (error) {
      checks.push({ status: "warn", label: `Cannot reach ${API_BASE_URL}`, detail: `${error}` });
    }
  }

  console.log();
  const worst = renderChecks(checks);
  console.log();

  if (worst === "ok") {
    log.dim("Everything checks out.");
  } else if (worst === "warn") {
    log.dim("Working, with caveats above.");
  } else {
    log.dim("Telemetry is NOT flowing. Fix the ✗ lines above.");
  }
  console.log();
  process.exit(worst === "fail" ? 1 : worst === "warn" ? 2 : 0);
}

// ============= IMPORT =============
//
// One-time backfill of everything that happened before telemetry was on. The
// mapping is the same code the server-side backfill script uses
// (src/lib/session-import.ts), so imported history and live data are counted
// the same way. Prompt text never leaves the machine — only its length.
//
// Only events go up. The server derives the token and cost metrics from them
// and prices every row itself, so nothing we compute about money is trusted —
// which is also why the preview above uses the server's formula, not ours.

/** Rows per request. The server caps at 20k; this leaves room for growth. */
const IMPORT_BATCH_ROWS = 5_000;

interface ImportBatchResult {
  accepted: number;
  inserted: number;
  rejected: number;
  skippedAfterCutoff: number;
  skippedBeforeEpoch: number;
  skippedBuiltinCommand: number;
  skippedCoveredDay: number;
  skippedDuplicate: number;
  clamped: number;
  cutoff: string;
  skippedDays: string[];
}

/**
 * The cost the server will compute for these rows.
 *
 * Deliberately NOT the mapper's own `cost_usd`: the server recomputes cost from
 * model + token counts (it does not trust a client's arithmetic about money).
 * Pricing the preview from exactly the fields we are about to upload — the
 * cache-creation total AND its 1h share — is what keeps "we'll upload $X" and
 * "clawd.gg says $X" the same number.
 */
function previewCostUsd(events: ImportEventRow[]): number {
  let total = 0;
  for (const event of events) {
    if (event.event_name !== "claude_code.api_request") continue;
    const cacheWrite = event.cache_write_tokens ?? 0;
    const cacheWrite1h = Math.min(event.cache_write_1h_tokens ?? 0, cacheWrite);
    total += computeCostUsd(event.model ?? "", {
      input_tokens: event.input_tokens ?? 0,
      output_tokens: event.output_tokens ?? 0,
      cache_read_input_tokens: event.cache_read_tokens ?? 0,
      cache_creation_input_tokens: cacheWrite,
      cache_creation: {
        ephemeral_1h_input_tokens: cacheWrite1h,
        ephemeral_5m_input_tokens: cacheWrite - cacheWrite1h,
      },
    }).costUsd;
  }
  return total;
}

async function findTranscripts(dir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(current: string): Promise<void> {
    // An unreadable directory is simply one we import nothing from.
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
    }
  }

  if (existsSync(dir)) await walk(dir);
  return found.sort();
}

/** Ask the server when telemetry started, so the import stops right before it. */
async function fetchImportCutoff(token: string): Promise<Date> {
  try {
    const response = await apiFetch("/api/cli/health", { token });
    if (response.ok) {
      const health = (await response.json()) as { otelSetupAt?: string | null };
      if (health.otelSetupAt) {
        const parsed = new Date(health.otelSetupAt);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
    }
  } catch {
    // Fall through: the server enforces its own cutoff regardless.
  }
  return new Date();
}

async function postImportBatch(
  token: string,
  batch: { events: unknown[]; runId: string }
): Promise<ImportBatchResult> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await apiFetch("/api/cli/import", {
      method: "POST",
      token,
      body: JSON.stringify(batch),
    });

    if (response.ok) return (await response.json()) as ImportBatchResult;

    // /api/* allows 60 requests a minute and a full history is more batches
    // than that, so being throttled is expected, not an error.
    if (response.status === 429) {
      const retryAfter = Math.min(Number(response.headers.get("Retry-After") ?? 10) || 10, 90);
      log.dim(`  rate limited — waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    throw new Error(`Import rejected (HTTP ${response.status}): ${await response.text()}`);
  }

  throw new Error("Gave up after repeated rate limiting — try again later.");
}

async function runLocalImport(config: Config, assumeYes: boolean): Promise<boolean> {
  const token = config.token;
  if (!token) {
    log.error("Not logged in. Run `clawdgg login` first.");
    return false;
  }

  const transcripts = await findTranscripts(CLAUDE_PROJECTS_DIR);
  if (transcripts.length === 0 && !existsSync(CLAUDE_HISTORY_PATH)) {
    log.info("No local Claude Code history found — nothing to import.");
    return true;
  }

  const cutoff = await fetchImportCutoff(token);
  log.dim(`Reading ${transcripts.length} transcript files (up to ${cutoff.toISOString()})`);

  const mapOptions = {
    userId: config.userId ?? "",
    provenance: "import" as const,
    excludeBuiltinSlashPrompts: true,
    to: cutoff,
  };

  // Only events are uploaded. The server derives the token and cost metrics
  // from them, so sending the mapper's metrics too would be the same numbers
  // twice — and one of two copies can disagree with the other.
  const events: ImportEventRow[] = [];
  // Rows whose transcript recorded no cache-TTL breakdown: those are the only
  // ones whose cache-write cost is a floor rather than a figure.
  let flatCacheRows = 0;

  for (const file of transcripts) {
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    const mapped = mapJsonlText(raw, { ...mapOptions, ...describeTranscriptPath(file) });
    events.push(...mapped.events);
    flatCacheRows += mapped.flatCacheFallbacks;
  }

  // history.jsonl outlives the transcripts (which rotate at ~60 days), so it
  // fills days the transcripts no longer cover — and only those days, or every
  // prompt in the overlap would be counted twice.
  let historyKept = 0;
  if (existsSync(CLAUDE_HISTORY_PATH)) {
    try {
      const history = mapHistoryText(await readFile(CLAUDE_HISTORY_PATH, "utf-8"), {
        userId: mapOptions.userId,
        provenance: "import",
        to: cutoff,
        slashPolicy: "drop-builtin",
      });
      const gaps = fillPromptGapsFromHistory(events, history.events);
      historyKept = gaps.events.length;
      events.push(...gaps.events);
      if (gaps.gapDays.length > 0) {
        log.dim(`history.jsonl fills ${gaps.gapDays.length} day(s) with no transcripts left`);
      }
    } catch (error) {
      log.warn(`Couldn't read ${CLAUDE_HISTORY_PATH} (${error}) — importing transcripts only.`);
    }
  }

  // Chronological, so one UTC day lands in as few batches as possible: the
  // server's double-count guard works a whole day at a time.
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const prompts = events.filter((e) => e.event_name === "claude_code.user_prompt").length;
  const apiRequests = events.filter((e) => e.event_name === "claude_code.api_request").length;
  const costUsd = previewCostUsd(events);
  const total = events.length;

  if (total === 0) {
    log.info("Nothing to import — your local history is all after telemetry started.");
    return true;
  }

  console.log();
  console.log(`  ${colors.bright}${prompts.toLocaleString()}${colors.reset} prompts  ${colors.dim}·${colors.reset}  ${colors.bright}${apiRequests.toLocaleString()}${colors.reset} API calls  ${colors.dim}·${colors.reset}  ${colors.bright}$${costUsd.toFixed(2)}${colors.reset} ${colors.dim}(estimated)${colors.reset}`);
  if (historyKept > 0) log.dim(`  ${historyKept.toLocaleString()} of those prompts come from history.jsonl`);
  if (flatCacheRows > 0) {
    log.dim(`  ${flatCacheRows.toLocaleString()} API calls recorded no cache-TTL split, so their cache-write cost is a floor`);
  }
  log.dim(`  ${total.toLocaleString()} rows to upload. Timestamps and counts only — no prompt text.`);
  console.log();

  if (!(await confirm("Upload this to clawd.gg?", assumeYes))) {
    log.info("Skipped. Run `clawdgg import` whenever you want.");
    return true;
  }

  const totals = {
    inserted: 0,
    rejected: 0,
    skippedAfterCutoff: 0,
    skippedCoveredDay: 0,
    skippedDuplicate: 0,
  };
  const skippedDays = new Set<string>();
  let sentRows = 0;

  // One id for the whole run. The server snapshots which days it already holds
  // when the first batch arrives and reuses that snapshot for the rest — the
  // alternative is batch 1 making its own day look "already counted" to batch 2.
  const runId = crypto.randomUUID();

  for (let i = 0; i < events.length; i += IMPORT_BATCH_ROWS) {
    const slice = events.slice(i, i + IMPORT_BATCH_ROWS);
    const result = await postImportBatch(token, { events: slice, runId });

    totals.inserted += result.inserted;
    totals.rejected += result.rejected;
    totals.skippedAfterCutoff += result.skippedAfterCutoff;
    totals.skippedCoveredDay += result.skippedCoveredDay;
    totals.skippedDuplicate += result.skippedDuplicate;
    for (const day of result.skippedDays ?? []) skippedDays.add(day);

    sentRows += slice.length;
    process.stdout.write(`\r  uploading… ${sentRows.toLocaleString()}/${total.toLocaleString()} rows`);
  }
  process.stdout.write("\r\x1b[K");

  log.success(`Imported ${totals.inserted.toLocaleString()} rows.`);
  if (totals.skippedCoveredDay > 0) {
    log.dim(`  ${totals.skippedCoveredDay.toLocaleString()} rows fell on ${skippedDays.size} day(s) already on record:`);
    const shown = [...skippedDays].sort();
    log.dim(`    ${shown.slice(0, 8).join(", ")}${shown.length > 8 ? ` … +${shown.length - 8} more` : ""}`);
    log.dim("    Those days were already counted, so importing them would double them.");
  }
  if (totals.skippedDuplicate > 0) {
    log.dim(`  ${totals.skippedDuplicate.toLocaleString()} were duplicates inside the upload itself.`);
  }
  if (totals.skippedAfterCutoff > 0) {
    log.dim(`  ${totals.skippedAfterCutoff.toLocaleString()} were after telemetry started — live data already has them.`);
  }
  if (totals.rejected > 0) {
    log.warn(`  ${totals.rejected.toLocaleString()} rows were rejected by the server.`);
  }

  await saveConfig({ ...(await loadConfig()), importedAt: new Date().toISOString() });
  return true;
}

async function offerImport(config: Config, assumeYes: boolean): Promise<void> {
  console.log(`${colors.bright}One last thing: your history so far${colors.reset}`);
  log.dim("Claude Code keeps local transcripts of everything before today. We can");
  log.dim("read them and send the same numbers telemetry would have — never the text.");
  console.log();

  try {
    await runLocalImport(config, assumeYes);
  } catch (error) {
    // Streaming is already configured; a failed import must not undo that.
    log.warn(`History import failed (${error instanceof Error ? error.message : error}).`);
    log.dim("    Streaming is on regardless. Retry any time with `clawdgg import`.");
  }
}

async function cmdImport(assumeYes: boolean): Promise<void> {
  log.title("Importing your history");

  const config = await loadConfig();
  if (!config.token) {
    log.error("Not logged in. Run `clawdgg login` first.");
    process.exit(1);
  }

  try {
    if (!(await runLocalImport(config, assumeYes))) process.exit(1);
  } catch (error) {
    log.error(`${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  console.log();
}

// ============= HELP =============

function showHelp(): void {
  console.log(`
${colors.bright}${colors.cyan}clawd.gg${colors.reset} ${colors.dim}— track your Claude Code usage${colors.reset}

${colors.bright}Quick start:${colors.reset}
  ${colors.cyan}clawdgg setup${colors.reset}   ${colors.dim}login, consent, enable streaming, import history${colors.reset}

${colors.bright}Commands:${colors.reset}
  ${colors.green}setup${colors.reset}         Do everything (alias: ${colors.green}gg${colors.reset})
  ${colors.green}status${colors.reset}        Your stats and rank
  ${colors.green}doctor${colors.reset}        Why isn't my data showing up?
  ${colors.green}import${colors.reset}        Backfill history from local Claude Code transcripts
  ${colors.green}login${colors.reset}         Link your GitHub account
  ${colors.green}logout${colors.reset}        Revoke THIS machine's token and clear local state
  ${colors.green}devices${colors.reset}       List your machines (${colors.dim}revoke <id>${colors.reset} / ${colors.dim}revoke --all${colors.reset} / ${colors.dim}rename${colors.reset})
  ${colors.green}disable${colors.reset}       Stop streaming (${colors.dim}--purge${colors.reset} also deletes ~/.config/clawdgg)
  ${colors.green}version${colors.reset}       Print the version

${colors.bright}Flags:${colors.reset}
  ${colors.dim}--yes${colors.reset}           Assume yes for every prompt (scripts, CI)
  ${colors.dim}--no-import${colors.reset}     Skip the history import during setup
  ${colors.dim}--purge${colors.reset}         With ${colors.dim}disable${colors.reset}: remove ~/.config/clawdgg too

${colors.dim}Run by Claude Code, not by you:${colors.reset}
  ${colors.dim}statusline${colors.reset}      Status line hook (reports your Pro/Max limits)
  ${colors.dim}otel-headers${colors.reset}    otelHeadersHelper (prints the Authorization header)

${colors.dim}Leaderboard: https://clawd.gg${colors.reset}
`);
}

// ============= MAIN =============

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const assumeYes = args.includes("--yes") || args.includes("-y");

  switch (command) {
    case "setup":
    case "gg":
      await cmdSetup({ assumeYes, skipImport: args.includes("--no-import") });
      break;
    case "import":
      await cmdImport(assumeYes);
      break;
    case "login":
      await cmdLogin();
      break;
    case "status":
      await cmdStatus();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "logout":
      await cmdLogout();
      break;
    case "devices":
      await cmdDevices(args.slice(1));
      break;
    case "disable":
      await cmdDisable(args.includes("--purge"));
      break;
    // Run by Claude Code, not by hand.
    case "statusline":
      await cmdStatusline();
      break;
    // Run by `statusline` itself, detached, so the prompt never waits on a POST.
    case "statusline-report":
      await cmdStatuslineReport();
      break;
    // Claude Code's UserPromptSubmit hook. Prints NOTHING: on this event
    // anything on stdout is injected into Claude's context.
    case "prompt-hook":
      await cmdPromptHook();
      break;
    // Run by `prompt-hook` itself, detached, for the same reason as above. The
    // report travels on the argv, not stdin — see spawnReporter in
    // cli/prompt-hook.ts for the measurement behind that.
    case "prompt-hook-report":
      await cmdPromptHookReport(args[1]);
      break;
    case "otel-headers":
      await cmdOtelHeaders();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(`clawdgg v${version()}`);
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      if (command) {
        log.error(`Unknown command: ${command}`);
        console.log();
      }
      showHelp();
      process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  log.error(`${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
