// Shared file paths and API base URL for the clawdgg CLI.
// Lives apart from index.ts because index.ts runs `main()` on import — any
// module that needs these (statusline.ts) would otherwise execute the CLI.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const CLAUDE_DIR = join(homedir(), ".claude");
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const CLAUDE_HISTORY_PATH = join(CLAUDE_DIR, "history.jsonl");
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
export const CONFIG_DIR = join(homedir(), ".config", "clawdgg");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Where install.sh puts the compiled binary.
export const INSTALL_BIN_DIR = join(homedir(), ".clawdgg", "bin");
export const INSTALLED_BINARY = join(INSTALL_BIN_DIR, "clawdgg");

// API configuration
export const API_BASE_URL =
  process.env.CLAWDGG_API_URL || "https://clawd.gg";

/**
 * How to invoke ourselves from a Claude Code settings.json hook
 * (`otelHeadersHelper`, `statusLine`). Claude Code runs these through the
 * shell with no guarantee about PATH, and `otelHeadersHelper` re-runs every 29
 * minutes for the life of the session — so it has to be an absolute path that
 * stays valid, not a bare `clawdgg`.
 *
 * In a `bun build --compile` binary the bundled entrypoint lives under the
 * virtual /$bunfs/ root, which is how we tell "compiled" from "run via bun".
 */
export function selfCommand(): string {
  if (process.env.CLAWDGG_BIN) return process.env.CLAWDGG_BIN;

  const entry = typeof Bun === "undefined" ? "" : Bun.main;
  const compiled = entry.includes("/$bunfs/") || entry.includes("\\~BUN\\");
  if (compiled) return process.execPath;

  // Running from source (`bun cli/index.ts`). Prefer an installed binary if
  // there is one, so a dev run doesn't register a path that only works here.
  if (existsSync(INSTALLED_BINARY)) return INSTALLED_BINARY;
  if (basename(process.execPath).startsWith("clawdgg")) return process.execPath;
  return `${process.execPath} ${entry}`;
}
