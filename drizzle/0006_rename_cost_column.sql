-- Rename misleading column: total_cost_usd stores CENTS, not USD
-- SQLite 3.25+ supports ALTER TABLE RENAME COLUMN
ALTER TABLE `users` RENAME COLUMN `total_cost_usd` TO `total_cost_cents`;
