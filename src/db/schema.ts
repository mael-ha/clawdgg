import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Users table
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  githubId: text('github_id').notNull().unique(),
  githubUsername: text('github_username').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  firstSessionDate: text('first_session_date'), // YYYY-MM-DD

  // IANA zone name, e.g. 'Europe/Paris'. Set by `clawdgg setup` from the
  // machine's own Intl resolution, and changeable at PUT /api/me/timezone.
  // EVERY hour-of-day, weekday and week-boundary query converts with it
  // (ClickHouse toTimeZone) — see src/lib/timezone.ts for why. 'UTC' is the
  // honest default: it is what the raw timestamps already are.
  timezone: text('timezone').notNull().default('UTC'),

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
  otelSetupAt: integer('otel_setup_at', { mode: 'timestamp' }), // When user ran `clawdgg setup`
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

  // Token generation counter for revocation of the LEGACY (pre-CLI-2.0) bearer
  // format, which carried the gen number it was issued with. Those tokens were
  // per-user, so a bump logged every machine out at once — which is why
  // device_tokens replaced them. Still read by verifyBearerToken so the one
  // outstanding legacy token keeps working until it re-logs in; still bumped by
  // "revoke all devices", which must kill legacy tokens too.
  tokenGen: integer('token_gen').notNull().default(1),

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

// One row per `clawdgg login` — a revocable credential for ONE machine.
//
// The bearer the CLI holds is `cgt_<id>.<secret>`: the id selects this row, the
// secret is compared against secretHash. Only the hash is stored, so a dump of
// this table cannot be replayed as a token. Revoking a row logs out exactly
// that machine and nothing else, which is the whole reason it exists — the
// users.token_gen scheme it replaced could only revoke every device at once.
export const deviceTokens = sqliteTable('device_tokens', {
  id: text('id').primaryKey(), // 32 hex chars, the public half of the bearer
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Defaults to the machine's hostname; the user can rename it.
  deviceName: text('device_name').notNull(),
  // SHA-256 of the secret half, hex. NEVER the secret itself.
  secretHash: text('secret_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  // Written at most once per LAST_USED_THROTTLE_MS — this is touched by the
  // OTLP ingest path, which runs on every exported batch.
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
}, (table) => ({
  userIdx: index('device_tokens_user_idx').on(table.userId),
}));

// Plan usage snapshots (Pro/Max rate-limit windows captured via the statusLine hook)
// One row per observed CHANGE of a window — see src/lib/plan-usage.ts for the
// dedup rule. Timestamps are raw unix epoch SECONDS (not `mode: 'timestamp'`)
// because resetsAt arrives from Claude Code already in that form.
export const planUsageSnapshots = sqliteTable('plan_usage_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  windowType: text('window_type').notNull(), // 'five_hour' | 'seven_day' | 'spend_limit'
  usedPercentage: real('used_percentage').notNull(), // 0-100
  resetsAt: integer('resets_at'), // null when Claude Code omitted it
  capturedAt: integer('captured_at').notNull(),
}, (table) => ({
  userWindowCapturedIdx: index('plan_usage_user_window_captured_idx').on(
    table.userId,
    table.windowType,
    table.capturedAt
  ),
}));

// Export types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type DailyStat = typeof dailyStats.$inferSelect;
export type NewDailyStat = typeof dailyStats.$inferInsert;
export type DeviceAuth = typeof deviceAuths.$inferSelect;
export type NewDeviceAuth = typeof deviceAuths.$inferInsert;
export type DeviceToken = typeof deviceTokens.$inferSelect;
export type NewDeviceToken = typeof deviceTokens.$inferInsert;
export type PlanUsageSnapshot = typeof planUsageSnapshots.$inferSelect;
export type NewPlanUsageSnapshot = typeof planUsageSnapshots.$inferInsert;
