-- Lane 6 T3 — Integration credential split (R-E8).
--
-- WooCommerce API keys carry Read / Write / Read-Write permission — NOT per-endpoint
-- scope. A write-capable key can write ORDERS. Splitting read from write is what makes
-- every read path physically incapable of mutating the store.
--
--   encryptedApiKey    -> encryptedWriteKey     (RENAME — preserves the existing keys,
--   encryptedApiSecret -> encryptedWriteSecret   nothing has to be re-entered on deploy)
--   + encryptedReadKey / encryptedReadSecret     (NEW — the Woo Read-permission pair)
--
-- REV-2 #25: guarded for all four preflight states (old-only / new-only / both / neither),
-- because this migration must be a safe no-op on an environment that already ran it and
-- must also work on a fresh bootstrap. MySQL 8 has no CHANGE COLUMN IF EXISTS.

-- --- encryptedApiKey -> encryptedWriteKey -------------------------------------------
SET @old := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='integrations' AND COLUMN_NAME='encryptedApiKey');
SET @new := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='integrations' AND COLUMN_NAME='encryptedWriteKey');
-- old present, new absent  -> rename (carries the data)
-- old absent,  new absent  -> add (fresh DB that somehow lacks both)
-- new present              -> no-op (already migrated)
SET @sql := IF(@new>0, 'SELECT 1',
             IF(@old>0, 'ALTER TABLE `integrations` CHANGE COLUMN `encryptedApiKey` `encryptedWriteKey` TEXT NULL',
                        'ALTER TABLE `integrations` ADD COLUMN `encryptedWriteKey` TEXT NULL'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- --- encryptedApiSecret -> encryptedWriteSecret --------------------------------------
SET @old := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='integrations' AND COLUMN_NAME='encryptedApiSecret');
SET @new := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='integrations' AND COLUMN_NAME='encryptedWriteSecret');
SET @sql := IF(@new>0, 'SELECT 1',
             IF(@old>0, 'ALTER TABLE `integrations` CHANGE COLUMN `encryptedApiSecret` `encryptedWriteSecret` TEXT NULL',
                        'ALTER TABLE `integrations` ADD COLUMN `encryptedWriteSecret` TEXT NULL'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- --- NEW: encryptedReadKey ------------------------------------------------------------
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='integrations' AND COLUMN_NAME='encryptedReadKey');
SET @sql := IF(@col=0, 'ALTER TABLE `integrations` ADD COLUMN `encryptedReadKey` TEXT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- --- NEW: encryptedReadSecret ---------------------------------------------------------
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='integrations' AND COLUMN_NAME='encryptedReadSecret');
SET @sql := IF(@col=0, 'ALTER TABLE `integrations` ADD COLUMN `encryptedReadSecret` TEXT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
