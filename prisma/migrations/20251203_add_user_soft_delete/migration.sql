-- Add soft delete column to users table
ALTER TABLE `users` ADD COLUMN `deletedAt` DATETIME NULL;

-- Add index for efficient filtering of active users
CREATE INDEX `idx_user_deleted` ON `users`(`deletedAt`);
