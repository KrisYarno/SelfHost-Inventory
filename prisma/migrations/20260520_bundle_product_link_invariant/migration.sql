-- Enforce: a product_link is either a single mapping (internalProductId IS NOT NULL, isBundle=0)
-- or a bundle (internalProductId IS NULL, isBundle=1). Never both, never neither.
-- (MySQL 8 doesn't allow CHECK constraints that reference FK columns; use triggers.)
--
-- NOTE: Prisma's migrate deploy uses the schema-engine binary (quaint), which
-- handles BEGIN/END compound statements natively. No DELIMITER directive is
-- required by Prisma.
-- WARNING: If you run this file directly via the `mysql` CLI, you MUST wrap
-- each CREATE TRIGGER / CREATE PROCEDURE in DELIMITER $$ ... $$ blocks. The
-- mysql CLI's statement splitter is not BEGIN/END aware.
--
-- To verify manually in mysql CLI:
--   INSERT INTO product_links (..., isBundle=1, internalProductId=1) → should fail with
--   SIGNAL SQLSTATE '45000': 'product_links: isBundle=1 requires internalProductId IS NULL...'

-- Pre-flight heal: abort if any product_links row already violates the invariant.
-- Once triggers install, violating rows can never be UPDATEd (the trigger blocks any
-- write that doesn't satisfy the constraint), so we must catch them before install.
-- A non-empty result here means migration #20260519 was followed by application
-- writes that didn't enforce the invariant. Operator must manually fix the offending
-- rows (DELETE or UPDATE) before re-running this migration.

DROP PROCEDURE IF EXISTS _check_bundle_invariant;

CREATE PROCEDURE _check_bundle_invariant()
BEGIN
  DECLARE violation_count INT DEFAULT 0;
  SELECT COUNT(*) INTO violation_count
  FROM product_links
  WHERE (isBundle = 1 AND internalProductId IS NOT NULL)
     OR (isBundle = 0 AND internalProductId IS NULL);

  IF violation_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'product_links contains rows that violate the bundle/single invariant. Fix or DELETE these rows before applying triggers. Query: SELECT id, integrationId, externalProductId, isBundle, internalProductId FROM product_links WHERE (isBundle = 1 AND internalProductId IS NOT NULL) OR (isBundle = 0 AND internalProductId IS NULL);';
  END IF;
END;

CALL _check_bundle_invariant();

DROP PROCEDURE IF EXISTS _check_bundle_invariant;

DROP TRIGGER IF EXISTS product_links_bundle_invariant_insert;
DROP TRIGGER IF EXISTS product_links_bundle_invariant_update;

CREATE TRIGGER product_links_bundle_invariant_insert
BEFORE INSERT ON product_links
FOR EACH ROW
BEGIN
  IF (NEW.isBundle = 1 AND NEW.internalProductId IS NOT NULL)
     OR (NEW.isBundle = 0 AND NEW.internalProductId IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'product_links: isBundle=1 requires internalProductId IS NULL; isBundle=0 requires internalProductId IS NOT NULL';
  END IF;
END;

CREATE TRIGGER product_links_bundle_invariant_update
BEFORE UPDATE ON product_links
FOR EACH ROW
BEGIN
  IF (NEW.isBundle = 1 AND NEW.internalProductId IS NOT NULL)
     OR (NEW.isBundle = 0 AND NEW.internalProductId IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'product_links: isBundle=1 requires internalProductId IS NULL; isBundle=0 requires internalProductId IS NOT NULL';
  END IF;
END;
