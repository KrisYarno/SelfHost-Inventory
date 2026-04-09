-- Backfill for User fields that exist in prisma/schema.prisma but were never
-- captured in a migration. Drift discovered during Phase 6 QA when login failed
-- with "The column `inventory.users.phoneNumber` does not exist".
--
-- Adds: passwordHash nullability, phoneNumber, smsVerified, and the 4 min*Alerts
-- fields. All nullable or defaulted so existing rows remain valid.

ALTER TABLE `users`
  MODIFY COLUMN `passwordHash` VARCHAR(255) NULL;

ALTER TABLE `users`
  ADD COLUMN `phoneNumber` VARCHAR(20) NULL,
  ADD COLUMN `smsVerified` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `minLocationEmailAlerts` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `minLocationSmsAlerts` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `minCombinedEmailAlerts` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `minCombinedSmsAlerts` TINYINT(1) NOT NULL DEFAULT 0;
