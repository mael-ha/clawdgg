-- Dashboard V2: Add archetype fields to users table
-- Archetypes are identity-first classifications based on usage patterns
--
-- Written in December 2025 as 0004_dashboard_v2_archetypes.sql, numbered
-- against a 0004 that already existed and never entered meta/_journal.json —
-- so drizzle has never run it anywhere, and the columns reached production by
-- hand. Renumbered to the end of the chain, where it belongs: a fresh database
-- needs these three columns, which src/db/schema.ts has had all along, and an
-- existing one already has them.

ALTER TABLE users ADD COLUMN archetype TEXT;--> statement-breakpoint
ALTER TABLE users ADD COLUMN archetype_secondary TEXT;--> statement-breakpoint
ALTER TABLE users ADD COLUMN archetype_updated_at INTEGER;
