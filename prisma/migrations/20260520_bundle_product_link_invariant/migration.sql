-- Enforce: a product_link is either a single mapping (internalProductId IS NOT NULL, isBundle=0)
-- or a bundle (internalProductId IS NULL, isBundle=1). Never both, never neither.
-- (MySQL 8 doesn't allow CHECK constraints that reference FK columns; use triggers.)
--
-- NOTE: Prisma's migrate runner uses the mysql2 driver directly and does NOT support
-- the DELIMITER directive (that's a mysql CLI client feature). The triggers below are
-- written as plain SQL without DELIMITER blocks — the driver sends each CREATE TRIGGER
-- statement as a single multi-line command, which mysql2 handles correctly.
--
-- To verify manually in mysql CLI:
--   INSERT INTO product_links (..., isBundle=1, internalProductId=1) → should fail with
--   SIGNAL SQLSTATE '45000': 'product_links: isBundle=1 requires internalProductId IS NULL...'

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
