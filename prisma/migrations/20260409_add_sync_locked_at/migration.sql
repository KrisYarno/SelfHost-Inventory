-- P1-3 hardening: timestamp-based sync lock that survives connection pool
-- reuse. Replaces the MySQL GET_LOCK approach which is session-scoped and
-- unreliable under Prisma's connection pooling.
--
-- Usage:
--   Acquire: UPDATE integrations SET syncLockedAt = NOW() WHERE id = ?
--            AND (syncLockedAt IS NULL OR syncLockedAt < NOW() - INTERVAL 5 MINUTE)
--   Release: UPDATE integrations SET syncLockedAt = NULL WHERE id = ?
--            AND syncLockedAt = :fencingToken
--
-- Stale locks (>5 minutes old) are treated as expired and can be re-acquired,
-- so a crashed sync process can't permanently lock an integration.
ALTER TABLE `integrations`
  ADD COLUMN `syncLockedAt` DATETIME(3) NULL;
