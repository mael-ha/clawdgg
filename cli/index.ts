#!/usr/bin/env bun
import { readFile, writeFile, mkdir, chmod, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CONFIG_DIR = join(homedir(), ".config", "clawd");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CACHE_FILE = join(CONFIG_DIR, "cache.json");
// Legacy config location (for migration)
const LEGACY_CONFIG_DIR = join(homedir(), ".clawd-gg");
const LEGACY_CONFIG_FILE = join(LEGACY_CONFIG_DIR, "config.json");

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

interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

interface LongestSession {
  messageCount: number;
  duration: number;
  timestamp: string;
}

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

interface Stats {
  dailyActivity: DailyActivity[];
  dailyModelTokens?: DailyModelTokens[];  // Token data per day
  modelUsage?: Record<string, ModelUsage>;  // Lifetime totals by model
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

// ============= RAW FILE PARSING =============
// Parse raw .jsonl session files instead of relying on stats-cache.json
// stats-cache.json misses ~50% of usage (agent sessions excluded!)

interface DailyParsedStats {
  // Core metrics
  promptCount: number;      // User messages only (YOUR engagement)
  messageCount: number;     // All messages (user + assistant) - kept for backward compat
  toolCallCount: number;

  // Token metrics
  inputTokens: number;
  outputTokens: number;
  tokensByModel: Record<string, number>;  // model -> tokens

  // Code metrics (from Edit/Write tools)
  linesWritten: number;     // Lines of code written
  filesEdited: Set<string>; // Unique file paths edited (stored as Set, serialized as count)
  commitCount: number;      // Git commits detected
}

interface ParsedStatsCache {
  version: number;
  lastParsedAt: string; // ISO timestamp
  dailyStats: Record<string, DailyParsedStats>; // date -> stats
  hourCounts: Record<string, number>; // hour -> message count (for badges)
  longestSessionMessages: number;
  firstSessionDate?: string;

  // Aggregate stats (computed across all days)
  totalFilesEdited: number;  // Unique files across all time
  languageBreakdown: Record<string, number>;  // extension -> lines written
}

// Find all .jsonl session files
async function findSessionFiles(): Promise<string[]> {
  const files: string[] = [];

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    return files;
  }

  // Recursively find all .jsonl files
  async function walkDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  await walkDir(CLAUDE_PROJECTS_DIR);
  return files;
}

// Check if any file is newer than the cache
async function anyFileModifiedSince(files: string[], since: string | undefined): Promise<boolean> {
  if (!since) return true; // No cache, need full parse

  const sinceTime = new Date(since).getTime();

  for (const file of files) {
    try {
      const fileStat = await stat(file);
      if (fileStat.mtimeMs > sinceTime) {
        return true;
      }
    } catch {
      // Skip inaccessible files
    }
  }

  return false;
}

// Helper: Count lines in a string
function countLines(str: string): number {
  if (!str) return 0;
  return str.split('\n').length;
}

// Helper: Get file extension from path
function getExtension(filepath: string): string {
  const match = filepath.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : 'unknown';
}

// Helper: Initialize empty daily stats
function emptyDailyStats(): DailyParsedStats {
  return {
    promptCount: 0,
    messageCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokensByModel: {},
    linesWritten: 0,
    filesEdited: new Set(),
    commitCount: 0,
  };
}

// Parse a single .jsonl file
async function parseSessionFile(filepath: string): Promise<{
  dailyStats: Record<string, DailyParsedStats>;
  hourCounts: Record<string, number>;
  sessionMessages: number;
  firstDate?: string;
  allFilesEdited: Set<string>;
  languageLines: Record<string, number>;
}> {
  const dailyStats: Record<string, DailyParsedStats> = {};
  const hourCounts: Record<string, number> = {};
  const allFilesEdited = new Set<string>();
  const languageLines: Record<string, number> = {};
  let sessionMessages = 0;
  let firstDate: string | undefined;

  try {
    const fileStream = createReadStream(filepath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);
        const timestamp = entry.timestamp;
        if (!timestamp) continue;

        const date = timestamp.slice(0, 10); // "2025-12-12"
        const hour = timestamp.slice(11, 13); // "14" from "14:30:00"

        // Track first date
        if (!firstDate || date < firstDate) {
          firstDate = date;
        }

        // Get message info
        const msg = entry.message || {};
        const role = msg.role;
        const model = msg.model || '';

        // Initialize daily stats if needed
        if (!dailyStats[date]) {
          dailyStats[date] = emptyDailyStats();
        }

        const dayStats = dailyStats[date];

        // Count prompts (user messages only) and all messages
        if (role === 'user') {
          dayStats.promptCount++;
          dayStats.messageCount++;
          sessionMessages++;
          hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        } else if (role === 'assistant') {
          dayStats.messageCount++;
          sessionMessages++;
          hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        }

        // Process assistant messages for tool calls and code metrics
        if (role === 'assistant') {
          const content = msg.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item && typeof item === 'object' && item.type === 'tool_use') {
                dayStats.toolCallCount++;
                const toolName = item.name;
                const input = item.input || {};

                // Track Edit tool - lines of code written
                if (toolName === 'Edit' && input.new_string && input.old_string) {
                  const newLines = countLines(input.new_string);
                  const oldLines = countLines(input.old_string);
                  const linesAdded = Math.max(0, newLines - oldLines);
                  dayStats.linesWritten += linesAdded;

                  if (input.file_path) {
                    dayStats.filesEdited.add(input.file_path);
                    allFilesEdited.add(input.file_path);
                    const ext = getExtension(input.file_path);
                    languageLines[ext] = (languageLines[ext] || 0) + linesAdded;
                  }
                }

                // Track Write tool - new files
                if (toolName === 'Write' && input.content) {
                  const lines = countLines(input.content);
                  dayStats.linesWritten += lines;

                  if (input.file_path) {
                    dayStats.filesEdited.add(input.file_path);
                    allFilesEdited.add(input.file_path);
                    const ext = getExtension(input.file_path);
                    languageLines[ext] = (languageLines[ext] || 0) + lines;
                  }
                }

                // Track git commits from Bash
                if (toolName === 'Bash' && input.command) {
                  const cmd = input.command as string;
                  if (cmd.includes('git commit')) {
                    dayStats.commitCount++;
                  }
                }
              }
            }
          }
        }

        // Extract token usage (only on assistant messages with usage)
        const usage = msg.usage;
        if (usage) {
          const inputTok = usage.input_tokens || 0;
          const outputTok = usage.output_tokens || 0;
          dayStats.inputTokens += inputTok;
          dayStats.outputTokens += outputTok;

          // Track by model
          if (model) {
            dayStats.tokensByModel[model] = (dayStats.tokensByModel[model] || 0) + inputTok + outputTok;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Skip inaccessible files
  }

  return { dailyStats, hourCounts, sessionMessages, firstDate, allFilesEdited, languageLines };
}

// Parse all session files and aggregate
async function parseAllSessionFiles(files: string[]): Promise<ParsedStatsCache> {
  const aggregated: Record<string, DailyParsedStats> = {};
  const hourCounts: Record<string, number> = {};
  const allFilesEdited = new Set<string>();
  const languageBreakdown: Record<string, number> = {};
  let longestSessionMessages = 0;
  let firstSessionDate: string | undefined;

  // Parse files in parallel (batched to avoid too many open files)
  const BATCH_SIZE = 50;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(f => parseSessionFile(f)));

    for (const result of results) {
      // Track longest session
      if (result.sessionMessages > longestSessionMessages) {
        longestSessionMessages = result.sessionMessages;
      }

      // Track first date
      if (result.firstDate && (!firstSessionDate || result.firstDate < firstSessionDate)) {
        firstSessionDate = result.firstDate;
      }

      // Aggregate all files edited (across all time)
      for (const file of result.allFilesEdited) {
        allFilesEdited.add(file);
      }

      // Aggregate language breakdown
      for (const [ext, lines] of Object.entries(result.languageLines)) {
        languageBreakdown[ext] = (languageBreakdown[ext] || 0) + lines;
      }

      // Aggregate daily stats
      for (const [date, stats] of Object.entries(result.dailyStats)) {
        if (!aggregated[date]) {
          aggregated[date] = emptyDailyStats();
        }
        const agg = aggregated[date];
        agg.promptCount += stats.promptCount;
        agg.messageCount += stats.messageCount;
        agg.toolCallCount += stats.toolCallCount;
        agg.inputTokens += stats.inputTokens;
        agg.outputTokens += stats.outputTokens;
        agg.linesWritten += stats.linesWritten;
        agg.commitCount += stats.commitCount;

        // Merge files edited sets
        for (const file of stats.filesEdited) {
          agg.filesEdited.add(file);
        }

        // Merge tokensByModel
        for (const [model, tokens] of Object.entries(stats.tokensByModel)) {
          agg.tokensByModel[model] = (agg.tokensByModel[model] || 0) + tokens;
        }
      }

      // Aggregate hour counts
      for (const [hour, count] of Object.entries(result.hourCounts)) {
        hourCounts[hour] = (hourCounts[hour] || 0) + count;
      }
    }
  }

  return {
    version: 2, // Bumped version for new format
    lastParsedAt: new Date().toISOString(),
    dailyStats: aggregated,
    hourCounts,
    longestSessionMessages,
    firstSessionDate,
    totalFilesEdited: allFilesEdited.size,
    languageBreakdown,
  };
}

// Serializable version of DailyParsedStats (Sets converted to counts)
interface SerializedDailyStats {
  promptCount: number;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  tokensByModel: Record<string, number>;
  linesWritten: number;
  filesEditedCount: number;  // Set converted to count
  commitCount: number;
}

interface SerializedCache {
  version: number;
  lastParsedAt: string;
  dailyStats: Record<string, SerializedDailyStats>;
  hourCounts: Record<string, number>;
  longestSessionMessages: number;
  firstSessionDate?: string;
  totalFilesEdited: number;
  languageBreakdown: Record<string, number>;
}

// Load our parsed stats cache
async function loadParsedCache(): Promise<ParsedStatsCache | null> {
  try {
    if (!existsSync(CACHE_FILE)) {
      return null;
    }
    const data = await readFile(CACHE_FILE, 'utf-8');
    const serialized: SerializedCache = JSON.parse(data);

    // Check version - force re-parse if old format
    if (serialized.version < 2) {
      return null;
    }

    // Convert back to ParsedStatsCache (recreate Sets)
    const dailyStats: Record<string, DailyParsedStats> = {};
    for (const [date, stats] of Object.entries(serialized.dailyStats)) {
      dailyStats[date] = {
        ...stats,
        filesEdited: new Set(), // Can't restore actual files, but that's ok
      };
    }

    return {
      ...serialized,
      dailyStats,
    };
  } catch {
    return null;
  }
}

// Save our parsed stats cache
async function saveParsedCache(cache: ParsedStatsCache): Promise<void> {
  // Convert Sets to counts for JSON serialization
  const serializedDailyStats: Record<string, SerializedDailyStats> = {};
  for (const [date, stats] of Object.entries(cache.dailyStats)) {
    serializedDailyStats[date] = {
      promptCount: stats.promptCount,
      messageCount: stats.messageCount,
      toolCallCount: stats.toolCallCount,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      tokensByModel: stats.tokensByModel,
      linesWritten: stats.linesWritten,
      filesEditedCount: stats.filesEdited.size,
      commitCount: stats.commitCount,
    };
  }

  const serialized: SerializedCache = {
    version: cache.version,
    lastParsedAt: cache.lastParsedAt,
    dailyStats: serializedDailyStats,
    hourCounts: cache.hourCounts,
    longestSessionMessages: cache.longestSessionMessages,
    firstSessionDate: cache.firstSessionDate,
    totalFilesEdited: cache.totalFilesEdited,
    languageBreakdown: cache.languageBreakdown,
  };

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CACHE_FILE, JSON.stringify(serialized, null, 2), { mode: 0o600 });
}

// Main function to get stats (uses cache if fresh, re-parses if needed)
async function getRawStats(): Promise<ParsedStatsCache | null> {
  const files = await findSessionFiles();

  if (files.length === 0) {
    log.error("No Claude Code session files found");
    log.dim("Make sure Claude Code is installed and you've used it at least once.");
    return null;
  }

  const cache = await loadParsedCache();
  const needsReparse = await anyFileModifiedSince(files, cache?.lastParsedAt);

  if (!needsReparse && cache) {
    log.dim(`Using cached stats (${files.length} files unchanged)`);
    return cache;
  }

  log.info(`Parsing ${files.length} session files...`);
  const startTime = Date.now();
  const parsed = await parseAllSessionFiles(files);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.dim(`Parsed in ${elapsed}s`);

  await saveParsedCache(parsed);
  return parsed;
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
    // Check new location first
    if (existsSync(CONFIG_FILE)) {
      const data = await readFile(CONFIG_FILE, "utf-8");
      return JSON.parse(data);
    }

    // Fall back to legacy location and migrate if found
    if (existsSync(LEGACY_CONFIG_FILE)) {
      const data = await readFile(LEGACY_CONFIG_FILE, "utf-8");
      const config = JSON.parse(data);
      // Migrate to new location
      await saveConfig(config);
      log.dim("Migrated config from ~/.clawd-gg to ~/.config/clawd");
      return config;
    }

    return {};
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
  dailyModelTokens: DailyModelTokens[] | undefined,
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
        dailyModelTokens,
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

  // Load stats from raw session files (not stats-cache.json which misses ~50%!)
  const rawStats = await getRawStats();
  if (!rawStats) {
    process.exit(1);
  }

  const today = getTodayDate();
  const lastSync = forceFullSync ? null : config.lastSyncDate;

  if (forceFullSync && config.lastSyncDate) {
    log.warn("Force sync: re-uploading all historical data...");
  }

  // Convert parsed stats to daily activity format (with new metrics)
  const allDays = Object.entries(rawStats.dailyStats).map(([date, stats]) => ({
    date,
    promptCount: stats.promptCount,
    messageCount: stats.messageCount,
    toolCallCount: stats.toolCallCount,
    linesWritten: stats.linesWritten,
    commitCount: stats.commitCount,
    sessionCount: 1, // Legacy, kept for backward compat
  }));

  // Filter out today (incomplete) and already-synced days (unless force)
  const activityToSync = allDays.filter(day => {
    if (day.date === today) return false;
    if (lastSync && day.date <= lastSync) return false;
    return true;
  });

  // Calculate totals
  const totalPrompts = Object.values(rawStats.dailyStats).reduce((sum, d) => sum + d.promptCount, 0);
  const totalTokens = Object.values(rawStats.dailyStats).reduce((sum, d) => sum + d.inputTokens + d.outputTokens, 0);
  const totalLines = Object.values(rawStats.dailyStats).reduce((sum, d) => sum + d.linesWritten, 0);

  // Show summary
  console.log(`${colors.dim}Total prompts: ${totalPrompts.toLocaleString()}${colors.reset}`);
  console.log(`${colors.dim}Total tokens: ${formatTokens(totalTokens)} (input + output)${colors.reset}`);
  console.log(`${colors.dim}Lines written: ${totalLines.toLocaleString()}${colors.reset}`);
  console.log(`${colors.dim}Days tracked: ${Object.keys(rawStats.dailyStats).length}${colors.reset}`);

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
    hourCounts: rawStats.hourCounts,
    longestSessionMessages: rawStats.longestSessionMessages,
  };

  // Build token data per day (for the API)
  const datesToSync = new Set(activityToSync.map(d => d.date));
  const tokensToSync: DailyModelTokens[] = Object.entries(rawStats.dailyStats)
    .filter(([date]) => datesToSync.has(date))
    .map(([date, stats]) => ({
      date,
      tokensByModel: { 'raw-parsed': stats.inputTokens + stats.outputTokens },
    }));

  try {
    const result = await syncStats(activityToSync, tokensToSync, rawStats.firstSessionDate, badgeData, config.token);

    // Update lastSyncDate in config
    if (result.lastDate) {
      await saveConfig({ ...config, lastSyncDate: result.lastDate });
    } else if (activityToSync.length > 0) {
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

// Format tokens with K/M/B suffix
function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toString();
}

interface ProfileData {
  username: string;
  rank: number;
  totalUsers: number;
  totalMessages: number;
  totalSessions: number;
  totalToolCalls: number;
  totalTokens: number;
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

  // If logged in, try to fetch online profile
  let profile: ProfileData | null = null;
  if (config.token) {
    profile = await fetchProfile(config.token);
  }

  // Get local stats from raw files (accurate, includes agent sessions)
  const rawStats = await getRawStats();

  // Calculate local totals from raw parsed data
  let localPrompts = 0;
  let localMessages = 0;
  let localTokens = 0;
  let localLines = 0;
  let localCommits = 0;

  if (rawStats) {
    for (const stats of Object.values(rawStats.dailyStats)) {
      localPrompts += stats.promptCount;
      localMessages += stats.messageCount;
      localTokens += stats.inputTokens + stats.outputTokens;
      localLines += stats.linesWritten;
      localCommits += stats.commitCount;
    }
  }

  // Use local data (more accurate than server for now)
  const prompts = localPrompts;
  const tokens = localTokens;
  const lines = localLines;
  const commits = localCommits;
  const filesEdited = rawStats?.totalFilesEdited || 0;
  const tokensPerPrompt = prompts > 0 ? Math.round(tokens / prompts) : 0;

  // For progress bars, scale based on prompts and lines
  const maxStat = Math.max(prompts, lines, 1);

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

  // Primary stat: Prompts sent (YOUR engagement)
  const promptsLabel = pad('Prompts', 10);
  const promptsBar = progressBar(prompts, maxStat, 16);
  const promptsValue = pad(fmt(prompts), 8, 'right');
  console.log(`${colors.dim}│${colors.reset}  ${promptsLabel}${promptsBar}  ${colors.cyan}${promptsValue}${colors.reset}  ${colors.dim}│${colors.reset}`);

  // Lines of code (if any)
  if (lines > 0) {
    const linesLabel = pad('Lines', 10);
    const linesBar = progressBar(lines, maxStat, 16);
    const linesValue = pad(fmt(lines), 8, 'right');
    console.log(`${colors.dim}│${colors.reset}  ${linesLabel}${linesBar}  ${colors.green}${linesValue}${colors.reset}  ${colors.dim}│${colors.reset}`);
  }

  // Tokens line - the flex stat
  const tokensLabel = pad('Tokens', 10);
  const tokensValue = formatTokens(tokens);
  const tokensPadding = 16 + 2 + 8 - tokensValue.length - 2;
  console.log(`${colors.dim}│${colors.reset}  ${tokensLabel}${' '.repeat(tokensPadding)}${colors.yellow}${tokensValue} ⚡${colors.reset}  ${colors.dim}│${colors.reset}`);

  // Tokens per prompt (conversation depth)
  if (tokensPerPrompt > 0) {
    const tppLabel = pad('', 10);  // No label, it's a sub-stat
    const tppValue = `${fmt(tokensPerPrompt)} tok/prompt`;
    const tppPadding = 16 + 2 + 8 - tppValue.length;
    console.log(`${colors.dim}│${colors.reset}  ${tppLabel}${' '.repeat(tppPadding)}${colors.dim}${tppValue}${colors.reset}  ${colors.dim}│${colors.reset}`);
  }

  // Secondary stats: Commits, Files (if any)
  if (commits > 0 || filesEdited > 0) {
    console.log(`${colors.dim}│${colors.reset}${' '.repeat(boxWidth - 2)}${colors.dim}│${colors.reset}`);
    let secondaryLine = '  ';
    if (commits > 0) {
      secondaryLine += `📦 ${commits} commits`;
      if (filesEdited > 0) secondaryLine += '  ';
    }
    if (filesEdited > 0) {
      secondaryLine += `📁 ${filesEdited} files`;
    }
    const secondaryPadding = innerWidth - secondaryLine.length + 2;
    console.log(`${colors.dim}│${colors.reset}${secondaryLine}${' '.repeat(Math.max(0, secondaryPadding))}  ${colors.dim}│${colors.reset}`);
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

${colors.dim}Stats from: ~/.claude/projects/*/*.jsonl (raw session files)${colors.reset}
${colors.dim}Cache: ~/.config/clawd/cache.json${colors.reset}
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
