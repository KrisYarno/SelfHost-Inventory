-- AlterTable
ALTER TABLE `assistant_runs` ADD COLUMN `requestId` INTEGER NULL;

-- CreateTable
CREATE TABLE `assistant_threads` (
    `id` VARCHAR(30) NOT NULL,
    `userId` INTEGER NOT NULL,
    `title` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_assistant_threads_user_updated`(`userId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assistant_messages` (
    `threadId` VARCHAR(30) NOT NULL,
    `id` VARCHAR(40) NOT NULL,
    `role` VARCHAR(12) NOT NULL,
    `parts` JSON NOT NULL,
    `metadata` JSON NULL,
    `sequence` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_assistant_messages_thread_seq`(`threadId`, `sequence`),
    PRIMARY KEY (`threadId`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assistant_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `threadId` VARCHAR(30) NULL,
    `userId` INTEGER NOT NULL,
    `kind` VARCHAR(8) NOT NULL,
    `providerKind` VARCHAR(16) NOT NULL,
    `model` VARCHAR(64) NOT NULL,
    `inputTokens` INTEGER NULL,
    `outputTokens` INTEGER NULL,
    `totalTokens` INTEGER NULL,
    `durationMs` INTEGER NULL,
    `status` VARCHAR(16) NOT NULL,
    `errorCode` VARCHAR(32) NULL,
    `membershipScope` JSON NOT NULL,
    `dayKey` CHAR(10) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_assistant_requests_user_day`(`userId`, `dayKey`),
    INDEX `idx_assistant_requests_thread_status`(`threadId`, `status`),
    INDEX `idx_assistant_requests_created`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assistant_eval_reports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runAt` DATETIME(3) NOT NULL,
    `environment` VARCHAR(16) NOT NULL,
    `model` VARCHAR(64) NULL,
    `corpusRev` VARCHAR(64) NULL,
    `source` VARCHAR(16) NOT NULL,
    `report` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `idx_assistant_runs_request` ON `assistant_runs`(`requestId`);

-- AddForeignKey
ALTER TABLE `assistant_threads` ADD CONSTRAINT `fk_assistant_threads_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assistant_messages` ADD CONSTRAINT `fk_assistant_messages_thread` FOREIGN KEY (`threadId`) REFERENCES `assistant_threads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assistant_requests` ADD CONSTRAINT `fk_assistant_requests_thread` FOREIGN KEY (`threadId`) REFERENCES `assistant_threads`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
