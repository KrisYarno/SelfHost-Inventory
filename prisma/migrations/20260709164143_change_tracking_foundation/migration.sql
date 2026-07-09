-- Change-tracking foundation (spec 2026-07-08 §10 R-D2/R-D11/R-D12/R-D13).
-- ONE combined ALTER per table: MySQL DDL is non-transactional; a single
-- statement is a single rebuild and a single all-or-nothing failure point.
ALTER TABLE `audit_logs`
  MODIFY `userId` INT NULL,
  MODIFY `entityId` VARCHAR(64) NULL,
  MODIFY `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `actorKind` VARCHAR(16) NOT NULL DEFAULT 'USER' AFTER `userId`,
  ADD COLUMN `companyId` VARCHAR(30) NULL AFTER `actorKind`,
  ADD INDEX `idx_audit_company_time` (`companyId`, `createdAt`);

ALTER TABLE `inventory_logs`
  MODIFY `userId` INT NULL,
  MODIFY `changeTime` DATETIME(3) NOT NULL,
  MODIFY `logType` ENUM('ADJUSTMENT','TRANSFER','STOCK_IN','SALE','CORRECTION','COUNT') NOT NULL DEFAULT 'ADJUSTMENT',
  ADD COLUMN `actorKind` VARCHAR(16) NOT NULL DEFAULT 'USER' AFTER `transferId`,
  ADD COLUMN `reasonCode` VARCHAR(20) NULL AFTER `actorKind`,
  ADD COLUMN `unitCostCents` INT NULL AFTER `reasonCode`;
