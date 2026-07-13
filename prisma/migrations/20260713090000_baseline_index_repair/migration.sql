-- Lane 5 baseline index repair (2026-07-13). FIVE indexes were created by hand-SQL in
-- 20250108c_mass_update_performance_indexes but were never modeled in schema.prisma, so the
-- schema-generated 20251103161510_init_baseline omits them. No-op'ing 20250108c would silently
-- lose them on FRESH environments. These guarded CREATE INDEX blocks re-create them: guarded
-- (information_schema-checked) because LIVE databases already have them from 20250108c and must
-- run this migration as a no-op. The matching @@index entries were added to schema.prisma so
-- schema = database = chain. MySQL 8 has no CREATE INDEX IF NOT EXISTS, hence the prepared-
-- statement guard on information_schema.STATISTICS.

-- idx_product_locations_lookup_covering (productId, locationId, quantity)
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_locations' AND INDEX_NAME='idx_product_locations_lookup_covering');
SET @sql := IF(@idx=0, 'CREATE INDEX `idx_product_locations_lookup_covering` ON `product_locations`(`productId`,`locationId`,`quantity`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_product_locations_by_location (locationId, productId)
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_locations' AND INDEX_NAME='idx_product_locations_by_location');
SET @sql := IF(@idx=0, 'CREATE INDEX `idx_product_locations_by_location` ON `product_locations`(`locationId`,`productId`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_products_bulk_lookup (id, baseName, variant, name)
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND INDEX_NAME='idx_products_bulk_lookup');
SET @sql := IF(@idx=0, 'CREATE INDEX `idx_products_bulk_lookup` ON `products`(`id`,`baseName`,`variant`,`name`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_product_locations_low_stock (quantity, productId)
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_locations' AND INDEX_NAME='idx_product_locations_low_stock');
SET @sql := IF(@idx=0, 'CREATE INDEX `idx_product_locations_low_stock` ON `product_locations`(`quantity`,`productId`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_inventory_logs_recent_changes (changeTime, productId, userId)
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='inventory_logs' AND INDEX_NAME='idx_inventory_logs_recent_changes');
SET @sql := IF(@idx=0, 'CREATE INDEX `idx_inventory_logs_recent_changes` ON `inventory_logs`(`changeTime`,`productId`,`userId`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
