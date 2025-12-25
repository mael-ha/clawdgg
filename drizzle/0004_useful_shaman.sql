ALTER TABLE `users` ADD `otel_setup_date` text;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_prompts` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_input_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_output_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_cache_read_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_cache_creation_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_cost_usd_cents` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_lines_added` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_commits` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_total_tool_calls` integer DEFAULT 0;