#!/usr/bin/env bash
# Proves the migration chain replays on an EMPTY MySQL 8.4 (spec section 5 fresh-bootstrap gate).
# Also asserts the drift-repaired structures exist post-chain (rev-2): NotificationHistory.locationId
# (I1), its index + FK, and the five baseline-index-repair indexes that 20250108c's hand-SQL created
# but the schema-generated baseline omitted.
set -euo pipefail
NAME=lane5-fresh-bootstrap-$$
docker run -d --name "$NAME" -e MYSQL_ROOT_PASSWORD=proof -e MYSQL_DATABASE=fresh mysql:8.4 >/dev/null
trap 'docker rm -f "$NAME" >/dev/null' EXIT
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

echo "FRESH BOOTSTRAP: PASS"
