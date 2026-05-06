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

  // ═══════════════════════════════════════════════════════════════════════
  // OTel V2: Cached totals (synced from ClickHouse every 5 min)
  // ═══════════════════════════════════════════════════════════════════════
  totalPrompts: integer('total_prompts').default(0),
  totalTokens: integer('total_tokens').default(0),          // input + output (bigint in practice)
  totalInputTokens: integer('total_input_tokens').default(0),
  totalOutputTokens: integer('total_output_tokens').default(0),
  totalCacheReadTokens: integer('total_cache_read_tokens').default(0),
  totalCacheCreationTokens: integer('total_cache_creation_tokens').default(0),
  totalCostCents: integer('total_cost_cents').default(0),   // Cost in cents (divide by 100 for USD)
  totalLinesAdded: integer('total_lines_added').default(0),
  totalCommits: integer('total_commits').default(0),
  totalPrs: integer('total_prs').default(0),
  totalActiveSeconds: integer('total_active_seconds').default(0),
  avgPromptLength: integer('avg_prompt_length').default(0), // Average chars per prompt

  // ═══════════════════════════════════════════════════════════════════════
  // Dashboard V2: Archetype system
  // ═══════════════════════════════════════════════════════════════════════
  archetype: text('archetype'),           // Primary archetype ID (e.g., "night_owl")
  archetypeSecondary: text('archetype_secondary'),  // Secondary archetype ID
  archetypeUpdatedAt: integer('archetype_updated_at', { mode: 'timestamp' }),

  // OTel status
  otelEnabled: integer('otel_enabled', { mode: 'boolean' }).default(false),
  otelSetupAt: integer('otel_setup_at', { mode: 'timestamp' }), // When user ran `clawd setup`
  otelSetupDate: text('otel_setup_date'), // YYYY-MM-DD for easy date comparison in queries

  // ═══════════════════════════════════════════════════════════════════════
  // Legacy Snapshot: Historical data frozen at OTEL enable time
  // These are added to OTEL totals to preserve complete history
  // ═══════════════════════════════════════════════════════════════════════
  legacyTotalPrompts: integer('legacy_total_prompts').default(0),
  legacyTotalTokens: integer('legacy_total_tokens').default(0),
  legacyTotalInputTokens: integer('legacy_total_input_tokens').default(0),
  legacyTotalOutputTokens: integer('legacy_total_output_tokens').default(0),
  legacyTotalCacheReadTokens: integer('legacy_total_cache_read_tokens').default(0),
  legacyTotalCacheCreationTokens: integer('legacy_total_cache_creation_tokens').default(0),
  legacyTotalCostUsdCents: integer('legacy_total_cost_usd_cents').default(0),
  legacyTotalLinesAdded: integer('legacy_total_lines_added').default(0),
  legacyTotalCommits: integer('legacy_total_commits').default(0),
  legacyTotalToolCalls: integer('legacy_total_tool_calls').default(0),
  legacyHourCounts: text('legacy_hour_counts'), // JSON: {"0": 5, "1": 2, ...} frozen at OTEL enable

  // Token management (extended to 1 year for OTel)
  tokenExpiresAt: integer('token_expires_at', { mode: 'timestamp' }),

  // Potential future: Anthropic account linking
  anthropicAccountUuid: text('anthropic_account_uuid'),

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
  tokenCount: integer('token_count').notNull().default(0),       // Legacy: input + output (for backwards compat)

  // ═══════════════════════════════════════════════════════════════════════
  // V2 Token Breakdown (all 4 types for accurate cost calculation)
  // ═══════════════════════════════════════════════════════════════════════
  inputTokens: integer('input_tokens').notNull().default(0),           // New input (billable at full rate)
  outputTokens: integer('output_tokens').notNull().default(0),         // Responses (billable at output rate)
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),  // Cached context reused (0.1x rate)
  cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0), // New cache (1.25x rate)
  costUsdCents: integer('cost_usd_cents').notNull().default(0),        // Calculated cost in cents

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
