-- Hand-written, MySQL 8.4-aware. F3 analytics fact tables. Idempotent (CREATE TABLE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS `product_stock_snapshots` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `productId`  INT NOT NULL,
  `locationId` INT NOT NULL,
  `dayKey`     CHAR(10) NOT NULL,
  `quantity`   INT NOT NULL,
  `createdAt`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_snapshot_grain` (`productId`, `locationId`, `dayKey`),
  KEY `idx_snapshot_day` (`dayKey`),
  KEY `idx_snapshot_product_day` (`productId`, `dayKey`),
  CONSTRAINT `snapshot_product_fkey`  FOREIGN KEY (`productId`)  REFERENCES `products`(`id`)  ON DELETE CASCADE   ON UPDATE NO ACTION,
  CONSTRAINT `snapshot_location_fkey` FOREIGN KEY (`locationId`) REFERENCES `locations`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `product_sales_facts` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `productId`     INT NOT NULL,
  `companyId`     VARCHAR(191) NOT NULL,
  `integrationId` VARCHAR(191) NOT NULL,
  `dayKey`        CHAR(10) NOT NULL,
  `orderedQty`    INT NOT NULL DEFAULT 0,
  `fulfilledQty`  INT NOT NULL DEFAULT 0,
  `revenue`       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `orderCount`    INT NOT NULL DEFAULT 0,
  `createdAt`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_fact_grain` (`productId`, `companyId`, `integrationId`, `dayKey`),
  KEY `idx_sales_fact_company_day` (`companyId`, `dayKey`),
  KEY `idx_sales_fact_product_day` (`productId`, `dayKey`),
  CONSTRAINT `sales_fact_product_fkey`     FOREIGN KEY (`productId`)     REFERENCES `products`(`id`)     ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `sales_fact_company_fkey`     FOREIGN KEY (`companyId`)     REFERENCES `companies`(`id`)    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `sales_fact_integration_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `analytics_rebuild_state` (
  `job`             VARCHAR(32) NOT NULL,
  `lockedAt`        DATETIME NULL,
  `heartbeatAt`     DATETIME NULL,
  `lastRunAt`       DATETIME NULL,
  `lastWindowFrom`  CHAR(10) NULL,
  `lastWindowTo`    CHAR(10) NULL,
  `rowsDeleted`     INT NOT NULL DEFAULT 0,
  `rowsInserted`    INT NOT NULL DEFAULT 0,
  `unattributed`    INT NOT NULL DEFAULT 0,
  `flaggedPairs`    INT NOT NULL DEFAULT 0,
  `sourceWatermark` DATETIME NULL,
  `lastError`       TEXT NULL,
  `updatedAt`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`job`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `analytics_rebuild_state` (`job`) VALUES ('snapshots'), ('sales');
