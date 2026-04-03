-- Add login lockout fields to users table
ALTER TABLE `users` ADD COLUMN `failedLoginAttempts` INT NOT NULL DEFAULT 0;
ALTER TABLE `users` ADD COLUMN `lockedUntil` DATETIME(0) NULL;
