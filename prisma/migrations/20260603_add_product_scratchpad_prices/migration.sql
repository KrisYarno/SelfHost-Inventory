CREATE TABLE `product_scratchpad_prices` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `productId`  INT NOT NULL,
  `label`      VARCHAR(120) NOT NULL,
  `value`      VARCHAR(255) NULL,
  `note`       TEXT NULL,
  `sortOrder`  INT NOT NULL DEFAULT 0,
  `version`    INT NOT NULL DEFAULT 0,
  `createdBy`  INT NULL,
  `updatedBy`  INT NULL,
  `createdAt`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_scratchpad_product_sort` (`productId`, `sortOrder`),
  KEY `idx_scratchpad_label` (`label`),
  CONSTRAINT `scratchpad_product_fkey`   FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `scratchpad_createdBy_fkey`  FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`)    ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT `scratchpad_updatedBy_fkey`  FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`)    ON DELETE SET NULL ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
