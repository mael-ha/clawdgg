// Safe reads and writes of ~/.claude/settings.json.
//
// That file is the user's, not ours. Three rules follow from it:
//   1. Unparseable JSON ABORTS. The old code caught the parse error and wrote a
//      fresh object over the top, destroying whatever was in there.
//   2. Every write goes through a temp file + rename, so a crash mid-write
//      can't leave a truncated settings.json behind.
//   3. We back it up once before our first modification, and we remember the
//      values we overwrote so `disable` can put them back.
//
// Every function here takes its paths explicitly — nothing reads homedir() —
// so the tests run against a fixture directory instead of the real ~/.claude.

import { readFile, writeFile, chmod, rename, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

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
}

/**
 * Read and parse settings.json. A missing file is an empty object; a malformed
 * one throws SettingsParseError.
 */
export async function loadSettings(path: string): Promise<LoadedSettings> {
  if (!existsSync(path)) return { exists: false, settings: {} };

  const raw = await readFile(path, "utf-8");
  if (!raw.trim()) return { exists: true, settings: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SettingsParseError(path, error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsParseError(path, new Error("top-level value is not an object"));
  }
  return { exists: true, settings: parsed as Record<string, any> };
}

const BACKUP_SUFFIX = ".clawdgg-backup-";

/**
 * Copy settings.json aside before our first modification. Returns the backup
 * path, or null when there's nothing to back up or we already made one.
 */
export async function backupSettingsOnce(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;

  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  try {
    const entries = await readdir(dir);
    if (entries.some((e) => e.startsWith(`${base}${BACKUP_SUFFIX}`))) return null;
  } catch {
    // Unreadable directory: fall through and try the copy anyway.
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}${BACKUP_SUFFIX}${stamp}`;
  await writeFile(target, await readFile(path, "utf-8"), { mode: 0o600 });
  return target;
}

/** Write settings.json via temp file + rename, 0600. */
export async function writeSettingsAtomic(
  path: string,
  settings: Record<string, any>
): Promise<void> {
  const tmp = `${path}.clawdgg-tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
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
 * cliff of 2026-05. `setup` removes it and switches to otelHeadersHelper.
 */
export const STATIC_HEADER_KEYS = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
] as const;

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

export interface OtelConflict {
  key: string;
  current: string;
  next: string;
}

export interface OtelPlan {
  /** Managed keys that already hold a different value — someone else's exporter. */
  conflicts: OtelConflict[];
  /** OTEL_* keys we don't manage. Their presence means a foreign collector. */
  unmanaged: string[];
  /** A static Authorization header is present and will be removed. */
  staticHeaders: string[];
  /** Nothing to do: the block is already exactly what we want. */
  unchanged: boolean;
}

/**
 * What `applyOtelSettings` would change, without changing it. Lets `setup`
 * warn and ask before it replaces a collector the user configured themselves.
 */
export function planOtelSettings(
  settings: Record<string, any>,
  desired: Record<string, string>,
  helperCommand: string
): OtelPlan {
  const env: Record<string, any> = settings?.env ?? {};
  const conflicts: OtelConflict[] = [];

  for (const [key, next] of Object.entries(desired)) {
    const current = env[key];
    if (current === undefined || current === null) continue;
    if (String(current) !== next) conflicts.push({ key, current: String(current), next });
  }

  const managed = new Set<string>([...MANAGED_OTEL_KEYS, ...STATIC_HEADER_KEYS]);
  const unmanaged = Object.keys(env)
    .filter((k) => k.startsWith("OTEL_") && !managed.has(k))
    .sort();

  const staticHeaders = STATIC_HEADER_KEYS.filter((k) => env[k] !== undefined && env[k] !== null);

  const envAlreadyRight = Object.entries(desired).every(([k, v]) => String(env[k]) === v);
  const unchanged =
    envAlreadyRight && staticHeaders.length === 0 && settings?.otelHeadersHelper === helperCommand;

  return { conflicts, unmanaged, staticHeaders: [...staticHeaders], unchanged };
}

/**
 * Previous values of everything we touched. `null` means "wasn't there", which
 * `restoreOtelSettings` turns back into a deletion rather than a literal null.
 */
export type OtelOriginals = Record<string, string | null>;

/**
 * Point Claude Code's exporter at us, in place. Returns the values we
 * displaced so `disable` can restore them.
 */
export function applyOtelSettings(
  settings: Record<string, any>,
  desired: Record<string, string>,
  helperCommand: string
): OtelOriginals {
  const originals: OtelOriginals = {};
  const env: Record<string, any> = (settings.env ??= {});

  const remember = (key: string, value: unknown) => {
    originals[key] = value === undefined || value === null ? null : String(value);
  };

  for (const [key, value] of Object.entries(desired)) {
    remember(key, env[key]);
    env[key] = value;
  }

  // The static bearer token goes away entirely — that's the whole point of the
  // helper. Remembered so `disable` can restore a header that wasn't ours.
  for (const key of STATIC_HEADER_KEYS) {
    if (env[key] === undefined || env[key] === null) continue;
    remember(key, env[key]);
    delete env[key];
  }

  remember("otelHeadersHelper", settings.otelHeadersHelper);
  settings.otelHeadersHelper = helperCommand;

  return originals;
}

/**
 * Undo `applyOtelSettings`. Keys the user had before come back with their old
 * values; keys that only we added are deleted. With no remembered originals
 * (config lost, or set up by an older CLI) we fall back to deleting our keys.
 */
export function restoreOtelSettings(
  settings: Record<string, any>,
  originals: OtelOriginals | undefined
): void {
  const env: Record<string, any> = settings?.env ?? {};
  const keys = originals
    ? Object.keys(originals)
    : [...MANAGED_OTEL_KEYS, ...STATIC_HEADER_KEYS, "otelHeadersHelper"];

  for (const key of keys) {
    const previous = originals ? originals[key] : null;
    const target = key === "otelHeadersHelper" ? settings : env;
    if (previous === null || previous === undefined) {
      delete target[key];
    } else {
      target[key] = previous;
    }
  }

  if (settings?.env && Object.keys(settings.env).length === 0) delete settings.env;
}

/**
 * The `otelHeadersHelper` value: our own absolute path plus the subcommand.
 * Claude Code runs this at startup and every 29 minutes thereafter, so the
 * path has to survive shell-independent invocation — hence absolute.
 */
export function buildHelperCommand(binaryCommand: string): string {
  return `${binaryCommand} otel-headers`;
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
