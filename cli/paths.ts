// Shared file paths and API base URL for the clawdgg CLI.
// Lives apart from index.ts because index.ts runs `main()` on import — any
// module that needs these (statusline.ts) would otherwise execute the CLI.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { shellJoin } from "./shell";

export const CLAUDE_DIR = join(homedir(), ".claude");
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const CLAUDE_HISTORY_PATH = join(CLAUDE_DIR, "history.jsonl");
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
export const CONFIG_DIR = join(homedir(), ".config", "clawdgg");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Where install.sh puts the compiled binary.
export const INSTALL_BIN_DIR = join(homedir(), ".clawdgg", "bin");
export const INSTALLED_BINARY = join(INSTALL_BIN_DIR, "clawdgg");

/** Where clawd.gg itself lives. Not configurable in a release build. */
export const DEFAULT_API_BASE_URL = "https://clawd.gg";

/**
 * In a `bun build --compile` binary the bundled entrypoint lives under the
 * virtual /$bunfs/ root, which is how we tell "compiled" from "run via bun".
 */
export function isCompiledBinary(): boolean {
  const entry = typeof Bun === "undefined" ? "" : Bun.main;
  return entry.includes("/$bunfs/") || entry.includes("\\~BUN\\");
}

/** Dev override of the API URL is honoured; in a release build it is not. */
export function devModeEnabled(): boolean {
  return process.env.CLAWDGG_DEV === "1" || !isCompiledBinary();
}

/**
 * A URL is only a safe place to send a bearer token if it is https — or if it
 * is a loopback address, which never leaves the machine (that is how `bun run
 * dev` is developed against).
 */
export function isAllowedApiOrigin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
}

/** No trailing slash, so `${origin}/otel` is never `//otel`. */
function normalizeOrigin(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface ApiUrlResolution {
  url: string;
  /** Set when an override was present but refused, for a one-line warning. */
  rejected?: { value: string; reason: string };
}

/**
 * Resolve the API base URL.
 *
 * CLAWDGG_API_URL is a development affordance, and a release binary IGNORES it
 * unless CLAWDGG_DEV=1: `clawdgg` runs from inside the user's projects, and the
 * env a hook inherits is not under the user's eye. The compiled binary also
 * refuses to autoload a .env or a bunfig.toml (see scripts/build-cli.ts), so a
 * repo cannot redirect anyone's telemetry by checking one in.
 */
export function resolveApiBaseUrl(
  override: string | undefined = process.env.CLAWDGG_API_URL,
  dev: boolean = devModeEnabled()
): ApiUrlResolution {
  if (!override) return { url: DEFAULT_API_BASE_URL };
  if (!dev) {
    return {
      url: DEFAULT_API_BASE_URL,
      rejected: { value: override, reason: "release build — set CLAWDGG_DEV=1 to allow it" },
    };
  }
  if (!isAllowedApiOrigin(override)) {
    return {
      url: DEFAULT_API_BASE_URL,
      rejected: { value: override, reason: "must be https, or http on localhost" },
    };
  }
  return { url: normalizeOrigin(override) };
}

export const API_URL_RESOLUTION = resolveApiBaseUrl();
export const API_BASE_URL = API_URL_RESOLUTION.url;

/**
 * How to invoke ourselves, as an ARGV.
 *
 * Claude Code runs the settings.json hooks (`otelHeadersHelper`, `statusLine`)
 * through a shell with no guarantee about PATH, and `otelHeadersHelper` re-runs
 * every 29 minutes for the life of the session — so this has to be an absolute
 * path that stays valid, not a bare `clawdgg`. It is an argv rather than a
 * string because every element gets shell-quoted before it lands in that file.
 */
export function selfArgv(): string[] {
  const override = process.env.CLAWDGG_BIN;
  if (override) return [override];

  if (isCompiledBinary()) return [process.execPath];

  // Running through bun: either from source (`bun cli/index.ts`) or from the
  // published bundle (`bunx clawdgg`). Prefer an installed binary if there is
  // one, so a dev run doesn't register a path that only works here.
  if (existsSync(INSTALLED_BINARY)) return [INSTALLED_BINARY];
  if (basename(process.execPath).startsWith("clawdgg")) return [process.execPath];

  // --no-env-file matters: this form is `bun <script>`, and bun otherwise reads
  // a .env from whatever directory the hook happens to run in. clawdgg runs
  // inside the user's projects, so one CLAWDGG_API_URL checked into a repo
  // would quietly redirect that project's telemetry.
  return [process.execPath, "--no-env-file", typeof Bun === "undefined" ? "" : Bun.main];
}

/** selfArgv() as one shell-safe command string. */
export function selfCommand(): string {
  return shellJoin(selfArgv());
}
