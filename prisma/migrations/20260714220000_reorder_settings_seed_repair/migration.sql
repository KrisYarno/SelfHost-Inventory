-- W0-4 (R2-B1): global_reorder_settings singleton seed REPAIR.
--
-- The read path (getGlobalReorderSettings) no longer seeds the singleton via upsert —
-- it is reachable from the assistant/MCP reorder_report tool and MUST NOT write. The
-- original 20251204_add_reorder_config migration already seeds id=1 on FRESH DBs; this
-- migration idempotently backfills the row on RESTORED or column-pruned DBs where that
-- seed was lost, so the resolver's persisted defaults exist without a runtime write.
--
-- Idempotent: ON DUPLICATE KEY UPDATE id=id is a no-op when the row already exists.
-- Every NOT NULL column in global_reorder_settings carries a DB DEFAULT
-- (defaultLeadTimeDays=14, defaultSafetyStockDays=7, holdingCostRate=0.25,
-- updatedAt=CURRENT_TIMESTAMP(0) from 20251204; defaultTargetCoverageMultiple=2,
-- minEvidenceEvents=3 from 20260714200000), so inserting id alone fills the rest with
-- the same values as REORDER_GLOBAL_DEFAULTS. updatedBy is nullable.
INSERT INTO `global_reorder_settings` (`id`) VALUES (1)
ON DUPLICATE KEY UPDATE `id` = `id`;
