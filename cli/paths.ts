// Shared file paths and API base URL for the clawdgg CLI.
// Lives apart from index.ts because index.ts runs `main()` on import — any
// module that needs these (statusline.ts) would otherwise execute the CLI.

import { homedir } from "node:os";
import { join } from "node:path";

export const STATS_FILE = join(homedir(), ".claude", "stats-cache.json");
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
export const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
export const CONFIG_DIR = join(homedir(), ".config", "clawdgg");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const CACHE_FILE = join(CONFIG_DIR, "cache.json");
// Previous config location (renamed from `clawd` to `clawdgg` in May 2026 to
// avoid namespace collision with unrelated upstream "clawd" projects).
export const PREV_CONFIG_DIR = join(homedir(), ".config", "clawd");
export const PREV_CONFIG_FILE = join(PREV_CONFIG_DIR, "config.json");
// Original legacy config location (renamed to ~/.config/clawd in 2025).
export const LEGACY_CONFIG_DIR = join(homedir(), ".clawd-gg");
export const LEGACY_CONFIG_FILE = join(LEGACY_CONFIG_DIR, "config.json");

// API configuration
export const API_BASE_URL =
  process.env.CLAWDGG_API_URL || "https://clawd.gg";
