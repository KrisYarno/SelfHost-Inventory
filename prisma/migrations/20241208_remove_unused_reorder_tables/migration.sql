-- Remove orphaned reorder tables (settings were stored but never used)
-- These tables are being dropped because:
-- 1. GlobalReorderSettings was never read by any code - hardcoded constants used instead
-- 2. ProductReorderConfig was never populated or used

-- Drop tables
DROP TABLE IF EXISTS `product_reorder_configs`;
DROP TABLE IF EXISTS `global_reorder_settings`;
