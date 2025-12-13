CREATE TABLE `device_auths` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`expires_at` integer NOT NULL,
	`user_id` text,
	`username` text,
	`token` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_auths_device_code_unique` ON `device_auths` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_auths_user_code_unique` ON `device_auths` (`user_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_idx` ON `device_auths` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_code_idx` ON `device_auths` (`user_code`);--> statement-breakpoint
CREATE INDEX `expires_at_idx` ON `device_auths` (`expires_at`);