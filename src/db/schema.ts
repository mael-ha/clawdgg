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
  messageCount: integer('message_count').notNull().default(0),
  sessionCount: integer('session_count').notNull().default(0),
  toolCallCount: integer('tool_call_count').notNull().default(0),
  submittedAt: integer('submitted_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => ({
  userDateIdx: uniqueIndex('user_date_idx').on(table.userId, table.date),
  dateIdx: index('date_idx').on(table.date),
  userIdIdx: index('user_id_idx').on(table.userId),
  // Indexes for leaderboard queries
  messageCountIdx: index('message_count_idx').on(table.messageCount),
  sessionCountIdx: index('session_count_idx').on(table.sessionCount),
  toolCallCountIdx: index('tool_call_count_idx').on(table.toolCallCount),
}));

// Export types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type DailyStat = typeof dailyStats.$inferSelect;
export type NewDailyStat = typeof dailyStats.$inferInsert;
