CREATE TABLE `daily_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`session_count` integer DEFAULT 0 NOT NULL,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`submitted_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_date_idx` ON `daily_stats` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `date_idx` ON `daily_stats` (`date`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `daily_stats` (`user_id`);--> statement-breakpoint
CREATE INDEX `message_count_idx` ON `daily_stats` (`message_count`);--> statement-breakpoint
CREATE INDEX `session_count_idx` ON `daily_stats` (`session_count`);--> statement-breakpoint
CREATE INDEX `tool_call_count_idx` ON `daily_stats` (`tool_call_count`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` text NOT NULL,
	`github_username` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`first_session_date` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_id_idx` ON `users` (`github_id`);--> statement-breakpoint
CREATE INDEX `github_username_idx` ON `users` (`github_username`);