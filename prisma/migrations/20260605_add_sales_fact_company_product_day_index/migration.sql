-- Hand-written, MySQL 8.4-aware. Covers the hub groupBy-productId-within-companies path
-- (productSalesFact.groupBy by productId WHERE companyId IN (...) AND dayKey BETWEEN ...).
-- Existing indexes are only (companyId, dayKey) + (productId, dayKey). Idempotent-ish:
-- MySQL has no CREATE INDEX IF NOT EXISTS, so guard via information_schema.
SET @exists := (
  SELECT COUNT(1) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'product_sales_facts'
    AND index_name = 'idx_sales_fact_company_product_day'
);
SET @sql := IF(@exists = 0,
  'CREATE INDEX `idx_sales_fact_company_product_day` ON `product_sales_facts` (`companyId`, `productId`, `dayKey`)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
