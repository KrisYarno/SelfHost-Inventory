-- Add indices for reports system performance
-- These indices optimize queries for product movement and trend reports

-- Index for time-range queries that aggregate by product
CREATE INDEX `idx_logs_time_product_delta` ON `inventory_logs`(`changeTime`, `productId`, `delta`);

-- Index for product-specific time-range queries
CREATE INDEX `idx_logs_product_time_delta` ON `inventory_logs`(`productId`, `changeTime`, `delta`);
