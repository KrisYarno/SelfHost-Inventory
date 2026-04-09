-- Phase 7c.3: Webhook delivery health visibility
--
-- Adds per-integration health tracking for webhook delivery so operators
-- can see at a glance whether webhooks are actually being received and
-- whether the signature verification is passing.
--
-- lastWebhookReceivedAt: timestamp of the most recent *successful* delivery
-- lastWebhookError:      text of the most recent failure (truncated to 500)
-- webhookFailureCount:   monotonic counter, resets to 0 on next success
ALTER TABLE `integrations`
  ADD COLUMN `lastWebhookReceivedAt` DATETIME(3) NULL,
  ADD COLUMN `lastWebhookError`      TEXT NULL,
  ADD COLUMN `webhookFailureCount`   INT NOT NULL DEFAULT 0;
