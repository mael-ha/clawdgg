// Shared types for clawd.gg
//
// The CLI-upload cluster that used to live at the top — StatsSubmission,
// StatsCache, DailyActivity, DailyModelTokens, LongestSession and a second
// `ModelUsage` — described the body POST /api/stats accepted when the CLI
// uploaded daily summaries. That endpoint is a 410 and nothing imported any of
// those types; `ModelUsage` in particular was a same-named, different-shaped
// twin of the one in src/db/clickhouse.ts, which is the one that is real.

// API types

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
