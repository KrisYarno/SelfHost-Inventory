-- Amendment 4: Ensure onDelete: SetNull on ExternalOrderItem.productLink relation
-- The database FK already has ON DELETE SET NULL from the initial migration.
-- This migration makes the Prisma schema match explicitly and is a no-op at the DB level.
-- The application-level change is in the delete endpoint, which also sets isMapped = false
-- on affected ExternalOrderItems (since ON DELETE SET NULL only nulls the FK, not the boolean).

-- Verify the constraint exists with correct behavior (idempotent check)
SELECT CONSTRAINT_NAME
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_NAME = 'external_order_items'
  AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  AND CONSTRAINT_NAME = 'external_order_items_productLinkId_fkey';
