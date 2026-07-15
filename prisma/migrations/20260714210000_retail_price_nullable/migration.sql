-- W0-RETAIL (spec §4): make products.retailPrice nullable and backfill the legacy
-- zero-retail rows to NULL. Under the old schema `retailPrice DECIMAL(10,2) NOT NULL
-- DEFAULT 0.00`, "unknown retail" and "genuinely free" were the SAME value, so every
-- valuation/coverage read $0.00 for a product whose price was simply never entered.
-- On prod, 21 of 80 products sit at the ambiguous 0.00 — all unknown, none free
-- (Kris-approved: the backfill nulls every 0). This mirrors the costPrice treatment
-- (migration 20260714130000_lane6_cost_nullable) one money-column over.
--
-- After this migration:
--   * NULL            = retail unknown (analytics emits null + a coverage figure)
--   * an explicit 0   = genuinely free (a rare, deliberate human entry — kept)
--
-- `priceSourceLinkId` semantics are unchanged: the 59 linked products keep syncing
-- real prices; the 21 manual-unset products become NULL.
--
-- information_schema-guarded so live (column NOT NULL WITH default) and fresh
-- (column already nullable, e.g. a re-run) envs run the SAME migration idempotently.
--
-- DEPLOY RUNBOOK (MIGRATION-FIRST, spec rollout note): migration and code deploy in
-- the SAME cycle (the compose `migrate` service makes this atomic-enough). Between the
-- DDL and the code swap the OLD app binary can still write `retailPrice = 0` for an
-- unknown price via its un-fixed writers. The backfill UPDATE below is IDEMPOTENT —
-- once a row is NULL no row matches `= 0` — so it is SAFE to re-run once post-swap to
-- sweep any zeros the old binary recreated in that window.

-- 1. Drop the default + make nullable, only while the column is still NOT NULL.
SET @notnull := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'products'
    AND COLUMN_NAME = 'retailPrice'
    AND IS_NULLABLE = 'NO'
);
SET @sql := IF(
  @notnull = 1,
  'ALTER TABLE `products` MODIFY COLUMN `retailPrice` DECIMAL(10,2) NULL DEFAULT NULL',
  'SELECT 1'
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. Backfill legacy zeros -> NULL (idempotent: once nulled, no rows match). Runs
--    only after the column can hold NULL. Safe to re-run once post-code-swap.
UPDATE `products` SET `retailPrice` = NULL WHERE `retailPrice` = 0;
