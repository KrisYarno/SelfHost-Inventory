-- Create audit_logs table
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NOT NULL,
  `actionType` VARCHAR(50) NOT NULL,
  `entityType` VARCHAR(50) NOT NULL,
  `entityId` INT NULL,
  `batchId` VARCHAR(36) NULL,
  `action` TEXT NOT NULL,
  `details` JSON NULL,
  `ipAddress` VARCHAR(45) NULL,
  `userAgent` VARCHAR(255) NULL,
  `affectedCount` INT NOT NULL DEFAULT 1,
  `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_audit_user` (`userId`),
  INDEX `idx_audit_actionType` (`actionType`),
  INDEX `idx_audit_entity` (`entityType`, `entityId`),
  INDEX `idx_audit_batch` (`batchId`),
  INDEX `idx_audit_created` (`createdAt`),
  CONSTRAINT `fk_audit_user` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;