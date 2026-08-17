-- Storage hygiene (P1 wave) — collation unification + the four evidenced indexes.
--
-- WHY SIX TABLES DIFFER. `inventory_logs`, `products`, `users`, `locations`,
-- `product_locations` and `notification_history` are the original Railway-era
-- tables: they were created against a MySQL 8 server whose default collation is
-- `utf8mb4_0900_ai_ci`, and the baseline migration 20251103161510_init_baseline
-- was marked applied on production WITHOUT executing, so production never got the
-- baseline's `COLLATE utf8mb4_unicode_ci` table definitions. Every Prisma-emitted
-- CREATE TABLE ends in `DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
-- so the other forty tables are unicode_ci. Prisma's ADD COLUMN emits no collation
-- and therefore inherits the TABLE default — which is exactly how the attribution
-- keys added in 2026-07/08 (`inventory_logs.orderRecordId`, `.batchId`,
-- `.inboundShipmentId`) ended up 0900_ai_ci while their join targets
-- (`external_orders.id`, `audit_logs.batchId`) are unicode_ci. Raw-SQL joins across
-- that boundary throw ERROR 1267. Converting the TABLE DEFAULT (not just the join
-- columns) is what stops the next ADD COLUMN from re-opening the split.
--
-- ON A FRESH CHAIN Section A changes no logical end state (the baseline already
-- emits unicode_ci) — but it is NOT an operational no-op: MySQL still rebuilds and
-- locks each table. Production is the only place the defect exists.
--
-- PRODUCTION-ONLY UNMODELED COLUMNS. Two of the six carry columns that exist in
-- production but not in schema.prisma: `products.wooSku` (VARCHAR(255), UNIQUE
-- `products_wooSku_key`), `products.sku` (VARCHAR(255), no key) and
-- `users.phoneNumber` (+ three tinyint SMS flags).
-- CONVERT TO converts every column of a table, modeled or not, so these are
-- converted like any other — and they remain unmodeled afterwards (registered as
-- deferred work; this migration does not adopt them).
--
-- `inventory_logs.externalOrderId` (production-only INT with an FK to
-- external_orders_legacy_20251215223839) is INT and is untouched by a collation
-- conversion. This migration never references it.
--
-- END-STATE REPEATABLE. MySQL DDL is not transactional across statements, so a
-- failure mid-file leaves the earlier tables converted and Prisma records the
-- migration FAILED. Recovery is `prisma migrate resolve --rolled-back <name>`
-- followed by a re-run, which executes this WHOLE file again: CONVERT on an
-- already-converted table rebuilds to the same result and the Section B guards
-- skip exact matches, so the end state is identical. (End-state repeatable, not
-- statement-level idempotent: the re-run still rebuilds and re-locks.)
--
-- SECTION B GUARDS are SIGNATURE guards, and they exist for RESUME-SAFETY after a
-- mid-file failure — NOT as a change to the house convention (20260813203545:
-- unguarded plain DDL for net-new structures). The guard compares the index's FULL
-- signature, so a same-name WRONG-SHAPE index does not match, the CREATE runs, and
-- the migration FAILS CLOSED with ERROR 1061 rather than silently skipping the way
-- a name-only guard would.
--
-- LOCK_WAIT_TIMEOUT is bounded (Section 0) because the server default is one year:
-- each metadata-lock acquisition attempt is capped at 60 s, so an ALTER queued
-- behind a long transaction (a backup's --single-transaction dump, say) fails fast
-- instead of stalling the two most-written tables for as long as the blocker lives.
-- Recovery: clear the blocker, `migrate resolve --rolled-back`, re-run.

-- Section 0: bound each metadata-lock wait (server default is one year). Session-scoped;
-- Prisma runs this file on one connection.
SET @p1_old_lock_wait_timeout := @@SESSION.lock_wait_timeout;
SET SESSION lock_wait_timeout = 60;

-- Section A: the six Railway-era tables -> the codebase's one collation. Unique-key tables
-- first (users.email, products.wooSku) so a target-collation collision fails with at most
-- one table converted; inventory_logs (largest) last. Default algorithm (COPY): INPLACE is
-- refused for tables with string columns (ERROR 1846) — measured, not assumed.
ALTER TABLE `users`                CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `products`             CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `locations`            CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `notification_history` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `product_locations`    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `inventory_logs`       CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Section B: signature-guarded CREATE INDEX (resume-safety; a same-name wrong-shape index
-- makes the CREATE run and fail with ERROR 1061 — fail-closed, never a silent skip).
-- Signature = count|NON_UNIQUE|INDEX_TYPE|IS_VISIBLE|prefixed_parts|col:collation,...
-- external_orders_orderNumber_idx (external_orders: `orderNumber`)
SET @sig := (SELECT CONCAT(COUNT(*),'|',COALESCE(MIN(NON_UNIQUE),-1),'|',COALESCE(MIN(INDEX_TYPE),''),'|',COALESCE(MIN(IS_VISIBLE),''),'|',COALESCE(SUM(SUB_PART IS NOT NULL),0),'|',COALESCE(GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLLATION) ORDER BY SEQ_IN_INDEX SEPARATOR ','),'')) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_orderNumber_idx');
SET @sql := IF(@sig='1|1|BTREE|YES|0|orderNumber:A', 'SELECT 1', 'CREATE INDEX `external_orders_orderNumber_idx` ON `external_orders`(`orderNumber`)');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- external_orders_companyId_externalCreatedAt_idx (external_orders: `companyId`,`externalCreatedAt`)
SET @sig := (SELECT CONCAT(COUNT(*),'|',COALESCE(MIN(NON_UNIQUE),-1),'|',COALESCE(MIN(INDEX_TYPE),''),'|',COALESCE(MIN(IS_VISIBLE),''),'|',COALESCE(SUM(SUB_PART IS NOT NULL),0),'|',COALESCE(GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLLATION) ORDER BY SEQ_IN_INDEX SEPARATOR ','),'')) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_companyId_externalCreatedAt_idx');
SET @sql := IF(@sig='2|1|BTREE|YES|0|companyId:A,externalCreatedAt:A', 'SELECT 1', 'CREATE INDEX `external_orders_companyId_externalCreatedAt_idx` ON `external_orders`(`companyId`,`externalCreatedAt`)');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- external_orders_externalCreatedAt_idx (external_orders: `externalCreatedAt`)
SET @sig := (SELECT CONCAT(COUNT(*),'|',COALESCE(MIN(NON_UNIQUE),-1),'|',COALESCE(MIN(INDEX_TYPE),''),'|',COALESCE(MIN(IS_VISIBLE),''),'|',COALESCE(SUM(SUB_PART IS NOT NULL),0),'|',COALESCE(GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLLATION) ORDER BY SEQ_IN_INDEX SEPARATOR ','),'')) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_externalCreatedAt_idx');
SET @sql := IF(@sig='1|1|BTREE|YES|0|externalCreatedAt:A', 'SELECT 1', 'CREATE INDEX `external_orders_externalCreatedAt_idx` ON `external_orders`(`externalCreatedAt`)');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- audit_logs_actionType_createdAt_idx (audit_logs: `actionType`,`createdAt`)
SET @sig := (SELECT CONCAT(COUNT(*),'|',COALESCE(MIN(NON_UNIQUE),-1),'|',COALESCE(MIN(INDEX_TYPE),''),'|',COALESCE(MIN(IS_VISIBLE),''),'|',COALESCE(SUM(SUB_PART IS NOT NULL),0),'|',COALESCE(GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLLATION) ORDER BY SEQ_IN_INDEX SEPARATOR ','),'')) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='audit_logs' AND INDEX_NAME='audit_logs_actionType_createdAt_idx');
SET @sql := IF(@sig='2|1|BTREE|YES|0|actionType:A,createdAt:A', 'SELECT 1', 'CREATE INDEX `audit_logs_actionType_createdAt_idx` ON `audit_logs`(`actionType`,`createdAt`)');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Section Z: restore the session timeout (courtesy for long-lived sessions running this file).
SET SESSION lock_wait_timeout = @p1_old_lock_wait_timeout;
