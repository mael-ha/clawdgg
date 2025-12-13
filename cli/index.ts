#!/usr/bin/env bun
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// File paths
const STATS_FILE = join(homedir(), ".claude", "stats-cache.json");
const CONFIG_DIR = join(homedir(), ".clawd-gg");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// API configuration
const API_BASE_URL =
  process.env.CLAWD_API_URL || "https://clawd.gg";

// Types
interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface Stats {
  dailyActivity: DailyActivity[];
  totalMessages: number;
  totalSessions: number;
  firstSessionDate: string;
}

interface Config {
  token?: string;
  userId?: string;
  username?: string;
  lastSyncDate?: string; // YYYY-MM-DD of last successful sync
}

interface SyncResponse {
  success: boolean;
  message: string;
  lastDate?: string;
  daysSubmitted?: number;
}

// Configuration management
async function loadConfig(): Promise<Config> {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return {};
    }
    const data = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

async function saveConfig(config: Config): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    throw new Error(`Failed to save config: ${error}`);
  }
}

// Stats management
async function loadStats(): Promise<Stats | null> {
  try {
    if (!existsSync(STATS_FILE)) {
      log.error(`Stats file not found at ${STATS_FILE}`);
      log.dim("Make sure you have Claude Code installed and have used it.");
      return null;
    }
    const data = await readFile(STATS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    log.error(`Failed to read stats file: ${error}`);
    return null;
  }
}

// API calls
async function syncStats(
  dailyActivity: DailyActivity[],
  firstSessionDate: string,
  token: string
): Promise<SyncResponse> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/stats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ dailyActivity, firstSessionDate }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    return await response.json();
  } catch (error) {
    throw new Error(`Failed to sync stats: ${error}`);
  }
}

async function initiateLogin(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/device`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to initiate login: ${response.status}`);
    }

    const { deviceCode, userCode, verificationUrl, expiresIn } =
      await response.json();

    log.title("Login to clawd.gg");
    console.log(`${colors.bright}User Code:${colors.reset} ${colors.yellow}${userCode}${colors.reset}`);
    console.log(`\nOpening browser to: ${colors.cyan}${verificationUrl}${colors.reset}\n`);

    log.dim("If the browser doesn't open automatically, visit the URL above.");

    // Open browser
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
        ? "start"
        : "xdg-open";

    try {
      await Bun.spawn([openCmd, verificationUrl]);
    } catch (e) {
      // Silently fail if we can't open browser
    }

    // Poll for completion
    log.info("Waiting for authentication...");
    const pollInterval = 5000; // 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < expiresIn * 1000) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const pollResponse = await fetch(`${API_BASE_URL}/api/auth/device/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deviceCode }),
      });

      if (pollResponse.ok) {
        const { token, userId, username } = await pollResponse.json();
        await saveConfig({ token, userId, username });
        log.success(`Successfully logged in as ${colors.bright}${username}${colors.reset}`);
        return;
      }

      if (pollResponse.status !== 428) {
        // 428 = still waiting
        const error = await pollResponse.text();
        throw new Error(`Authentication failed: ${error}`);
      }
    }

    throw new Error("Authentication timed out");
  } catch (error) {
    throw new Error(`Login failed: ${error}`);
  }
}

// Helper to get today's date in YYYY-MM-DD format
function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

// Commands
async function cmdSync(forceFullSync: boolean = false): Promise<void> {
  log.title("Syncing Claude Code stats to clawd.gg");

  // Check authentication
  const config = await loadConfig();
  if (!config.token) {
    log.error("Not authenticated. Please run `clawdgg login` first.");
    process.exit(1);
  }

  // Load stats
  log.info("Reading stats from ~/.claude/stats-cache.json...");
  const stats = await loadStats();
  if (!stats) {
    process.exit(1);
  }

  const today = getTodayDate();
  const lastSync = forceFullSync ? null : config.lastSyncDate;

  if (forceFullSync && config.lastSyncDate) {
    log.warn("Force sync: re-uploading all historical data...");
  }

  // Filter out today (incomplete) and already-synced days (unless force)
  let activityToSync = stats.dailyActivity.filter(day => {
    // Exclude today's date (incomplete data)
    if (day.date === today) {
      return false;
    }
    // If we have a last sync date, only include newer days
    if (lastSync && day.date <= lastSync) {
      return false;
    }
    return true;
  });

  // Show summary
  console.log(`${colors.dim}Total messages: ${stats.totalMessages.toLocaleString()}${colors.reset}`);
  console.log(`${colors.dim}Total sessions: ${stats.totalSessions.toLocaleString()}${colors.reset}`);
  console.log(`${colors.dim}Days in local stats: ${stats.dailyActivity.length}${colors.reset}`);

  if (lastSync) {
    console.log(`${colors.dim}Last synced: ${lastSync}${colors.reset}`);
  }

  // Check if there's anything to sync
  if (activityToSync.length === 0) {
    if (lastSync) {
      log.success("Already up to date! No new completed days to sync.");
    } else {
      log.warn("No completed days to sync yet. Keep using Claude Code!");
    }
    console.log();
    return;
  }

  console.log(`${colors.cyan}Days to sync: ${activityToSync.length}${colors.reset}\n`);

  // Sync
  log.info("Uploading to clawd.gg...");

  try {
    const result = await syncStats(activityToSync, stats.firstSessionDate, config.token);

    // Update lastSyncDate in config
    if (result.lastDate) {
      await saveConfig({ ...config, lastSyncDate: result.lastDate });
    } else if (activityToSync.length > 0) {
      // Fallback: use the latest date we sent
      const latestDate = activityToSync[activityToSync.length - 1].date;
      await saveConfig({ ...config, lastSyncDate: latestDate });
    }

    log.success(`Stats synced successfully! (${result.daysSubmitted || activityToSync.length} days)`);

    if (config.username) {
      console.log(`\n${colors.cyan}View your profile:${colors.reset} ${API_BASE_URL}/${config.username}\n`);
    }
  } catch (error) {
    log.error(`${error}`);

    if (error instanceof Error && error.message.includes("401")) {
      log.warn("Your session may have expired. Try running `clawdgg login` again.");
    }

    process.exit(1);
  }
}

async function cmdLogin(): Promise<void> {
  try {
    await initiateLogin();
  } catch (error) {
    log.error(`${error}`);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  log.title("Claude Code Stats Summary");

  // Check authentication
  const config = await loadConfig();
  if (config.token && config.username) {
    log.success(`Logged in as ${colors.bright}${config.username}${colors.reset}`);
    console.log(`${colors.dim}Profile: ${API_BASE_URL}/${config.username}${colors.reset}`);
    if (config.lastSyncDate) {
      console.log(`${colors.dim}Last synced: ${config.lastSyncDate}${colors.reset}`);
    }
    console.log();
  } else {
    log.warn("Not logged in. Run `clawdgg login` to authenticate.");
    console.log();
  }

  // Load and display stats
  const stats = await loadStats();
  if (!stats) {
    return;
  }

  console.log(`${colors.bright}Overall Stats:${colors.reset}`);
  console.log(`  Messages:  ${colors.green}${stats.totalMessages.toLocaleString()}${colors.reset}`);
  console.log(`  Sessions:  ${colors.blue}${stats.totalSessions.toLocaleString()}${colors.reset}`);
  console.log(`  First use: ${colors.cyan}${new Date(stats.firstSessionDate).toLocaleDateString()}${colors.reset}`);
  console.log(`  Days tracked: ${colors.yellow}${stats.dailyActivity.length}${colors.reset}`);

  // Recent activity
  const recent = stats.dailyActivity.slice(-7).reverse();
  if (recent.length > 0) {
    console.log(`\n${colors.bright}Recent Activity (last 7 days):${colors.reset}`);
    for (const day of recent) {
      const date = new Date(day.date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const bar = "█".repeat(Math.min(Math.floor(day.messageCount / 5), 20));
      console.log(
        `  ${colors.dim}${date.padEnd(8)}${colors.reset} ${colors.green}${bar}${colors.reset} ${day.messageCount} msg, ${day.sessionCount} sessions`
      );
    }
  }

  console.log();
}

function showHelp(): void {
  console.log(`
${colors.bright}${colors.cyan}clawd.gg CLI${colors.reset} - Sync your Claude Code stats

${colors.bright}Usage:${colors.reset}
  clawdgg <command> [options]

${colors.bright}Commands:${colors.reset}
  ${colors.green}login${colors.reset}    Login with GitHub to authenticate
  ${colors.green}sync${colors.reset}     Sync new stats to clawd.gg (incremental)
  ${colors.green}status${colors.reset}   Show current stats and login status
  ${colors.green}help${colors.reset}     Show this help message

${colors.bright}Options:${colors.reset}
  ${colors.yellow}--force${colors.reset}  Force full sync (re-upload all history)

${colors.bright}Examples:${colors.reset}
  ${colors.dim}$ clawdgg login${colors.reset}
  ${colors.dim}$ clawdgg sync${colors.reset}
  ${colors.dim}$ clawdgg sync --force${colors.reset}
  ${colors.dim}$ clawdgg status${colors.reset}

${colors.dim}Stats are read from: ~/.claude/stats-cache.json${colors.reset}
${colors.dim}Visit https://clawd.gg for more info${colors.reset}
`);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const hasForceFlag = args.includes("--force") || args.includes("-f");

  switch (command) {
    case "sync":
      await cmdSync(hasForceFlag);
      break;
    case "login":
      await cmdLogin();
      break;
    case "status":
      await cmdStatus();
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
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
