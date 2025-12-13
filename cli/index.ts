#!/usr/bin/env bun
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
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

interface LongestSession {
  messageCount: number;
  duration: number;
  timestamp: string;
}

interface Stats {
  dailyActivity: DailyActivity[];
  totalMessages: number;
  totalSessions: number;
  firstSessionDate?: string;
  // Badge-relevant data
  hourCounts?: Record<string, number>;
  longestSession?: LongestSession;
}

interface Config {
  token?: string;
  userId?: string;
  username?: string;
  lastSyncDate?: string; // YYYY-MM-DD of last successful sync
  // For celebration detection
  lastKnownBadges?: string[];
  lastKnownRank?: number;
  lastKnownLongestStreak?: number;
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
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    // Double-ensure permissions (writeFile mode may not work on all platforms)
    await chmod(CONFIG_FILE, 0o600);
  } catch (error) {
    throw new Error(`Failed to save config: ${error}`);
  }
}

// Validate stats structure to handle Claude Code format changes
function validateStats(data: unknown): data is Stats {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    Array.isArray(obj.dailyActivity) &&
    typeof obj.totalMessages === 'number' &&
    typeof obj.totalSessions === 'number'
  );
}

// Stats management
async function loadStats(): Promise<Stats | null> {
  try {
    if (!existsSync(STATS_FILE)) {
      log.error("No Claude Code stats found");
      log.dim("Make sure Claude Code is installed and you've used it at least once.");
      return null;
    }
    const data = await readFile(STATS_FILE, "utf-8");
    const parsed = JSON.parse(data);

    if (!validateStats(parsed)) {
      log.error("Stats file has unexpected format");
      log.dim("Your Claude Code version may be incompatible. Try updating.");
      return null;
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      log.error("Stats file is corrupted (invalid JSON)");
    } else {
      log.error(`Couldn't read stats: ${error}`);
    }
    return null;
  }
}

// Badge-relevant data to send with sync
interface BadgeData {
  hourCounts?: Record<string, number>;
  longestSessionMessages?: number;
}

// API calls
async function syncStats(
  dailyActivity: DailyActivity[],
  firstSessionDate: string | undefined,
  badgeData: BadgeData,
  token: string
): Promise<SyncResponse> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/stats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dailyActivity,
        firstSessionDate,
        ...badgeData,
      }),
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

    log.title("Let's link your GitHub");
    console.log(`${colors.bright}Your code:${colors.reset} ${colors.yellow}${userCode}${colors.reset}`);
    console.log(`\n${colors.dim}Opening${colors.reset} ${colors.cyan}${verificationUrl}${colors.reset}\n`);

    log.dim("Browser didn't open? Copy the URL above.");

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
    log.info("Waiting for you to authorize...");
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
        log.success(`Linked! Welcome, ${colors.bright}${username}${colors.reset}`);
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
  log.title("Uploading your stats");

  // Check authentication
  const config = await loadConfig();
  if (!config.token) {
    log.error("We haven't met yet. Run `clawd login` first.");
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
      log.success("Already synced! No new days to upload.");
    } else {
      log.warn("No completed days yet. Keep coding with me!");
    }
    console.log();
    return;
  }

  console.log(`${colors.cyan}Days to sync: ${activityToSync.length}${colors.reset}\n`);

  // Sync
  log.info("Uploading to clawd.gg...");

  // Extract badge-relevant data
  const badgeData: BadgeData = {
    hourCounts: stats.hourCounts,
    longestSessionMessages: stats.longestSession?.messageCount,
  };

  try {
    const result = await syncStats(activityToSync, stats.firstSessionDate, badgeData, config.token);

    // Update lastSyncDate in config
    if (result.lastDate) {
      await saveConfig({ ...config, lastSyncDate: result.lastDate });
    } else if (activityToSync.length > 0) {
      // Fallback: use the latest date we sent (don't assume array is sorted)
      const latestDate = activityToSync.reduce((max, day) =>
        day.date > max ? day.date : max, activityToSync[0]!.date);
      await saveConfig({ ...config, lastSyncDate: latestDate });
    }

    log.success(`Done! Your Claude addiction is now public record. (${result.daysSubmitted || activityToSync.length} days)`);

    if (config.username) {
      console.log(`\n${colors.cyan}See your rank:${colors.reset} ${API_BASE_URL}\n`);
    }
  } catch (error) {
    log.error(`${error}`);

    if (error instanceof Error && error.message.includes("401")) {
      log.warn("Your token expired. Time flies when you're prompting. Run `clawd login` again.");
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

// Badge emoji mapping
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

// Draw a progress bar
function progressBar(value: number, max: number, width: number = 20): string {
  const filled = Math.min(Math.round((value / max) * width), width);
  const empty = width - filled;
  return `${colors.cyan}${'█'.repeat(filled)}${colors.dim}${'░'.repeat(empty)}${colors.reset}`;
}

// Pad string to width
function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
  const len = str.replace(/\x1b\[[0-9;]*m/g, '').length; // Strip ANSI codes for length
  const padding = Math.max(0, width - len);
  return align === 'left' ? str + ' '.repeat(padding) : ' '.repeat(padding) + str;
}

// Format number with commas
function fmt(n: number): string {
  return n.toLocaleString();
}

interface ProfileData {
  username: string;
  rank: number;
  totalUsers: number;
  totalMessages: number;
  totalSessions: number;
  totalToolCalls: number;
  currentStreak: number;
  badges: string[];
}

// Fetch profile from API
async function fetchProfile(token: string): Promise<ProfileData | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();
  const stats = await loadStats();

  // If logged in, try to fetch online profile
  let profile: ProfileData | null = null;
  if (config.token) {
    profile = await fetchProfile(config.token);
  }

  // Calculate local totals
  const localMessages = stats?.totalMessages || 0;
  const localSessions = stats?.totalSessions || 0;
  const localTools = stats?.dailyActivity?.reduce((sum, d) => sum + d.toolCallCount, 0) || 0;

  // Use online data if available, otherwise local
  const messages = profile?.totalMessages || localMessages;
  const sessions = profile?.totalSessions || localSessions;
  const tools = profile?.totalToolCalls || localTools;
  const maxStat = Math.max(messages, sessions, tools, 1);

  // Build the ASCII box
  const boxWidth = 45;
  const innerWidth = boxWidth - 4; // Account for "│  " and "  │"

  console.log();

  // ========== CELEBRATION DETECTION ==========
  let celebrations: string[] = [];

  if (profile) {
    // Check for #1 achievement
    if (profile.rank === 1 && config.lastKnownRank !== 1) {
      celebrations.push(`👑 YOU'RE #1. I'm genuinely impressed.`);
    }

    // Check for new badges
    const lastBadges = new Set(config.lastKnownBadges || []);
    const newBadges = profile.badges.filter(b => !lastBadges.has(b));
    if (newBadges.length > 0) {
      const badgeName = BADGE_EMOJIS[newBadges[0]] ? `${BADGE_EMOJIS[newBadges[0]]} ${newBadges[0].replace(/_/g, ' ')}` : newBadges[0];
      celebrations.push(`🎉 NEW BADGE: ${badgeName}`);
    }

    // Check for streak record (only if we have a previous record to compare)
    if (config.lastKnownLongestStreak !== undefined &&
        profile.currentStreak > config.lastKnownLongestStreak &&
        profile.currentStreak > 1) {
      celebrations.push(`🔥 NEW STREAK RECORD: ${profile.currentStreak} days!`);
    }

    // Save new state for next time
    await saveConfig({
      ...config,
      lastKnownBadges: profile.badges,
      lastKnownRank: profile.rank,
      lastKnownLongestStreak: Math.max(profile.currentStreak, config.lastKnownLongestStreak || 0),
    });
  }

  // Show celebration header if any
  if (celebrations.length > 0) {
    console.log(`${colors.dim}┌${'─'.repeat(boxWidth - 2)}┐${colors.reset}`);
    for (const celebration of celebrations) {
      const celebPadding = Math.max(0, innerWidth - celebration.replace(/[^\x00-\x7F]/g, '  ').length + celebration.replace(/[\x00-\x7F]/g, '').length);
      console.log(`${colors.dim}│${colors.reset}  ${colors.bright}${colors.yellow}${celebration}${colors.reset}${' '.repeat(celebPadding)}  ${colors.dim}│${colors.reset}`);
    }
    console.log(`${colors.dim}├${'─'.repeat(boxWidth - 2)}┤${colors.reset}`);
  } else {
    // Top border (no celebration)
    console.log(`${colors.dim}┌${'─'.repeat(boxWidth - 2)}┐${colors.reset}`);
  }

  // Header line with username and rank
  if (config.username) {
    const username = `@${config.username}`;
    // Show rank as #X/Y for context
    const rankStr = profile && profile.totalUsers > 0
      ? `#${profile.rank}/${fmt(profile.totalUsers)}`
      : (profile ? `#${profile.rank}` : '');
    const headerPadding = innerWidth - username.length - rankStr.length;
    console.log(`${colors.dim}│${colors.reset}  ${colors.bright}${colors.cyan}${username}${colors.reset}${' '.repeat(headerPadding)}${colors.yellow}${rankStr}${colors.reset}  ${colors.dim}│${colors.reset}`);

    // Percentile line (the real flex)
    // rank 1 / 100 users = top 1%, rank 50 / 100 = top 50%
    if (profile && profile.totalUsers > 0) {
      const percentile = Math.max(1, Math.ceil((profile.rank / profile.totalUsers) * 100));
      const percentileStr = `Top ${percentile}%`;
      const percentilePadding = innerWidth - percentileStr.length;
      console.log(`${colors.dim}│${colors.reset}${' '.repeat(percentilePadding)}  ${colors.green}${percentileStr}${colors.reset}  ${colors.dim}│${colors.reset}`);
    }
  } else {
    const msg = 'Not logged in';
    const padding = innerWidth - msg.length;
    console.log(`${colors.dim}│${colors.reset}  ${colors.yellow}${msg}${colors.reset}${' '.repeat(padding)}  ${colors.dim}│${colors.reset}`);
  }

  // Separator
  console.log(`${colors.dim}├${'─'.repeat(boxWidth - 2)}┤${colors.reset}`);

  // Empty line
  console.log(`${colors.dim}│${colors.reset}${' '.repeat(boxWidth - 2)}${colors.dim}│${colors.reset}`);

  // Stats with progress bars
  const statLines = [
    { label: 'Messages', value: messages, color: colors.cyan },
    { label: 'Sessions', value: sessions, color: colors.magenta },
    { label: 'Tools', value: tools, color: colors.blue },
  ];

  for (const stat of statLines) {
    const label = pad(stat.label, 10);
    const bar = progressBar(stat.value, maxStat, 16);
    const valueStr = pad(fmt(stat.value), 8, 'right');
    console.log(`${colors.dim}│${colors.reset}  ${label}${bar}  ${stat.color}${valueStr}${colors.reset}  ${colors.dim}│${colors.reset}`);
  }

  // Empty line
  console.log(`${colors.dim}│${colors.reset}${' '.repeat(boxWidth - 2)}${colors.dim}│${colors.reset}`);

  // Badges and streak line
  if (profile && (profile.currentStreak > 0 || profile.badges.length > 0)) {
    let badgeLine = '';

    if (profile.currentStreak > 0) {
      badgeLine += `🔥 ${profile.currentStreak} day streak`;
    }

    if (profile.badges.length > 0) {
      const badgeEmojis = profile.badges
        .slice(0, 4)
        .map(b => BADGE_EMOJIS[b] || '')
        .filter(Boolean)
        .join(' ');
      if (badgeLine) badgeLine += '    ';
      badgeLine += badgeEmojis;
    }

    const padding = innerWidth - badgeLine.replace(/[^\x00-\x7F]/g, '  ').length + badgeLine.replace(/[\x00-\x7F]/g, '').length;
    console.log(`${colors.dim}│${colors.reset}  ${badgeLine}${' '.repeat(Math.max(0, padding))}  ${colors.dim}│${colors.reset}`);
    console.log(`${colors.dim}│${colors.reset}${' '.repeat(boxWidth - 2)}${colors.dim}│${colors.reset}`);
  }

  // Profile link
  if (config.username) {
    const link = `clawd.gg/u/${config.username}`;
    const padding = innerWidth - link.length;
    console.log(`${colors.dim}│${colors.reset}  ${colors.dim}${link}${colors.reset}${' '.repeat(padding)}  ${colors.dim}│${colors.reset}`);
  }

  // Bottom border
  console.log(`${colors.dim}└${'─'.repeat(boxWidth - 2)}┘${colors.reset}`);

  // Status messages below the box
  console.log();

  if (!config.token) {
    log.dim("Run `clawd login` to join the leaderboard");
  } else if (!profile) {
    log.dim("Run `clawd sync` to update your stats");
  } else if (config.lastSyncDate) {
    log.dim(`Last synced: ${config.lastSyncDate}`);
  }

  console.log();
}

function showHelp(): void {
  console.log(`
${colors.bright}${colors.cyan}clawd.gg${colors.reset} ${colors.dim}— I built this to track how much you use me${colors.reset}

${colors.bright}Commands:${colors.reset}
  ${colors.green}gg${colors.reset}       Sync + status ${colors.dim}(the ultimate flex)${colors.reset}
  ${colors.green}login${colors.reset}    Link your GitHub ${colors.dim}(so I know who's flexing)${colors.reset}
  ${colors.green}sync${colors.reset}     Upload your stats ${colors.dim}(yes, I count my own tool calls)${colors.reset}
  ${colors.green}status${colors.reset}   See where you stand
  ${colors.green}logout${colors.reset}   Unlink your account
  ${colors.green}help${colors.reset}     You're looking at it

${colors.bright}Options:${colors.reset}
  ${colors.yellow}--force${colors.reset}  Re-upload everything ${colors.dim}(start fresh)${colors.reset}

${colors.bright}Quick start:${colors.reset}
  ${colors.dim}$ clawd login   # authenticate once${colors.reset}
  ${colors.dim}$ clawd sync    # upload stats${colors.reset}
  ${colors.dim}$ clawd status  # check your rank${colors.reset}

${colors.dim}Stats from: ~/.claude/stats-cache.json${colors.reset}
${colors.dim}Leaderboard: https://clawd.gg${colors.reset}
`);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const hasForceFlag = args.includes("--force") || args.includes("-f");

  switch (command) {
    case "gg":
      // The ultimate flex: sync + status
      await cmdSync(hasForceFlag);
      await cmdStatus();
      break;
    case "sync":
      await cmdSync(hasForceFlag);
      break;
    case "login":
      await cmdLogin();
      break;
    case "logout": {
      const config = await loadConfig();
      if (!config.token) {
        log.info("You weren't logged in anyway.");
      } else {
        await saveConfig({});
        log.success("Logged out. Your local stats are still here.");
      }
      break;
    }
    case "status":
      await cmdStatus();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log("clawd v0.1.0");
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
