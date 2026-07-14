-- Lane 6 T2 — platform_write_attempts: the pre-send authorization record.
--
-- Every attempted platform write (allowed, blocked, or dry-run) lands here BEFORE
-- any byte leaves the process. If the row cannot be committed, the send is refused.
--
-- REV-2 #21: NO cascade from integrations. Deleting an integration must not destroy
-- the record of what it was used to attempt — the FK is nullable + ON DELETE SET NULL,
-- and integrationLabel/platform are denormalized so a detached row stays legible.
--
-- Guarded DDL throughout (MySQL 8 has no ADD COLUMN/CONSTRAINT IF NOT EXISTS) so this
-- migration is a no-op on any environment that already has the table.

CREATE TABLE IF NOT EXISTS `platform_write_attempts` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `integrationId` VARCHAR(191) NULL,
  `integrationLabel` VARCHAR(255) NOT NULL,
  `platform` VARCHAR(32) NOT NULL,
  `capability` VARCHAR(32) NOT NULL,
  `method` VARCHAR(8) NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `bodyDigest` CHAR(64) NOT NULL,
  `decision` VARCHAR(16) NOT NULL,
  `blockReason` VARCHAR(32) NULL,
  `state` VARCHAR(24) NOT NULL,
  `httpStatus` INTEGER NULL,
  `attemptNo` INTEGER NOT NULL DEFAULT 1,
  `configFingerprint` CHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `platform_write_attempts_createdAt_idx`(`createdAt`),
  INDEX `platform_write_attempts_integrationId_createdAt_idx`(`integrationId`, `createdAt`),
  INDEX `platform_write_attempts_state_createdAt_idx`(`state`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- FK: ON DELETE SET NULL (REV-2 #21 — the audit trail outlives the integration).
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA=DATABASE()
              AND TABLE_NAME='platform_write_attempts'
              AND CONSTRAINT_NAME='platform_write_attempts_integrationId_fkey');
SET @sql := IF(@fk=0,
  'ALTER TABLE `platform_write_attempts` ADD CONSTRAINT `platform_write_attempts_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
