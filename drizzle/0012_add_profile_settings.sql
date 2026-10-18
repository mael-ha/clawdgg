CREATE TABLE `profile_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`show_value` integer DEFAULT true NOT NULL,
	`show_anatomy` integer DEFAULT true NOT NULL,
	`show_conversation` integer DEFAULT true NOT NULL,
	`show_rings` integer DEFAULT true NOT NULL,
	`show_class` integer DEFAULT true NOT NULL,
	`show_milestones` integer DEFAULT true NOT NULL,
	`show_curve` integer DEFAULT true NOT NULL,
	`show_year` integer DEFAULT true NOT NULL,
	`show_ultrathink` integer DEFAULT true NOT NULL,
	`show_plan` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
