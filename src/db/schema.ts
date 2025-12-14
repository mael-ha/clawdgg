import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Users table
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  githubId: text('github_id').notNull().unique(),
  githubUsername: text('github_username').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  firstSessionDate: text('first_session_date'), // YYYY-MM-DD
  // Badge-relevant stats (updated on sync)
  badges: text('badges'), // JSON array of badge IDs: ["night_owl", "streak_7", ...]
  hourCounts: text('hour_counts'), // JSON object: {"0": 5, "1": 2, ...}
  longestSessionMessages: integer('longest_session_messages').default(0),
  currentStreak: integer('current_streak').default(0),
  longestStreak: integer('longest_streak').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => ({
  githubIdIdx: uniqueIndex('github_id_idx').on(table.githubId),
  githubUsernameIdx: index('github_username_idx').on(table.githubUsername),
}));

// Daily stats table
export const dailyStats = sqliteTable('daily_stats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  date: text('date').notNull(), // YYYY-MM-DD

  // Core metrics
  promptCount: integer('prompt_count').notNull().default(0),     // User messages only (YOUR engagement)
  messageCount: integer('message_count').notNull().default(0),   // All messages (kept for backward compat)
  toolCallCount: integer('tool_call_count').notNull().default(0),
  tokenCount: integer('token_count').notNull().default(0),

  // Code metrics
  linesWritten: integer('lines_written').notNull().default(0),   // Lines of code written
  commitCount: integer('commit_count').notNull().default(0),     // Git commits

  // Legacy (kept for backward compat)
  sessionCount: integer('session_count').notNull().default(0),

  submittedAt: integer('submitted_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => ({
  userDateIdx: uniqueIndex('user_date_idx').on(table.userId, table.date),
  dateIdx: index('date_idx').on(table.date),
  userIdIdx: index('user_id_idx').on(table.userId),
  // Indexes for leaderboard queries
  promptCountIdx: index('prompt_count_idx').on(table.promptCount),
  messageCountIdx: index('message_count_idx').on(table.messageCount),
  toolCallCountIdx: index('tool_call_count_idx').on(table.toolCallCount),
  tokenCountIdx: index('token_count_idx').on(table.tokenCount),
  linesWrittenIdx: index('lines_written_idx').on(table.linesWritten),
  commitCountIdx: index('commit_count_idx').on(table.commitCount),
}));

// Device auth table (for CLI login flow)
export const deviceAuths = sqliteTable('device_auths', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceCode: text('device_code').notNull().unique(),
  userCode: text('user_code').notNull().unique(),
  expiresAt: integer('expires_at').notNull(), // Unix timestamp in ms
  userId: text('user_id'),
  username: text('username'),
  token: text('token'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => ({
  deviceCodeIdx: uniqueIndex('device_code_idx').on(table.deviceCode),
  userCodeIdx: uniqueIndex('user_code_idx').on(table.userCode),
  expiresAtIdx: index('expires_at_idx').on(table.expiresAt),
}));

// Export types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type DailyStat = typeof dailyStats.$inferSelect;
export type NewDailyStat = typeof dailyStats.$inferInsert;
export type DeviceAuth = typeof deviceAuths.$inferSelect;
export type NewDeviceAuth = typeof deviceAuths.$inferInsert;
