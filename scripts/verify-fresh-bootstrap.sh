#!/usr/bin/env bash
# Proves the migration chain replays on an EMPTY MySQL 8.4 (spec section 5 fresh-bootstrap gate).
# Also asserts the drift-repaired structures exist post-chain (rev-2): NotificationHistory.locationId
# (I1), its index + FK, and the five baseline-index-repair indexes that 20250108c's hand-SQL created
# but the schema-generated baseline omitted.
set -euo pipefail
NAME=lane5-fresh-bootstrap-$$
docker run -d --name "$NAME" -e MYSQL_ROOT_PASSWORD=proof -e MYSQL_DATABASE=fresh mysql:8.4 >/dev/null
trap 'docker rm -f -v "$NAME" >/dev/null 2>&1 || true' EXIT   # -v: drop the anonymous data volume too (P1 QA-1)
until docker exec "$NAME" mysqladmin ping -uroot -pproof --silent 2>/dev/null; do sleep 2; done
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")
# MySQL's docker entrypoint answers `mysqladmin ping` over its unix socket during the
# temporary-server init phase (skip-networking) BEFORE TCP is up. Wait for the real
# networked server so the host-side prisma migrate deploy cannot race into a P1001.
until bash -c "exec 3<>/dev/tcp/${IP}/3306" 2>/dev/null; do sleep 1; done
DATABASE_URL="mysql://root:proof@${IP}:3306/fresh" ./node_modules/.bin/prisma migrate deploy

q() { docker exec "$NAME" mysql -uroot -pproof fresh -N -e "$1"; }

# I1: NotificationHistory.locationId column must exist post-chain.
q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='notification_history' AND COLUMN_NAME='locationId';" | tail -1 | grep -q '^1$'

# I1: the composite index including locationId must exist.
q "SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='notification_history' AND INDEX_NAME='idx_user_product_loc_type';" | tail -1 | grep -q '^1$'

# I1: the FK from notification_history.locationId to locations must exist.
q "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='notification_history' AND CONSTRAINT_NAME='notification_history_locationId_fkey';" | tail -1 | grep -q '^1$'

# Baseline index repair: all five hand-SQL indexes must exist post-chain.
q "SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND INDEX_NAME IN ('idx_product_locations_lookup_covering','idx_product_locations_by_location','idx_products_bulk_lookup','idx_product_locations_low_stock','idx_inventory_logs_recent_changes');" | tail -1 | grep -q '^5$'

# S2/P4: webhook_deliveries table + external_orders.updatedAt index must exist post-chain.
q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='webhook_deliveries';" | tail -1 | grep -q '^1$'
q "SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_updatedAt_idx';" | tail -1 | grep -q '^1$'

# W1-1 (inventory-accuracy lane, pack T1): both new tables must exist post-chain.
q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME IN ('inbound_shipments','inventory_exceptions');" | tail -1 | grep -q '^2$'

# W1-1: the four staging_items additions (shipment link, line cost, count actor+time).
q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME IN ('shipmentId','unitCostCents','countedBy','countedAt');" | tail -1 | grep -q '^4$'

# W1-1: the two inventory_logs soft-ref columns. orderRecordId is the FINAL name —
# it is deliberately NOT the prod-only legacy `externalOrderId` (INT + FK to a
# legacy-preserve table), which this chain never creates and never touches.
q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inventory_logs' AND COLUMN_NAME IN ('orderRecordId','inboundShipmentId');" | tail -1 | grep -q '^2$'

# W1-1: the three indexes on the new soft-ref columns must exist post-chain.
q "SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND INDEX_NAME IN ('staging_items_shipmentId_idx','inventory_logs_orderRecordId_idx','inventory_logs_inboundShipmentId_idx');" | tail -1 | grep -q '^3$'

# W1-1: the exception key must be UNIQUE — the whole upsert-on-key lifecycle rests on it.
q "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inventory_exceptions' AND CONSTRAINT_NAME='inventory_exceptions_key_key' AND CONSTRAINT_TYPE='UNIQUE';" | tail -1 | grep -q '^1$'

# P1: labelled assertion — under `set -e` a bare failing grep says nothing about WHICH line died.
assert_eq() { local label="$1" sql="$2" want="$3" got; got=$(q "$sql" 2>&1 | tail -1 || true); [ "$got" = "$want" ] || { echo "FRESH BOOTSTRAP: FAIL [$label] want=$want got=$got" >&2; exit 1; }; }

# P1 storage hygiene: after the chain, EVERY table (37 models + _prisma_migrations, which Prisma
# creates as unicode_ci) is utf8mb4_unicode_ci and no column carries another collation. On a
# fresh chain the CONVERT statements are no-ops (the baseline already emits unicode_ci) — this
# asserts the END STATE the migration guarantees on prod, where the six Railway-era tables start
# at 0900_ai_ci. NOTHING here exercises a CONVERT: that proof is scripts/verify-collation-migration.sh.
assert_eq "P1 table-count tripwire (UPDATE when a migration adds a table)" "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='fresh' AND TABLE_TYPE='BASE TABLE';" "38"
assert_eq "P1 non-unicode tables" "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='fresh' AND TABLE_TYPE='BASE TABLE' AND TABLE_COLLATION<>'utf8mb4_unicode_ci';" "0"
assert_eq "P1 non-unicode columns" "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME<>'utf8mb4_unicode_ci';" "0"
assert_eq "P1 six legacy tables unicode" "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME IN ('inventory_logs','products','users','locations','product_locations','notification_history') AND TABLE_COLLATION='utf8mb4_unicode_ci';" "6"

# P1: the four evidenced indexes by EXACT signature (count|non_unique|type|visible|prefixed|ordered cols).
SIG="CONCAT(COUNT(*),'|',COALESCE(MIN(NON_UNIQUE),-1),'|',COALESCE(MIN(INDEX_TYPE),''),'|',COALESCE(MIN(IS_VISIBLE),''),'|',COALESCE(SUM(SUB_PART IS NOT NULL),0),'|',COALESCE(GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLLATION) ORDER BY SEQ_IN_INDEX SEPARATOR ','),''))"
assert_eq "P1 idx orderNumber" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_orderNumber_idx';" "1|1|BTREE|YES|0|orderNumber:A"
assert_eq "P1 idx companyId,externalCreatedAt" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_companyId_externalCreatedAt_idx';" "2|1|BTREE|YES|0|companyId:A,externalCreatedAt:A"
assert_eq "P1 idx externalCreatedAt" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='external_orders' AND INDEX_NAME='external_orders_externalCreatedAt_idx';" "1|1|BTREE|YES|0|externalCreatedAt:A"
assert_eq "P1 idx actionType,createdAt" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='audit_logs' AND INDEX_NAME='audit_logs_actionType_createdAt_idx';" "2|1|BTREE|YES|0|actionType:A,createdAt:A"

# P1: the string FK on a converted table and the auth unique key survive the chain.
assert_eq "P1 fk_price_source_link" "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='products' AND CONSTRAINT_NAME='fk_price_source_link' AND COLUMN_NAME='priceSourceLinkId' AND REFERENCED_TABLE_NAME='product_links' AND REFERENCED_COLUMN_NAME='id';" "1"
assert_eq "P1 users.email unique" "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='users' AND CONSTRAINT_NAME='email' AND CONSTRAINT_TYPE='UNIQUE';" "1"

echo "FRESH BOOTSTRAP: PASS"
