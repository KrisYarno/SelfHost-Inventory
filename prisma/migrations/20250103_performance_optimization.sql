-- Performance Optimization Migration
-- Created: 2025-01-03
-- Purpose: Add missing indexes and optimize query performance

-- 1. Inventory Logs Indexes
-- Index for time-based queries (reports, activity feeds)
CREATE INDEX IF NOT EXISTS idx_inventory_logs_changeTime 
ON inventory_logs(changeTime DESC);

-- Composite index for date range filtering with location
CREATE INDEX IF NOT EXISTS idx_inventory_logs_location_time 
ON inventory_logs(locationId, changeTime DESC);

-- Index for log type filtering
CREATE INDEX IF NOT EXISTS idx_inventory_logs_logType 
ON inventory_logs(logType);

-- Covering index for the most common query pattern (getting last update per product/location)
CREATE INDEX IF NOT EXISTS idx_inventory_logs_covering 
ON inventory_logs(productId, locationId, changeTime DESC, delta);

-- 2. Products Table Indexes
-- Index for location-based filtering
CREATE INDEX IF NOT EXISTS idx_products_location 
ON products(location);

-- Index for low stock threshold queries
CREATE INDEX IF NOT EXISTS idx_products_lowStockThreshold 
ON products(lowStockThreshold);

-- Composite index for low stock queries
CREATE INDEX IF NOT EXISTS idx_products_stock_alert 
ON products(lowStockThreshold, id, name);

-- 3. Product Locations Indexes
-- Covering index for quantity lookups
CREATE INDEX IF NOT EXISTS idx_product_locations_covering 
ON product_locations(productId, locationId, quantity);

-- Index for quantity-based queries (finding low stock items)
CREATE INDEX IF NOT EXISTS idx_product_locations_quantity 
ON product_locations(quantity);

-- 4. Notification History Indexes
-- Index for finding recent notifications
CREATE INDEX IF NOT EXISTS idx_notification_history_sentAt 
ON notification_history(sentAt DESC);

-- 5. Users Table Indexes
-- Index for approved users (common filter)
CREATE INDEX IF NOT EXISTS idx_users_isApproved 
ON users(isApproved);

-- Index for admin users
CREATE INDEX IF NOT EXISTS idx_users_isAdmin 
ON users(isAdmin);

-- Composite index for auth queries
CREATE INDEX IF NOT EXISTS idx_users_auth 
ON users(email, isApproved);

-- 6. Analyze tables to update statistics
ANALYZE inventory_logs;
ANALYZE products;
ANALYZE product_locations;
ANALYZE users;
ANALYZE notification_history;