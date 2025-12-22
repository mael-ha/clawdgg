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
  // Legacy (kept for backward compat)
  messageCount: number;
  toolCallCount: number;
  sessionCount: number;
  // Enhanced display fields
  badges?: string[];        // Array of badge IDs
  currentStreak?: number;   // Current streak in days
  rankChange?: number;      // Change since yesterday (+3, -2, 0)
  lastActive?: Date | null; // Last activity timestamp
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  period: 'today' | 'week' | 'month' | 'all';
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
