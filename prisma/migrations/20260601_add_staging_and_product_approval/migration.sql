-- Pre-Staging Inventory + Provisional Product Approval
-- Hand-written, MySQL 8.4-aware (this repo writes migrations by hand).
-- Default approvalStatus='APPROVED' => all existing product rows are correct, no backfill.

-- Product approval columns (nullable adds + enum + index are INPLACE/LOCK=NONE)
ALTER TABLE `products`
  ADD COLUMN `approvalStatus` ENUM('APPROVED','PENDING_REVIEW') NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN `createdBy` INT NULL,
  ADD COLUMN `reviewedBy` INT NULL,
  ADD COLUMN `reviewedAt` DATETIME NULL,
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `products`
  ADD INDEX `idx_product_approval_status` (`approvalStatus`),
  ALGORITHM=INPLACE, LOCK=NONE;

-- FK constraints: may NOT honor LOCK=NONE (FK creation can take a brief metadata lock).
-- products table is small, so a short lock is acceptable. Column adds above are already applied.
ALTER TABLE `products`
  ADD CONSTRAINT `products_createdBy_fkey`  FOREIGN KEY (`createdBy`)  REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT `products_reviewedBy_fkey` FOREIGN KEY (`reviewedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- Staging items (pre-stock holding area)
CREATE TABLE `staging_items` (
  `id`                INT NOT NULL AUTO_INCREMENT,
  `description`       VARCHAR(255) NOT NULL,
  `status`            ENUM('RECEIVED','GRADUATED','DISCARDED') NOT NULL DEFAULT 'RECEIVED',
  `expectedQuantity`  INT NULL,
  `countedQuantity`   INT NULL,
  `resolvedProductId` INT NULL,
  `vendor`            VARCHAR(255) NULL,
  `reference`         VARCHAR(255) NULL,
  `notes`             TEXT NULL,
  `locationId`        INT NOT NULL,
  `receivedBy`        INT NOT NULL,
  `receivedAt`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `graduatedBy`       INT NULL,
  `graduatedAt`       DATETIME NULL,
  `createdAt`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_staging_status_loc_time` (`status`, `locationId`, `receivedAt`),
  KEY `idx_staging_received_by` (`receivedBy`),
  KEY `idx_staging_resolved_product` (`resolvedProductId`),
  CONSTRAINT `staging_items_location_fkey`        FOREIGN KEY (`locationId`)        REFERENCES `locations`(`id`),
  CONSTRAINT `staging_items_receivedBy_fkey`      FOREIGN KEY (`receivedBy`)        REFERENCES `users`(`id`),
  CONSTRAINT `staging_items_graduatedBy_fkey`     FOREIGN KEY (`graduatedBy`)       REFERENCES `users`(`id`),
  CONSTRAINT `staging_items_resolvedProduct_fkey` FOREIGN KEY (`resolvedProductId`) REFERENCES `products`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
