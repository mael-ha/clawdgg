// Shared types for clawd.gg

// Stats from ~/.claude/stats-cache.json
export interface DailyActivity {
  date: string;  // YYYY-MM-DD
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
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
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
  badges?: string[];  // Badge IDs
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
