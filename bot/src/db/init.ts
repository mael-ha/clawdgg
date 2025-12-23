/**
 * Database initialization script
 * Run: bun bot/src/db/init.ts
 */

import { sqlite } from './index';

// Create tables directly using SQL
// (Alternative to using drizzle-kit migrations)

const SCHEMA = `
-- Versions table
CREATE TABLE IF NOT EXISTS versions (
  version TEXT PRIMARY KEY,
  brew_detected_at INTEGER,
  github_release_at INTEGER,
  prompt_diff_at INTEGER,
  release_notes TEXT,
  prompt_diff TEXT,
  prompt_diff_url TEXT,
  parsed_notes TEXT,
  announcement_tweet_id TEXT,
  added_tweet_id TEXT,
  fixed_tweet_id TEXT,
  improved_tweet_id TEXT,
  prompt_tweet_id TEXT,
  links_tweet_id TEXT,
  status TEXT NOT NULL DEFAULT 'detected',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS status_idx ON versions(status);
CREATE INDEX IF NOT EXISTS brew_detected_idx ON versions(brew_detected_at);

-- Download stats table
CREATE TABLE IF NOT EXISTS download_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  npm_downloads INTEGER DEFAULT 0,
  brew_installs_30d INTEGER DEFAULT 0,
  brew_installs_90d INTEGER DEFAULT 0,
  brew_installs_365d INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Reddit posts table
CREATE TABLE IF NOT EXISTS reddit_posts (
  id TEXT PRIMARY KEY,
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  num_comments INTEGER DEFAULT 0,
  relevance_score INTEGER,
  tweet_id TEXT,
  tweeted_at INTEGER,
  status TEXT NOT NULL DEFAULT 'discovered',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

console.log('Initializing bot database...');

try {
  sqlite.exec(SCHEMA);
  console.log('Database initialized successfully');
} catch (error) {
  console.error('Failed to initialize database:', error);
  process.exit(1);
}
