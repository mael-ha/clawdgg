DROP INDEX `session_count_idx`;--> statement-breakpoint
ALTER TABLE `daily_stats` ADD `prompt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_stats` ADD `token_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_stats` ADD `lines_written` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_stats` ADD `commit_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `prompt_count_idx` ON `daily_stats` (`prompt_count`);--> statement-breakpoint
CREATE INDEX `token_count_idx` ON `daily_stats` (`token_count`);--> statement-breakpoint
CREATE INDEX `lines_written_idx` ON `daily_stats` (`lines_written`);--> statement-breakpoint
CREATE INDEX `commit_count_idx` ON `daily_stats` (`commit_count`);--> statement-breakpoint
ALTER TABLE `users` ADD `badges` text;--> statement-breakpoint
ALTER TABLE `users` ADD `hour_counts` text;--> statement-breakpoint
ALTER TABLE `users` ADD `longest_session_messages` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `current_streak` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `longest_streak` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `total_prompts` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `total_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `total_cost_usd` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `total_lines_added` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `total_commits` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `total_prs` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `total_active_seconds` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `avg_prompt_length` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `otel_enabled` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `users` ADD `otel_setup_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `token_expires_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `anthropic_account_uuid` text;