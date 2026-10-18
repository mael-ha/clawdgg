-- V3: Add full token breakdown for accurate cost calculation
-- This migration adds columns to track all 4 token types + cost
--
-- Hand-written, so the breakpoint markers below are hand-written too: drizzle
-- splits a migration file on those and on nothing else, and better-sqlite3
-- refuses a string holding more than one statement.

-- Add new columns to daily_stats
ALTER TABLE daily_stats ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE daily_stats ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE daily_stats ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE daily_stats ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE daily_stats ADD COLUMN cost_usd_cents INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE users ADD COLUMN total_input_tokens INTEGER DEFAULT 0;--> statement-breakpoint
ALTER TABLE users ADD COLUMN total_output_tokens INTEGER DEFAULT 0;--> statement-breakpoint
ALTER TABLE users ADD COLUMN total_cache_read_tokens INTEGER DEFAULT 0;--> statement-breakpoint
ALTER TABLE users ADD COLUMN total_cache_creation_tokens INTEGER DEFAULT 0;
