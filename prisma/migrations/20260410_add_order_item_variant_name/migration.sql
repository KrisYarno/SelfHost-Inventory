-- Phase 7e: Store the variant title on ExternalOrderItem so the UI can
-- distinguish "Tirz - 5mg" from "Tirz - 10mg" instead of showing both
-- as just "Tirz". The WC adapter already extracts variantName from the
-- line item payload but had nowhere to store it.
ALTER TABLE `external_order_items`
  ADD COLUMN `variantName` VARCHAR(500) NULL;
