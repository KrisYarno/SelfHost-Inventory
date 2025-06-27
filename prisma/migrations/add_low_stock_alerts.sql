-- Add low stock threshold to products table
ALTER TABLE products ADD COLUMN lowStockThreshold INT DEFAULT 1 AFTER location;

-- Add email alerts preference to users table  
ALTER TABLE users ADD COLUMN emailAlerts BOOLEAN DEFAULT FALSE AFTER defaultLocationId;

-- Create notification history table
CREATE TABLE notification_history (
  id INT PRIMARY KEY AUTO_INCREMENT,
  userId INT NOT NULL,
  productId INT NOT NULL,
  notificationType VARCHAR(50) NOT NULL,
  sentAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_user FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_product FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_user_product_type (userId, productId, notificationType),
  INDEX idx_notif_product (productId)
);