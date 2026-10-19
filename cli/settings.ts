// Safe reads and writes of ~/.claude/settings.json.
//
// That file is the user's, not ours. The rules that follow from it:
//   1. Unparseable JSON ABORTS. An older version caught the parse error and
//      wrote a fresh object over the top, destroying whatever was in there.
//   2. Every write goes through a temp file + fsync + rename, so neither a
//      crash nor a power cut can leave a truncated settings.json behind.
//   3. Every write is preceded by a timestamped backup (the last few are kept),
//      not just the first one — `disable` and `logout` write too.
//   4. We only ever modify or remove a value that is RECOGNIZABLY OURS. A
//      foreign collector's endpoint, protocol or Authorization header is left
//      exactly as it is unless the user says otherwise to our face.
//   5. A value that is ours is remembered as `null`, never as an "original".
//      Restoring one would re-point the exporter at clawd.gg on `disable` —
//      which is what happened to anyone set up by the pre-2.0 CLI, whose static
//      bearer and clawd.gg endpoint looked exactly like "what they had before".
//
// Every function here takes its paths explicitly — nothing reads homedir() —
// so the tests run against a fixture directory instead of the real ~/.claude.

import { open, readFile, chmod, rename, readdir, realpath, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { isOurStaticAuthHeader } from "./otel-headers";
import { shellJoin, shellSplit } from "./shell";

/** Thrown when settings.json exists but isn't valid JSON. Never swallowed. */
export class SettingsParseError extends Error {
  constructor(readonly path: string, readonly reason: unknown) {
    super(
      `${path} is not valid JSON (${reason instanceof Error ? reason.message : String(reason)}).\n` +
        `  Fix or move that file, then re-run. Refusing to overwrite it.`
    );
    this.name = "SettingsParseError";
  }
}

export interface LoadedSettings {
  exists: boolean;
  settings: Record<string, any>;
  /**
   * The path after symlink resolution — the file we must actually read, back up
   * and write. `~/.claude/settings.json` is commonly a symlink into a dotfiles
   * repo, and writing a temp file beside the LINK and renaming over it would
   * replace the link with a regular file, silently detaching it.
   */
  path: string;
}

/**
 * Resolve symlinks on the settings path, including a symlinked parent. A file
 * that doesn't exist yet still gets its directory resolved, so the first write
 * lands in the right place.
 */
export async function resolveSettingsPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/**
 * Read and parse settings.json. A missing file is an empty object; a malformed
 * one throws SettingsParseError.
 */
export async function loadSettings(path: string): Promise<LoadedSettings> {
  const resolved = await resolveSettingsPath(path);
  if (!existsSync(resolved)) return { exists: false, settings: {}, path: resolved };

  const raw = await readFile(resolved, "utf-8");
  if (!raw.trim()) return { exists: true, settings: {}, path: resolved };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SettingsParseError(resolved, error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsParseError(resolved, new Error("top-level value is not an object"));
  }
  return { exists: true, settings: parsed as Record<string, any>, path: resolved };
}

const BACKUP_SUFFIX = ".clawdgg-backup-";

/** How many timestamped backups to keep per settings.json. */
export const BACKUPS_KEPT = 5;

/**
 * A counter, zero-padded, appended to every backup name.
 *
 * The ISO stamp is not unique: `setup` backs settings.json up several times in
 * a row and two of those land in the same millisecond. The pid used to be the
 * tiebreak, which is no tiebreak at all — it is CONSTANT inside one process, so
 * the second write got the same name and REPLACED the first. That is how the
 * backup of the user's original settings could end up holding a copy of the
 * file we had already modified.
 *
 * Zero-padded because the pruning below keeps the newest N by sorting the names
 * as strings: `...-10` must not come before `...-9`.
 */
let backupSequence = 0;

const BACKUP_SEQUENCE_WIDTH = 6;

/**
 * Copy settings.json aside. Called before EVERY write of ours, not just the
 * first: `setup`, `disable` and `logout` all rewrite the file, and the copy
 * that matters when something goes wrong is the one from just before.
 *
 * Returns the backup path, or null when there was nothing to back up.
 */
export async function backupSettings(
  path: string,
  keep: number = BACKUPS_KEPT
): Promise<string | null> {
  const resolved = await resolveSettingsPath(path);
  if (!existsSync(resolved)) return null;

  const dir = dirname(resolved);
  const base = basename(resolved);
  const contents = await readFile(resolved, "utf-8");

  // The ISO stamp sorts lexicographically, which is what makes pruning simple;
  // the counter after it separates two backups taken in the same millisecond
  // without breaking that order. `wx` is the belt to that braces: a second
  // PROCESS counts from zero of its own, so the one that loses the race takes
  // the next name instead of writing over the file that is already there.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target: string;
  for (;;) {
    const seq = String(backupSequence++).padStart(BACKUP_SEQUENCE_WIDTH, "0");
    target = join(dir, `${base}${BACKUP_SUFFIX}${stamp}-${process.pid}-${seq}`);
    let handle;
    try {
      handle = await open(target, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(contents, "utf-8");
    } finally {
      await handle.close();
    }
    break;
  }
  await chmod(target, 0o600);

  // Prune oldest first, so a long-lived install doesn't accumulate one backup
  // per `clawdgg setup` forever.
  try {
    const prefix = `${base}${BACKUP_SUFFIX}`;
    const backups = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
      await unlink(join(dir, stale)).catch(() => {});
    }
  } catch {
    // An unreadable directory costs us the pruning, not the backup.
  }

  return target;
}

/**
 * Write settings.json via temp file + fsync + rename, 0600.
 *
 * The temp file goes NEXT TO the resolved target: rename() is only atomic
 * within one filesystem, and a symlinked settings.json often points at another
 * volume. fsync before the rename is what makes "atomic" true after a crash
 * rather than only after a clean exit.
 */
export async function writeSettingsAtomic(
  path: string,
  settings: Record<string, any>
): Promise<void> {
  const resolved = await resolveSettingsPath(path);
  const tmp = `${resolved}.clawdgg-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;

  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await chmod(tmp, 0o600);
    await rename(tmp, resolved);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }

  // Durability of the rename itself. Not supported everywhere, never fatal.
  try {
    const dirHandle = await open(dirname(resolved), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Best effort.
  }
}

// ============= OTEL ENV BLOCK =============

/** The settings.env keys we manage. Anything else in there is the user's. */
export const MANAGED_OTEL_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

/**
 * A static bearer token in settings.json was how we did auth until the token
 * cliff of 2026-05. `setup` removes ours and switches to otelHeadersHelper.
 */
export const STATIC_HEADER_KEYS = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
] as const;

/**
 * Per-signal overrides. These WIN over the generic OTEL_EXPORTER_OTLP_* keys,
 * so leaving one in place means our generic endpoint is quietly ignored for
 * that signal and the data goes to whoever set it — or, worse for them, our
 * helper's Authorization header does.
 *
 * Every one of these is a conflict that needs the user's answer. We never write
 * them ourselves.
 */
export const SIGNAL_SPECIFIC_KEYS = [
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
] as const;

/** Every key in settings.json that any clawdgg version has ever touched. */
export const ALL_TOUCHED_KEYS = [
  ...new Set<string>([...MANAGED_OTEL_KEYS, ...STATIC_HEADER_KEYS, ...SIGNAL_SPECIFIC_KEYS]),
];

/** Dynamic headers only work on http/protobuf and http/json — not grpc. */
export function desiredOtelEnv(apiBaseUrl: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `${apiBaseUrl}/otel`,
  };
}

/**
 * The `otelHeadersHelper` value: our own argv plus the subcommand, every
 * element shell-quoted (Claude Code runs this string through a shell, and our
 * path comes from homedir()).
 */
export function buildHelperCommand(argv: readonly string[]): string {
  return shellJoin([...argv, "otel-headers"]);
}

/** The `statusLine.command` value. Same quoting rules. */
export function buildStatusLineCommand(argv: readonly string[]): string {
  return shellJoin([...argv, "statusline"]);
}

/**
 * The `statusLine.command` value that RUNS SOMEONE ELSE'S status line.
 *
 * `<us> statusline --wrap '<their command string>'` — their whole command is
 * one shell-quoted argv element, so a status line of their own with quotes,
 * spaces or a `$` in it survives the round trip through settings.json and back
 * out of our argv unchanged.
 */
export function buildStatusLineWrapCommand(
  argv: readonly string[],
  original: string
): string {
  return shellJoin([...argv, "statusline", "--wrap", original]);
}

/** The `hooks.UserPromptSubmit[].hooks[].command` value. Same quoting rules. */
export function buildPromptHookCommand(argv: readonly string[]): string {
  return shellJoin([...argv, "prompt-hook"]);
}

/**
 * Does this command string invoke OUR `otel-headers`?
 *
 * Checked on the argv, not with a substring match: the last word has to be the
 * subcommand, and some earlier word has to name us. `my-wrapper --log
 * otel-headers.log` does not qualify.
 */
function namesUs(word: string): boolean {
  return word === "clawdgg" || /(^|[\/\\])clawdgg([.\-]|$)/.test(word) || word.includes("clawdgg");
}

function isOurSubcommand(command: unknown, subcommand: string): boolean {
  if (typeof command !== "string") return false;
  const argv = shellSplit(command);
  if (argv.length < 2 || argv[argv.length - 1] !== subcommand) return false;
  return argv.slice(0, -1).some(namesUs);
}

export function isOurHelperCommand(command: unknown): boolean {
  return isOurSubcommand(command, "otel-headers");
}

export interface StatusLineCommandShape {
  /** We wrote this command. */
  ours: boolean;
  /** The command string we are wrapping, if this is a `--wrap` form. */
  wrapped?: string;
}

/**
 * Read a `statusLine.command`: is it ours, and whose status line does it run?
 *
 * Ours means some word names us AND a later word is exactly `statusline` —
 * the same argv test as every other subcommand, except that `statusline` need
 * not be the last word, because the wrapper form carries two more. Anything
 * past `statusline` that is not `--wrap <command>` still counts as ours (we
 * are the only thing that writes that argv) but has no original to recover.
 */
export function readStatusLineCommand(command: unknown): StatusLineCommandShape {
  if (typeof command !== "string") return { ours: false };
  const argv = shellSplit(command);
  const at = argv.lastIndexOf("statusline");
  if (at < 1) return { ours: false };
  if (!argv.slice(0, at).some(namesUs)) return { ours: false };

  const rest = argv.slice(at + 1);
  if (rest.length === 2 && rest[0] === "--wrap") return { ours: true, wrapped: rest[1] };
  return { ours: true };
}

export function isOurStatusLineCommand(command: unknown): boolean {
  return readStatusLineCommand(command).ours;
}

export function isOurPromptHookCommand(command: unknown): boolean {
  return isOurSubcommand(command, "prompt-hook");
}

/** Is this endpoint value pointed at us? */
export function isOurEndpoint(value: unknown, apiBaseUrl: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const origin = apiBaseUrl.replace(/\/+$/, "");
  if (!origin) return false;
  const trimmed = value.trim();
  return trimmed === origin || trimmed.startsWith(`${origin}/`);
}

export type Ownership = "ours" | "theirs" | "absent";

export interface OtelOwnership {
  /** Verdict per key we might touch, plus `otelHeadersHelper`. */
  keys: Record<string, Ownership>;
  /**
   * The OTEL block in this file was written by clawdgg. Decided by the keys
   * that can only be ours — the endpoint, our static bearer, our helper — and
   * it is what lets us claim the keys that carry no fingerprint of their own
   * (`CLAUDE_CODE_ENABLE_TELEMETRY: "1"` is just as plausibly the user's).
   */
  blockIsOurs: boolean;
}

/**
 * Decide, key by key, what in this settings.json is ours.
 *
 * This is the function the whole file turns on: "ours" may be overwritten,
 * removed and forgotten, "theirs" may not be touched without consent and must
 * be restored afterwards.
 */
export function classifyOtelSettings(
  settings: Record<string, any>,
  desired: Record<string, string>,
  apiBaseUrl: string
): OtelOwnership {
  const env: Record<string, any> = settings?.env ?? {};
  const present = (key: string): boolean => {
    const source = key === "otelHeadersHelper" ? settings : env;
    const value = source?.[key];
    return value !== undefined && value !== null;
  };
  const valueOf = (key: string): unknown =>
    key === "otelHeadersHelper" ? settings?.[key] : env?.[key];

  // Fingerprinted keys first: these alone decide whether the block is ours.
  const endpointOurs =
    present("OTEL_EXPORTER_OTLP_ENDPOINT") &&
    isOurEndpoint(valueOf("OTEL_EXPORTER_OTLP_ENDPOINT"), apiBaseUrl);
  const helperOurs = present("otelHeadersHelper") && isOurHelperCommand(valueOf("otelHeadersHelper"));
  const headerOurs = STATIC_HEADER_KEYS.some(
    (key) => present(key) && isOurStaticAuthHeader(valueOf(key))
  );
  const blockIsOurs = endpointOurs || helperOurs || headerOurs;

  const keys: Record<string, Ownership> = {};
  const verdict = (key: string, ours: boolean): void => {
    keys[key] = !present(key) ? "absent" : ours ? "ours" : "theirs";
  };

  verdict("OTEL_EXPORTER_OTLP_ENDPOINT", endpointOurs);
  verdict("otelHeadersHelper", helperOurs);
  for (const key of STATIC_HEADER_KEYS) {
    verdict(key, isOurStaticAuthHeader(valueOf(key)));
  }
  for (const key of SIGNAL_SPECIFIC_KEYS) {
    if (keys[key] !== undefined) continue; // the *_HEADERS ones are judged above
    const value = valueOf(key);
    const ours = key.endsWith("_ENDPOINT")
      ? isOurEndpoint(value, apiBaseUrl)
      : // A protocol is not identifiable on its own, so it only counts as ours
        // inside a block that already is, and only at the value we write.
        blockIsOurs && String(value) === desired.OTEL_EXPORTER_OTLP_PROTOCOL;
    verdict(key, ours);
  }
  // Everything left carries no fingerprint: "1", "otlp", "http/json".
  for (const key of MANAGED_OTEL_KEYS) {
    if (keys[key] !== undefined) continue;
    verdict(key, blockIsOurs && String(valueOf(key)) === desired[key]);
  }

  return { keys, blockIsOurs };
}

export type ConflictKind = "value" | "static-header" | "signal-specific" | "managed-settings";

export interface OtelConflict {
  key: string;
  current: string;
  /** What it becomes if the user agrees. */
  next: string;
  kind: ConflictKind;
  /** Where it lives, for a managed-settings conflict. */
  source?: string;
}

export interface OtelPlan {
  /** Values that are NOT ours and that `setup` would displace. Needs consent. */
  conflicts: OtelConflict[];
  /** OTEL_* keys we neither manage nor conflict with. Left alone, always. */
  unmanaged: string[];
  /** Static Authorization headers we recognise as ours; removed silently. */
  staticHeaders: string[];
  /** Nothing to do: the block is already exactly what we want. */
  unchanged: boolean;
  /** The per-key verdicts behind all of the above. */
  ownership: OtelOwnership;
}

const REMOVED = "(removed)";

/**
 * What `applyOtelSettings` would change, without changing it. Lets `setup`
 * warn and ask before it touches anything the user configured themselves.
 */
export function planOtelSettings(
  settings: Record<string, any>,
  desired: Record<string, string>,
  helperCommand: string,
  apiBaseUrl: string
): OtelPlan {
  const env: Record<string, any> = settings?.env ?? {};
  const ownership = classifyOtelSettings(settings, desired, apiBaseUrl);
  const conflicts: OtelConflict[] = [];

  for (const [key, next] of Object.entries(desired)) {
    if (ownership.keys[key] !== "theirs") continue;
    if (String(env[key]) === next) continue;
    conflicts.push({ key, current: String(env[key]), next, kind: "value" });
  }

  // A foreign static bearer. Not deleted without an answer: it is a credential
  // for somebody's collector, and our helper's Authorization would go there.
  for (const key of STATIC_HEADER_KEYS) {
    if (ownership.keys[key] !== "theirs") continue;
    conflicts.push({ key, current: "(an Authorization header we did not write)", next: REMOVED, kind: "static-header" });
  }

  // Per-signal overrides beat our generic endpoint, so they are conflicts even
  // when nothing else in the file is.
  for (const key of SIGNAL_SPECIFIC_KEYS) {
    if (ownership.keys[key] !== "theirs") continue;
    if (conflicts.some((c) => c.key === key)) continue;
    const shown = key.endsWith("_HEADERS") ? "(an Authorization header we did not write)" : String(env[key]);
    conflicts.push({ key, current: shown, next: REMOVED, kind: "signal-specific" });
  }

  if (ownership.keys.otelHeadersHelper === "theirs") {
    conflicts.push({
      key: "otelHeadersHelper",
      current: String(settings.otelHeadersHelper),
      next: helperCommand,
      kind: "value",
    });
  }

  const managed = new Set<string>(ALL_TOUCHED_KEYS);
  const unmanaged = Object.keys(env)
    .filter((key) => key.startsWith("OTEL_") && !managed.has(key))
    .sort();

  const staticHeaders = STATIC_HEADER_KEYS.filter((key) => ownership.keys[key] === "ours");

  const envAlreadyRight = Object.entries(desired).every(([key, value]) => String(env[key]) === value);
  const nothingToRemove =
    staticHeaders.length === 0 &&
    SIGNAL_SPECIFIC_KEYS.every((key) => ownership.keys[key] === "absent");
  const unchanged =
    envAlreadyRight && nothingToRemove && settings?.otelHeadersHelper === helperCommand;

  return { conflicts, unmanaged, staticHeaders: [...staticHeaders], unchanged, ownership };
}

/**
 * Previous values of everything we touched. `null` means "wasn't there, or was
 * ours" — `restoreOtelSettings` turns that back into a deletion rather than a
 * literal null, and it is the whole reason a legacy install doesn't get
 * clawd.gg's own exporter "restored" on `disable`.
 */
export type OtelOriginals = Record<string, string | null>;

export interface ApplyOptions {
  apiBaseUrl: string;
  /**
   * The user agreed to displace values that are not ours. Without it,
   * `applyOtelSettings` leaves every foreign value alone — a setup that half
   * applies is better than one that silently breaks somebody's collector.
   */
  replaceForeign?: boolean;
}

/**
 * Point Claude Code's exporter at us, in place. Returns the values we
 * displaced so `disable` can restore them.
 */
export function applyOtelSettings(
  settings: Record<string, any>,
  desired: Record<string, string>,
  helperCommand: string,
  options: ApplyOptions
): OtelOriginals {
  const { apiBaseUrl, replaceForeign = false } = options;
  const ownership = classifyOtelSettings(settings, desired, apiBaseUrl);
  const originals: OtelOriginals = {};
  const env: Record<string, any> = (settings.env ??= {});

  /**
   * Ours (or absent) is remembered as null — it is not an original, and
   * "restoring" it would put our own exporter back on `disable`.
   */
  const remember = (key: string, value: unknown): void => {
    const theirs = ownership.keys[key] === "theirs" && value !== undefined && value !== null;
    originals[key] = theirs ? String(value) : null;
  };

  for (const [key, value] of Object.entries(desired)) {
    if (ownership.keys[key] === "theirs" && !replaceForeign) continue;
    remember(key, env[key]);
    env[key] = value;
  }

  // The static bearer goes away entirely — that's the whole point of the
  // helper. A foreign one only goes with consent. Deduped: the per-signal
  // *_HEADERS keys are in both lists, and visiting one twice would "remember"
  // the value we had already deleted.
  for (const key of new Set<string>([...STATIC_HEADER_KEYS, ...SIGNAL_SPECIFIC_KEYS])) {
    const verdict = ownership.keys[key];
    if (verdict === "absent") continue;
    if (verdict === "theirs" && !replaceForeign) continue;
    remember(key, env[key]);
    delete env[key];
  }

  if (ownership.keys.otelHeadersHelper !== "theirs" || replaceForeign) {
    remember("otelHeadersHelper", settings.otelHeadersHelper);
    settings.otelHeadersHelper = helperCommand;
  }

  return originals;
}

export interface RestoreOutcome {
  /** Keys we deleted (they were ours). */
  removed: string[];
  /** Keys we put a remembered value back into. */
  restored: string[];
  /** Keys we found changed since we wrote them, and did not touch. */
  leftAlone: string[];
}

export interface RestoreOptions {
  apiBaseUrl: string;
  desired: Record<string, string>;
}

/**
 * Undo `applyOtelSettings`.
 *
 * Two safety rules, both learned the hard way:
 *   - a key is only removed or restored when its CURRENT value is still the one
 *     we wrote. If the user has since pointed it somewhere else, it is theirs
 *     now and we leave it.
 *   - with no remembered originals (config lost, or an older CLI set this up)
 *     we delete only what we recognise as ours, and touch nothing else. Running
 *     `clawdgg logout` on a machine we never set up must not disturb the
 *     collector that machine was already exporting to.
 */
export function restoreOtelSettings(
  settings: Record<string, any>,
  originals: OtelOriginals | undefined,
  options: RestoreOptions
): RestoreOutcome {
  const outcome: RestoreOutcome = { removed: [], restored: [], leftAlone: [] };
  if (!settings || typeof settings !== "object") return outcome;

  const ownership = classifyOtelSettings(settings, options.desired, options.apiBaseUrl);
  const keys = originals
    ? Object.keys(originals)
    : [...ALL_TOUCHED_KEYS, "otelHeadersHelper"];

  const targetFor = (key: string): Record<string, any> =>
    key === "otelHeadersHelper" ? settings : (settings.env ??= {});

  for (const key of keys) {
    const verdict = ownership.keys[key] ?? "absent";
    const previous = originals ? originals[key] : null;
    const hasPrevious = previous !== null && previous !== undefined;

    if (verdict === "absent") {
      // Not in the file. If we remembered a value for it, that is BECAUSE we
      // deleted theirs (a static bearer, a per-signal override) — so putting
      // it back is the whole job. Nothing remembered means nothing to do.
      if (hasPrevious) {
        targetFor(key)[key] = previous;
        outcome.restored.push(key);
      }
      continue;
    }

    if (verdict === "theirs") {
      // Either we never wrote it, or the user changed it after we did. Both
      // mean hands off.
      outcome.leftAlone.push(key);
      continue;
    }

    if (hasPrevious) {
      targetFor(key)[key] = previous;
      outcome.restored.push(key);
    } else {
      delete targetFor(key)[key];
      outcome.removed.push(key);
    }
  }

  if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
  return outcome;
}

// ============= MANAGED SETTINGS =============

/**
 * Enterprise managed settings override ~/.claude/settings.json, so an OTEL key
 * in one of these files means our write is silently ignored. Detecting it turns
 * "setup said it worked but nothing arrives" into something `setup` and
 * `doctor` can say out loud.
 *
 * CLAWDGG_MANAGED_SETTINGS overrides the search path (used by the tests).
 */
export function managedSettingsPaths(platform: string = process.platform): string[] {
  const override = process.env.CLAWDGG_MANAGED_SETTINGS;
  if (override) return override.split(":").filter(Boolean);
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  return ["/etc/claude-code/managed-settings.json"];
}

const MANAGED_SETTINGS_WATCHED = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  ...MANAGED_OTEL_KEYS,
  ...SIGNAL_SPECIFIC_KEYS,
];

export interface ManagedSettingsConflict {
  path: string;
  key: string;
  value: string;
}

/** OTEL keys pinned by a managed-settings file, if any is readable. */
export async function detectManagedSettings(
  paths: string[] = managedSettingsPaths()
): Promise<ManagedSettingsConflict[]> {
  const found: ManagedSettingsConflict[] = [];

  for (const path of paths) {
    let parsed: any;
    try {
      if (!existsSync(path)) continue;
      parsed = JSON.parse(await readFile(path, "utf-8"));
    } catch {
      // Unreadable or malformed: not ours to fix, and not worth an error.
      continue;
    }
    const env = parsed?.env;
    if (!env || typeof env !== "object") continue;
    for (const key of MANAGED_SETTINGS_WATCHED) {
      if (env[key] === undefined || env[key] === null) continue;
      found.push({ path, key, value: String(env[key]) });
    }
  }

  return found;
}

/** Where the backup files land, for the "we backed it up" notice. */
export function backupGlob(settingsPath: string): string {
  return `${settingsPath}${BACKUP_SUFFIX}*`;
}

/** The directory settings.json lives in, created on demand before a write. */
export function settingsDir(settingsPath: string): string {
  return dirname(settingsPath);
}

/** Convenience for tests and callers that build a fixture tree. */
export function settingsPathIn(claudeDir: string): string {
  return join(claudeDir, "settings.json");
}
