CREATE TABLE `ai_providers` (
  `id` VARCHAR(30) NOT NULL, `kind` VARCHAR(16) NOT NULL,
  `encryptedApiKey` TEXT NULL, `baseUrl` VARCHAR(500) NULL,
  `enabledModels` JSON NOT NULL, `isEnabled` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_ai_providers_kind` (`kind`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `api_tokens` (
  `id` VARCHAR(30) NOT NULL, `name` VARCHAR(64) NOT NULL, `tokenHash` CHAR(64) NOT NULL,
  `tier` VARCHAR(8) NOT NULL DEFAULT 'read',
  `createdByUserId` INT NOT NULL, `ownerUserId` INT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt` DATETIME(3) NULL, `revokedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_api_tokens_hash` (`tokenHash`),
  KEY `idx_api_tokens_owner` (`ownerUserId`), KEY `idx_api_tokens_creator` (`createdByUserId`),
  CONSTRAINT `fk_api_tokens_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_api_tokens_creator` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `assistant_runs` (
  `id` INT NOT NULL AUTO_INCREMENT, `userId` INT NULL, `tokenId` VARCHAR(30) NULL,
  `surface` VARCHAR(12) NOT NULL, `providerKind` VARCHAR(16) NULL, `model` VARCHAR(64) NULL,
  `toolName` VARCHAR(48) NOT NULL, `outcome` VARCHAR(16) NOT NULL,
  `durationMs` INT NOT NULL, `resultBytes` INT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), KEY `idx_assistant_runs_created` (`createdAt`), KEY `idx_assistant_runs_user` (`userId`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
