#!/usr/bin/env bash
# P1 storage hygiene — the permanent red->green proof of the collation migration on prod's
# COLLATION/FK shape (manufactured on the chain-built schema; prod-only unmodeled columns are
# exercised only by the dump rehearsal + preflight). Also proves I-B: a PAD-SPACE collision makes
# the migration FAIL 1062, `prisma migrate resolve --rolled-back` + re-run reaches the same end
# state. Disposable-fixture carve-out: throwaway container + temp dir, torn down by trap.
set -euo pipefail
NAME=p1-collation-fixture-$$
TMPD=$(mktemp -d)
# cleanup tolerates a container that never started (docker run failed) so the temp dir is still removed
trap 'docker rm -f -v "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMPD"' EXIT   # -v: drop the anonymous data volume too
NEWDIR=$(ls -d prisma/migrations/*_storage_hygiene_collation_indexes 2>/dev/null || true)
[ -n "$NEWDIR" ] && [ "$(echo "$NEWDIR" | wc -l)" = 1 ] || { echo "COLLATION FIXTURE: FAIL exactly one *_storage_hygiene_collation_indexes dir expected" >&2; exit 1; }
# chain lengths are DERIVED (the next migration must not turn this fixture red)
CHAIN_TOTAL=$(ls -d prisma/migrations/*/ | wc -l); CHAIN_MINUS_ONE=$((CHAIN_TOTAL-1))
docker run -d --name "$NAME" -e MYSQL_ROOT_PASSWORD=proof -e MYSQL_DATABASE=fresh mysql:8.4 >/dev/null
n=0; until docker exec "$NAME" mysqladmin ping -uroot -pproof --silent 2>/dev/null; do sleep 2; n=$((n+1)); [ $n -lt 60 ] || { echo "COLLATION FIXTURE: FAIL mysql never answered ping" >&2; exit 1; }; done
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")
n=0; until [ -n "$IP" ] && bash -c "exec 3<>/dev/tcp/${IP}/3306" 2>/dev/null; do sleep 1; n=$((n+1)); [ $n -lt 120 ] || { echo "COLLATION FIXTURE: FAIL mysql TCP never came up" >&2; exit 1; }; done
URL="mysql://root:proof@${IP}:3306/fresh"
q() { docker exec "$NAME" mysql -uroot -pproof fresh -N -e "$1"; }
assert_eq() { local label="$1" sql="$2" want="$3" got; got=$(q "$sql" 2>&1 | tail -1 || true); [ "$got" = "$want" ] || { echo "COLLATION FIXTURE: FAIL [$label] want=$want got=$got" >&2; exit 1; }; }
assert_err() { local label="$1" sql="$2" want="$3" out; if out=$(q "$sql" 2>&1); then echo "COLLATION FIXTURE: FAIL [$label] query unexpectedly succeeded" >&2; exit 1; fi; case "$out" in *"$want"*) ;; *) echo "COLLATION FIXTURE: FAIL [$label] expected error containing: $want" >&2; exit 1;; esac; }
SIG="CONCAT(COUNT(*),'|',COALESCE(MIN(NON_UNIQUE),-1),'|',COALESCE(MIN(INDEX_TYPE),''),'|',COALESCE(MIN(IS_VISIBLE),''),'|',COALESCE(SUM(SUB_PART IS NOT NULL),0),'|',COALESCE(GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLLATION) ORDER BY SEQ_IN_INDEX SEPARATOR ','),''))"

# 1) chain MINUS the new migration, from a temp copy (never touch prisma/ in place)
cp -r prisma "$TMPD"/ && rm -rf "$TMPD"/prisma/migrations/*_storage_hygiene_collation_indexes
DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy --schema "$TMPD/prisma/schema.prisma"
assert_eq "chain-minus-one applied (derived from prisma/migrations)" "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" "$CHAIN_MINUS_ONE"

# 2) manufacture prod's collation/FK shape — ONE session (foreign_key_checks is session-scoped)
q "SET foreign_key_checks=0; ALTER TABLE users CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; ALTER TABLE products CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; ALTER TABLE products MODIFY priceSourceLinkId VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL; ALTER TABLE locations CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; ALTER TABLE notification_history CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; ALTER TABLE product_locations CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; ALTER TABLE inventory_logs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; SET foreign_key_checks=1;"

# 3) RED
assert_eq "six tables 0900" "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='fresh' AND TABLE_COLLATION='utf8mb4_0900_ai_ci';" "6"
assert_err "join orderRecordId 1267" "SELECT COUNT(*) FROM inventory_logs il JOIN external_orders eo ON eo.id = il.orderRecordId;" "Illegal mix of collations"
assert_err "join batchId 1267" "SELECT COUNT(*) FROM inventory_logs il JOIN audit_logs al ON al.batchId = il.batchId;" "Illegal mix of collations"

# 4) the new migration through Prisma's executor
DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy
assert_eq "chain complete (derived)" "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" "$CHAIN_TOTAL"
green() {
  assert_eq "$1 non-unicode tables" "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='fresh' AND TABLE_TYPE='BASE TABLE' AND TABLE_COLLATION<>'utf8mb4_unicode_ci';" "0"
  assert_eq "$1 non-unicode columns" "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME<>'utf8mb4_unicode_ci';" "0"
  assert_eq "$1 join orderRecordId" "SELECT COUNT(*) FROM inventory_logs il JOIN external_orders eo ON eo.id = il.orderRecordId;" "0"
  assert_eq "$1 join batchId" "SELECT COUNT(*) FROM inventory_logs il JOIN audit_logs al ON al.batchId = il.batchId;" "0"
  assert_eq "$1 fk_price_source_link" "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='products' AND CONSTRAINT_NAME='fk_price_source_link' AND REFERENCED_TABLE_NAME='product_links';" "1"
  assert_eq "$1 price-source orphans" "SELECT COUNT(*) FROM products p LEFT JOIN product_links pl ON pl.id=p.priceSourceLinkId WHERE p.priceSourceLinkId IS NOT NULL AND pl.id IS NULL;" "0"
  assert_eq "$1 idx orderNumber" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_orderNumber_idx';" "1|1|BTREE|YES|0|orderNumber:A"
  assert_eq "$1 idx companyId,externalCreatedAt" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_companyId_externalCreatedAt_idx';" "2|1|BTREE|YES|0|companyId:A,externalCreatedAt:A"
  assert_eq "$1 idx externalCreatedAt" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_externalCreatedAt_idx';" "1|1|BTREE|YES|0|externalCreatedAt:A"
  assert_eq "$1 idx actionType,createdAt" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='audit_logs' AND INDEX_NAME='audit_logs_actionType_createdAt_idx';" "2|1|BTREE|YES|0|actionType:A,createdAt:A"
}
green "GREEN-1"

# 5) end-state repeatability: run the file a second time via the mysql client
docker exec -i "$NAME" mysql -uroot -pproof fresh < "$NEWDIR/migration.sql"
green "GREEN-2 (second run)"

# 6) I-B proof: a PAD-SPACE collision on a converted unique key -> 1062 -> resolve -> re-run
q "SET foreign_key_checks=0; ALTER TABLE locations CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; SET foreign_key_checks=1; ALTER TABLE locations ADD UNIQUE KEY p1_probe_name (name); INSERT INTO locations (id, name) VALUES (990001, 'p1 probe'), (990002, 'p1 probe ');"
MIG=$(basename "$NEWDIR")
# make the applied migration PENDING again (fixture-only history surgery: `resolve --rolled-back`
# accepts only a FAILED migration, so the row is deleted instead) -> the next deploy re-runs the file
q "DELETE FROM _prisma_migrations WHERE migration_name='$MIG';"
if DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy; then echo "COLLATION FIXTURE: FAIL [1062 probe] deploy unexpectedly succeeded" >&2; exit 1; fi
assert_eq "probe: migration recorded FAILED" "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='$MIG' AND finished_at IS NULL AND rolled_back_at IS NULL;" "1"
# the failure must be THE 1062 collision on the probe key (Prisma stores the engine error in `logs`),
# not any failure: a 1205 / transient error resolved-and-retried would otherwise pass this phase
assert_eq "probe: failure is 1062 on p1_probe_name" "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='$MIG' AND finished_at IS NULL AND rolled_back_at IS NULL AND logs LIKE '%1062%' AND logs LIKE '%p1_probe_name%';" "1"
q "DELETE FROM locations WHERE id=990002;"
DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate resolve --rolled-back "$MIG"
DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy
green "GREEN-3 (after 1062 -> resolve -> re-run)"
echo "COLLATION MIGRATION: PASS"
