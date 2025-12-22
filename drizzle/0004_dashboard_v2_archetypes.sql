-- Dashboard V2: Add archetype fields to users table
-- Archetypes are identity-first classifications based on usage patterns

ALTER TABLE users ADD COLUMN archetype TEXT;
ALTER TABLE users ADD COLUMN archetype_secondary TEXT;
ALTER TABLE users ADD COLUMN archetype_updated_at INTEGER;
