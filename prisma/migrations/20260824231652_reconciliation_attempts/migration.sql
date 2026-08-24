-- Reconciliation lane (contract pack REV-3 C1a.2) — THE migration.
--
-- The whole lane's schema rides this ONE additive migration (spec REV-7 D12):
-- one net-new table (order_attribution_attempts) with its single index, plus
-- two read-path indexes on tables that already exist. Nothing is dropped, no
-- column is modified, and no stored value moves.
--
-- order_attribution_attempts records every LIVE attribution attempt at batch
-- grain — successes AND declines — written beside the audit event inside the
-- business transaction, and kept forever. Its references are SOFT BY DESIGN
-- (batchId -> inventory_logs.batchId, ledgerRowId -> inventory_logs.id,
-- orderRecordId/previousOrderRecordId -> external_orders.id): no foreign key,
-- because an attempt is the record of what was TRIED and has to outlive
-- anything it names. The (batchId, attemptedAt, id) index is the only one —
-- every read of this table is "the attempts of this batch, latest last".
--
-- The two other indexes serve the lane's read paths: inventory_exceptions
-- (kind, resolvedAt) is the exceptions finder's page key, and
-- external_order_items (isMapped, orderId) is the unmapped-lines scan.
--
-- Unguarded (plain generated DDL), matching the 20260813203545 precedent:
-- every structure here is net-new to this lane, so none can pre-exist on any
-- environment. The guarded information_schema style is reserved for the repair
-- and adoption migrations, where the structure IS already present somewhere.
--
-- The CREATE TABLE carries DEFAULT CHARACTER SET utf8mb4 COLLATE
-- utf8mb4_unicode_ci explicitly (the 20260817223640 storage-hygiene end state):
-- a table born on an unflagged server's default would land at 0900_ai_ci, and
-- its batchId would then be unjoinable against inventory_logs.batchId (1267).

-- CreateTable
CREATE TABLE `order_attribution_attempts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batchId` VARCHAR(36) NOT NULL,
    `ledgerRowId` INTEGER NULL,
    `outcome` VARCHAR(16) NOT NULL,
    `evidence` VARCHAR(32) NULL,
    `reason` VARCHAR(32) NULL,
    `orderRecordId` VARCHAR(191) NULL,
    `previousOrderRecordId` VARCHAR(191) NULL,
    `source` VARCHAR(32) NOT NULL,
    `actorUserId` INTEGER NULL,
    `details` JSON NULL,
    `attemptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `order_attribution_attempts_batchId_attemptedAt_id_idx`(`batchId`, `attemptedAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `external_order_items_isMapped_orderId_idx` ON `external_order_items`(`isMapped`, `orderId`);

-- CreateIndex
CREATE INDEX `inventory_exceptions_kind_resolvedAt_idx` ON `inventory_exceptions`(`kind`, `resolvedAt`);
