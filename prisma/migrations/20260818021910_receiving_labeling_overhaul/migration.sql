-- Receiving/Labeling overhaul (contract pack REV-2 C1.2) — THE migration.
--
-- ONE migration for the whole wave (plan P-1): supply orders entered when the
-- order is PLACED (header = inbound_shipments) and verified on arrival (line =
-- staging_items, evolved IN PLACE — no second lines table, because duplicated
-- receiving state is exactly what produced the count-46-book-50 defect), plus
-- the labeling ledger's three columns on inventory_logs and the exception
-- follow-up classification on inventory_exceptions.
--
-- ENUM APPENDS, never re-orders: both status enums gain their new members AT
-- THE END, so every legacy row's stored value keeps its position and MySQL
-- rewrites nothing but the column's metadata. inbound_shipments keeps DEFAULT
-- 'OPEN' (the legacy default; new-flow creates always write their status
-- explicitly).
--
-- staging_items.status DEFAULT FLIPS RECEIVED -> ORDERED: a supply-order line
-- is born ORDERED, and a line that fell back to the DB default must never land
-- in the legacy pre-staging queue. The surviving legacy box-create route
-- (app/api/staging-items/route.ts) therefore writes status = 'RECEIVED'
-- EXPLICITLY until it is deleted with the rest of pre-staging.
--
-- THREE LOSSLESS NULL-WIDENINGS on staging_items — locationId, receivedBy,
-- receivedAt: all three describe the RECEIPT act, which the new flow records as
-- verifiedBy/verifiedAt plus a per-batch location chosen at labeling time. No
-- legacy value changes; the composite index (status, locationId, receivedAt)
-- stays valid; receivedAt keeps DATETIME(0) precision.
--
-- receivedAt KEEPS ITS DB DEFAULT (spec REV-10 clause 4, codex CR-4). The MODIFY
-- carries `DEFAULT CURRENT_TIMESTAMP(0)` — the Prisma-emitted text for
-- `receivedAt DateTime? @default(now()) @db.DateTime(0)` — so the widening is
-- nullability ALONE. An earlier draft dropped the default, which would have
-- closed the code-rollback window at the MIGRATION rather than at the first
-- supply order: the pre-overhaul box-create (fc195ad) omits receivedAt from its
-- insert and leans on CURRENT_TIMESTAMP, so a rollback onto a defaultless column
-- would have written receivedAt NULL for every box logged afterwards — and
-- `receivedAt IS NOT NULL` is the LEGACY DISCRIMINATOR, so those boxes would
-- have stopped being legacy rows. Keeping the default makes this migration
-- rollback-compatible with the code it replaces.
--
-- The discriminator is protected from the other side instead: every new-flow
-- create writes `receivedAt: null` EXPLICITLY (order create, ordered-line add,
-- unordered arrival, the M7a seed), each pinned by a query-shape test, so a
-- supply-order line can never be stamped by the default and read back as legacy.
--
-- THREE INDEXES, frozen by query site (plan P-6):
--   inbound_shipments (status, orderedAt)          — the supply-orders list and
--     the fees window: `status IN (...) [AND orderedAt range] ORDER BY orderedAt DESC`.
--   inventory_logs (stagingItemId)                 — the per-line ledger read
--     and the oracle SUM(delta) that must equal staging_items.stockedQuantity.
--   UNIQUE inventory_logs (stagingItemId, bookingKey) — request idempotency for
--     batch booking. NULLs are unconstrained, so every pre-overhaul ledger row
--     (both columns NULL) stays legal and no backfill is needed.
--
-- Unguarded plain DDL, matching 20260813203545 and 20260810211125: every
-- structure here is net-new to this lane and the two enum MODIFYs are metadata
-- appends, so nothing can pre-exist on any environment. NOTE (PK-3): MySQL DDL
-- autocommits, so a MID-FILE failure leaves the earlier statements applied and
-- `migrate resolve --rolled-back` + re-run would then fail 1060/1061 on them.
-- The runbook owns that path (complete or revert the partial DDL by hand, then
-- `resolve --applied` / `--rolled-back`); the rehearsal on a fresh prod dump is
-- what excludes structural conflicts, and scripts/verify-overhaul-migration.sh
-- proves the clean FIRST-statement failure recovery permanently.
--
-- Nothing is dropped and nothing is renamed. The W1 columns (expectedQuantity,
-- countedQuantity, countedBy/At, unitCostCents, vendor, reference,
-- graduatedBy/At) stay exactly as they are; the new flow never writes them.

-- AlterTable
ALTER TABLE `inbound_shipments` ADD COLUMN `feesCents` INTEGER NULL,
    ADD COLUMN `feesNote` VARCHAR(255) NULL,
    ADD COLUMN `orderedAt` DATETIME(3) NULL,
    ADD COLUMN `supplier` VARCHAR(255) NULL,
    MODIFY `status` ENUM('OPEN', 'CLOSED', 'CANCELLED', 'ORDERED', 'RECEIVING') NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE `inventory_exceptions` ADD COLUMN `resolution` VARCHAR(32) NULL;

-- AlterTable
ALTER TABLE `inventory_logs` ADD COLUMN `bookingKey` VARCHAR(36) NULL,
    ADD COLUMN `receiptCostCents` INTEGER NULL,
    ADD COLUMN `stagingItemId` INTEGER NULL;

-- AlterTable
ALTER TABLE `staging_items` ADD COLUMN `disposedQuantity` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `labelingRequired` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `lineTotalCents` INTEGER NULL,
    ADD COLUMN `orderedProductId` INTEGER NULL,
    ADD COLUMN `orderedQuantity` INTEGER NULL,
    ADD COLUMN `stockedQuantity` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `verifiedAt` DATETIME(3) NULL,
    ADD COLUMN `verifiedBy` INTEGER NULL,
    ADD COLUMN `verifiedQuantity` INTEGER NULL,
    MODIFY `status` ENUM('RECEIVED', 'GRADUATED', 'DISCARDED', 'ORDERED', 'VERIFIED', 'LABELING', 'COMPLETE') NOT NULL DEFAULT 'ORDERED',
    MODIFY `locationId` INTEGER NULL,
    MODIFY `receivedBy` INTEGER NULL,
    MODIFY `receivedAt` DATETIME(0) NULL DEFAULT CURRENT_TIMESTAMP(0);

-- CreateIndex
CREATE INDEX `inbound_shipments_status_orderedAt_idx` ON `inbound_shipments`(`status`, `orderedAt`);

-- CreateIndex
CREATE INDEX `inventory_logs_stagingItemId_idx` ON `inventory_logs`(`stagingItemId`);

-- CreateIndex
CREATE UNIQUE INDEX `inventory_logs_stagingItemId_bookingKey_key` ON `inventory_logs`(`stagingItemId`, `bookingKey`);

-- AddForeignKey
ALTER TABLE `staging_items` ADD CONSTRAINT `staging_items_verifiedBy_fkey` FOREIGN KEY (`verifiedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staging_items` ADD CONSTRAINT `staging_items_orderedProductId_fkey` FOREIGN KEY (`orderedProductId`) REFERENCES `products`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
