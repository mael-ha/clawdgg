CREATE TABLE `plan_usage_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`window_type` text NOT NULL,
	`used_percentage` real NOT NULL,
	`resets_at` integer,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plan_usage_user_window_captured_idx` ON `plan_usage_snapshots` (`user_id`,`window_type`,`captured_at`);
