-- Lane reorder-points: ADOPT the orphaned reorder config schema into Prisma.
--
-- The base tables (`global_reorder_settings`, `product_reorder_configs`) already
-- exist on every DB migrated past 20251204_add_reorder_config; on a FRESH bootstrap
-- that migration creates them earlier in the chain. This migration only adds the two
-- NEW columns the domain needs (defaultTargetCoverageMultiple, minEvidenceEvents).
--
-- Guarded via information_schema so it is idempotent across existing DBs (add) and
-- any DB that already carries the columns (skip). MySQL 8.4 has no ADD COLUMN IF NOT
-- EXISTS, so the COUNT+PREPARE pattern is the portable guard.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'global_reorder_settings' AND COLUMN_NAME = 'defaultTargetCoverageMultiple');
SET @sql := IF(@c = 0, 'ALTER TABLE `global_reorder_settings` ADD COLUMN `defaultTargetCoverageMultiple` INT NOT NULL DEFAULT 2', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'global_reorder_settings' AND COLUMN_NAME = 'minEvidenceEvents');
SET @sql := IF(@c = 0, 'ALTER TABLE `global_reorder_settings` ADD COLUMN `minEvidenceEvents` INT NOT NULL DEFAULT 3', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
