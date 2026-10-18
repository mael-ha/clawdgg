CREATE TABLE `rank_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`rank` integer NOT NULL,
	`value` integer NOT NULL,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rank_snapshot_user_day_metric_idx` ON `rank_snapshots` (`user_id`,`day`,`metric`);--> statement-breakpoint
CREATE INDEX `rank_snapshot_day_metric_idx` ON `rank_snapshots` (`day`,`metric`);
