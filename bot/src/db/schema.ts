import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ═══════════════════════════════════════════════════════════════════════════
// VERSION TRACKING
// Tracks each Claude Code version through its lifecycle
// ═══════════════════════════════════════════════════════════════════════════

export const versions = sqliteTable('versions', {
  version: text('version').primaryKey(),  // "2.0.76"

  // Detection timestamps
  brewDetectedAt: integer('brew_detected_at', { mode: 'timestamp' }),
  githubReleaseAt: integer('github_release_at', { mode: 'timestamp' }),
  promptDiffAt: integer('prompt_diff_at', { mode: 'timestamp' }),

  // Content (cached)
  releaseNotes: text('release_notes'),      // Raw release notes from GitHub
  promptDiff: text('prompt_diff'),          // Cleaned prompt diff
  promptDiffUrl: text('prompt_diff_url'),   // Gist URL

  // Parsed release notes (JSON)
  parsedNotes: text('parsed_notes'),        // JSON: { added: [], fixed: [], improved: [], other: [] }

  // Tweet IDs (for threading)
  announcementTweetId: text('announcement_tweet_id'),
  addedTweetId: text('added_tweet_id'),
  fixedTweetId: text('fixed_tweet_id'),
  improvedTweetId: text('improved_tweet_id'),
  promptTweetId: text('prompt_tweet_id'),
  linksTweetId: text('links_tweet_id'),

  // Status: detected | announced | detailed | complete
  status: text('status').notNull().default('detected'),

  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => ({
  statusIdx: index('status_idx').on(table.status),
  brewDetectedIdx: index('brew_detected_idx').on(table.brewDetectedAt),
}));

// ═══════════════════════════════════════════════════════════════════════════
// DOWNLOAD STATS
// Daily snapshots of npm + brew download counts
// ═══════════════════════════════════════════════════════════════════════════

export const downloadStats = sqliteTable('download_stats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(),  // YYYY-MM-DD

  // npm downloads
  npmDownloads: integer('npm_downloads').default(0),

  // brew installs (from analytics API)
  brewInstalls30d: integer('brew_installs_30d').default(0),
  brewInstalls90d: integer('brew_installs_90d').default(0),
  brewInstalls365d: integer('brew_installs_365d').default(0),

  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ═══════════════════════════════════════════════════════════════════════════
// REDDIT POSTS
// Tracks Reddit posts we've shared (to avoid duplicates)
// ═══════════════════════════════════════════════════════════════════════════

export const redditPosts = sqliteTable('reddit_posts', {
  id: text('id').primaryKey(),  // Reddit post ID
  subreddit: text('subreddit').notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  score: integer('score').default(0),
  numComments: integer('num_comments').default(0),

  // AI evaluation
  relevanceScore: integer('relevance_score'),  // 1-10

  // Tweet tracking
  tweetId: text('tweet_id'),
  tweetedAt: integer('tweeted_at', { mode: 'timestamp' }),

  // Status: discovered | evaluated | tweeted | skipped
  status: text('status').notNull().default('discovered'),

  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Export types
export type Version = typeof versions.$inferSelect;
export type NewVersion = typeof versions.$inferInsert;
export type DownloadStat = typeof downloadStats.$inferSelect;
export type NewDownloadStat = typeof downloadStats.$inferInsert;
export type RedditPost = typeof redditPosts.$inferSelect;
export type NewRedditPost = typeof redditPosts.$inferInsert;
