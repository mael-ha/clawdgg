// Shared types for clawd.gg

// Stats submitted from CLI (raw parsed data)
export interface DailyActivity {
  date: string;  // YYYY-MM-DD
  promptCount: number;      // User messages only (YOUR engagement)
  messageCount: number;     // All messages (for backward compat)
  toolCallCount: number;
  // V3: Full token breakdown for accurate cost calculation
  inputTokens?: number;          // New input (billable at full rate)
  outputTokens?: number;         // Responses (billable at output rate)
  cacheReadTokens?: number;      // Cached context reused (0.1x rate)
  cacheCreationTokens?: number;  // New cache created (1.25x rate)
  costUsdCents?: number;         // Calculated cost in cents
  // Code metrics
  linesWritten: number;     // Lines of code written
  commitCount: number;      // Git commits
  sessionCount: number;     // Legacy, kept for backward compat
}

export interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
}

export interface LongestSession {
  sessionId: string;
  duration: number;  // milliseconds
  messageCount: number;
  timestamp: string;
}

export interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  modelUsage: Record<string, ModelUsage>;
  totalSessions: number;
  totalMessages: number;
  longestSession: LongestSession;
  firstSessionDate: string;
  hourCounts: Record<string, number>;
}

// API types
export interface StatsSubmission {
  dailyActivity: DailyActivity[];
  dailyModelTokens?: DailyModelTokens[];  // Token data per day
  totalMessages: number;
  totalSessions: number;
  firstSessionDate?: string;
  // Badge-relevant data
  hourCounts?: Record<string, number>;
  longestSessionMessages?: number;
  // Official stats-cache.json data (to match Claude Code's /stats exactly)
  officialDates?: string[];  // Dates from stats-cache.json for accurate streak calculation
  officialCurrentStreak?: number;  // Calculated from stats-cache.json
  officialLongestStreak?: number;  // Calculated from stats-cache.json
  officialActiveDays?: number;     // Count of unique days in stats-cache.json
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  githubUsername: string;
  avatarUrl: string | null;
  // Primary metrics
  promptCount: number;      // User messages (YOUR engagement) - THE primary metric
  tokenCount: number;       // Total tokens (the flex stat)
  // Code metrics
  linesWritten: number;     // Lines of code written
  commitCount: number;      // Git commits
  // V2 OTel: Cost tracking
  costUsdCents?: number;    // Cost in cents (divide by 100 for USD)
  // Pre-OTEL CLI concepts with no source left. `messageCount` counted
  // assistant+user messages and ClickHouse has no equivalent; the other two are
  // answerable but nothing renders them. Omitted rather than reported as 0 —
  // a fabricated zero reads as "none", not as "not measured".
  messageCount?: number;
  toolCallCount?: number;
  sessionCount?: number;
  // Enhanced display fields
  badges?: string[];        // Array of badge IDs
  currentStreak?: number;   // Current streak in days
  rankChange?: number;      // Change since yesterday (+3, -2, 0)
  lastActive?: Date | null; // Last activity timestamp
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  period: 'today' | 'week' | 'month' | 'all';
  /**
   * What `period` actually measures, spelled out.
   *
   * This endpoint's `week` and `month` are ROLLING windows — the last 7 and 30
   * UTC days — while /api/boards means the calendar week from Monday 00:00 UTC.
   * Two endpoints answering "this week" with two different windows is the kind
   * of thing a reader cannot see, so the window says which one this is rather
   * than the caller having to know. Changing the windows to match would change
   * what a public endpoint returns for an unchanged request, which is the one
   * thing worse than the inconsistency.
   */
  window: 'all time' | 'today, UTC' | 'rolling 7 UTC days' | 'rolling 30 UTC days';
  total: number;
  page: number;
  pageSize: number;
}

// User types
export interface User {
  id: string;
  githubId: string;
  githubUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
  firstSessionDate: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionUser {
  id: string;
  githubUsername: string;
  avatarUrl: string | null;
}
