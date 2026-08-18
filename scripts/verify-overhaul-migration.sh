#!/usr/bin/env bash
# Receiving/Labeling overhaul (contract pack REV-2 C1.3) — the permanent red->green proof of THE
# migration on prod's W1 shape: legacy staging lines and receiving headers, seeded on the
# chain-built schema, must survive two enum APPENDS, a default FLIP, three NULL-widenings and the
# receivedAt default drop with every stored byte intact.
#
# It also proves the UNGUARDED class's ONLY clean recovery (PK-3). MySQL DDL autocommits, so a
# MID-FILE failure leaves earlier statements applied and `resolve --rolled-back` + re-run would
# then die 1060/1061 on them — that path is the runbook's manual DDL surgery, not this fixture's.
# What IS provable, and what a fresh-dump rehearsal actually protects, is the FIRST-statement
# failure: nothing migration-owned has succeeded, so drop the offending structure, `migrate
# resolve --rolled-back`, re-run, same end state.
#
# Disposable-fixture carve-out: throwaway container + temp dir, torn down by trap. ~2-3 min.
set -euo pipefail
NAME=overhaul-migration-fixture-$$
TMPD=$(mktemp -d)
# cleanup tolerates a container that never started (docker run failed) so the temp dir is still removed
trap 'docker rm -f -v "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMPD"' EXIT   # -v: drop the anonymous data volume too
NEWDIR=$(ls -d prisma/migrations/*_receiving_labeling_overhaul 2>/dev/null || true)
[ -n "$NEWDIR" ] && [ "$(echo "$NEWDIR" | wc -l)" = 1 ] || { echo "OVERHAUL FIXTURE: FAIL exactly one *_receiving_labeling_overhaul dir expected" >&2; exit 1; }
MIG=$(basename "$NEWDIR")
# chain lengths are DERIVED (the next migration must not turn this fixture red)
CHAIN_TOTAL=$(ls -d prisma/migrations/*/ | wc -l); CHAIN_MINUS_ONE=$((CHAIN_TOTAL-1))

# The failure must be injected at the migration's FIRST statement (PK-3). Which column that is
# comes from the emitted block order, NOT from a guess: pin it, so a future re-emission that
# re-orders the blocks turns this fixture RED instead of silently testing a mid-file failure.
FIRST_STMT=$(grep -v '^--' "$NEWDIR/migration.sql" | grep -v '^[[:space:]]*$' | head -1)
WANT_FIRST='ALTER TABLE `inbound_shipments` ADD COLUMN `feesCents` INTEGER NULL,'
[ "$FIRST_STMT" = "$WANT_FIRST" ] || { echo "OVERHAUL FIXTURE: FAIL [first statement pin] the migration no longer starts with inbound_shipments.feesCents; got: $FIRST_STMT" >&2; exit 1; }

docker run -d --name "$NAME" -e MYSQL_ROOT_PASSWORD=proof -e MYSQL_DATABASE=fresh mysql:8.4 >/dev/null
n=0; until docker exec "$NAME" mysqladmin ping -uroot -pproof --silent 2>/dev/null; do sleep 2; n=$((n+1)); [ $n -lt 60 ] || { echo "OVERHAUL FIXTURE: FAIL mysql never answered ping" >&2; exit 1; }; done
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")
# The docker entrypoint answers `mysqladmin ping` over its socket during init, BEFORE TCP is up.
n=0; until [ -n "$IP" ] && bash -c "exec 3<>/dev/tcp/${IP}/3306" 2>/dev/null; do sleep 1; n=$((n+1)); [ $n -lt 120 ] || { echo "OVERHAUL FIXTURE: FAIL mysql TCP never came up" >&2; exit 1; }; done
URL="mysql://root:proof@${IP}:3306/fresh"
q() { docker exec "$NAME" mysql -uroot -pproof fresh -N -e "$1"; }
assert_eq() { local label="$1" sql="$2" want="$3" got; got=$(q "$sql" 2>&1 | tail -1 || true); [ "$got" = "$want" ] || { echo "OVERHAUL FIXTURE: FAIL [$label] want=$want got=$got" >&2; exit 1; }; }
# index signature: count|non_unique|type|visible|prefixed|ordered cols (the P1 SIG string)
SIG="CONCAT(COUNT(*),'|',COALESCE(MIN(NON_UNIQUE),-1),'|',COALESCE(MIN(INDEX_TYPE),''),'|',COALESCE(MIN(IS_VISIBLE),''),'|',COALESCE(SUM(SUB_PART IS NOT NULL),0),'|',COALESCE(GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLLATION) ORDER BY SEQ_IN_INDEX SEPARATOR ','),''))"
# the seeded legacy rows, byte for byte (every column the migration could disturb)
LINE_DIGEST="SET SESSION group_concat_max_len=1000000; SELECT MD5(GROUP_CONCAT(CONCAT_WS('~', id, description, status, COALESCE(expectedQuantity,'<n>'), COALESCE(countedQuantity,'<n>'), COALESCE(resolvedProductId,'<n>'), COALESCE(vendor,'<n>'), COALESCE(reference,'<n>'), COALESCE(notes,'<n>'), COALESCE(locationId,'<n>'), COALESCE(receivedBy,'<n>'), COALESCE(receivedAt,'<n>'), COALESCE(graduatedBy,'<n>'), COALESCE(graduatedAt,'<n>'), COALESCE(shipmentId,'<n>'), COALESCE(unitCostCents,'<n>'), COALESCE(countedBy,'<n>'), COALESCE(countedAt,'<n>')) ORDER BY id SEPARATOR '|')) FROM staging_items;"
HDR_DIGEST="SET SESSION group_concat_max_len=1000000; SELECT MD5(GROUP_CONCAT(CONCAT_WS('~', id, COALESCE(supplierRef,'<n>'), status, createdBy, COALESCE(closedBy,'<n>'), COALESCE(notes,'<n>'), COALESCE(closedAt,'<n>')) ORDER BY id SEPARATOR '|')) FROM inbound_shipments;"
# the two WIDENED relations' constraints, name and referential actions, captured BEFORE and
# compared AFTER (PK-1). Their DB actions are whatever the chain created — deliberately NOT
# asserted against a literal, because the schema-vs-DB action mismatch on these two FKs is a
# PRE-EXISTING drift item (it rides the P1 baseline artifact) that this wave must neither fix nor
# disturb. What must hold is that Prisma emitted no DROP/ADD for them: same name, same rules.
# A constraint dropped and recreated under Prisma's preferred name would drop OUT of this
# name-filtered set and the comparison would go red — which is the detection we want.
WIDENED_FK="SELECT GROUP_CONCAT(CONCAT(CONSTRAINT_NAME,':',DELETE_RULE,'/',UPDATE_RULE,'/',REFERENCED_TABLE_NAME) ORDER BY CONSTRAINT_NAME) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND CONSTRAINT_NAME IN ('staging_items_location_fkey','staging_items_receivedBy_fkey');"

# 1) chain MINUS the new migration, from a temp copy (never touch prisma/ in place)
cp -r prisma "$TMPD"/ && rm -rf "$TMPD"/prisma/migrations/*_receiving_labeling_overhaul
DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy --schema "$TMPD/prisma/schema.prisma"
assert_eq "chain-minus-one applied (derived from prisma/migrations)" "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" "$CHAIN_MINUS_ONE"

# 2) seed prod's W1 shape: three headers (OPEN/CLOSED/CANCELLED) and three lines
#    (RECEIVED linked to the OPEN header, GRADUATED linked to the CLOSED one with a resolved
#    product, DISCARDED with no header at all) — every line with the three about-to-be-widened
#    columns NON-NULL, which is the data invariant the legacy read layer asserts.
q "INSERT INTO locations (id, name) VALUES (1, 'Main'), (2, 'Annex');"
q "INSERT INTO users (id, username, email, isAdmin, isApproved, defaultLocationId) VALUES (900, 'fixture-receiver', 'fixture-receiver@example.test', 0, 1, 1);"
# lowStockThreshold carries no DB default since 20260711000000 — name it, don't lean on one.
q "INSERT INTO products (id, name, quantity, location, lowStockThreshold) VALUES (700, 'Fixture Widget', 5, 1, NULL);"
q "INSERT INTO inbound_shipments (id, supplierRef, status, createdBy, notes, createdAt, updatedAt) VALUES
   ('fixhdropen', 'PO-OPEN', 'OPEN', 900, 'legacy open', '2026-08-01 10:00:00.000', '2026-08-01 10:00:00.000'),
   ('fixhdrclos', 'PO-CLOSED', 'CLOSED', 900, NULL, '2026-07-01 10:00:00.000', '2026-07-02 10:00:00.000'),
   ('fixhdrcanc', NULL, 'CANCELLED', 900, 'legacy cancelled', '2026-06-01 10:00:00.000', '2026-06-02 10:00:00.000');"
q "INSERT INTO staging_items (id, description, status, expectedQuantity, countedQuantity, resolvedProductId, vendor, reference, notes, locationId, receivedBy, receivedAt, graduatedBy, graduatedAt, createdAt, updatedAt, shipmentId, unitCostCents, countedBy, countedAt) VALUES
   (500, 'legacy received box', 'RECEIVED', 10, NULL, NULL, 'ACME', 'REF-1', NULL, 1, 900, '2026-08-01 11:00:00', NULL, NULL, '2026-08-01 11:00:00', '2026-08-01 11:00:00', 'fixhdropen', NULL, NULL, NULL),
   (501, 'legacy graduated box', 'GRADUATED', 12, 12, 700, 'ACME', 'REF-2', 'went to stock', 2, 900, '2026-07-01 11:00:00', 900, '2026-07-02 09:00:00', '2026-07-01 11:00:00', '2026-07-02 09:00:00', 'fixhdrclos', 1234, 900, '2026-07-02 08:00:00'),
   (502, 'legacy discarded box', 'DISCARDED', 3, 0, NULL, NULL, NULL, 'damaged', 1, 900, '2026-06-01 11:00:00', NULL, NULL, '2026-06-01 11:00:00', '2026-06-01 12:00:00', NULL, NULL, 900, '2026-06-01 12:00:00');"
DIGEST_PRE=$(q "$LINE_DIGEST" | tail -1)
HDIGEST_PRE=$(q "$HDR_DIGEST" | tail -1)
FK_PRE=$(q "$WIDENED_FK" | tail -1)
[ -n "$DIGEST_PRE" ] && [ "$DIGEST_PRE" != "NULL" ] || { echo "OVERHAUL FIXTURE: FAIL line digest did not compute (seed empty?)" >&2; exit 1; }
[ -n "$HDIGEST_PRE" ] && [ "$HDIGEST_PRE" != "NULL" ] || { echo "OVERHAUL FIXTURE: FAIL header digest did not compute (seed empty?)" >&2; exit 1; }
[ -n "$FK_PRE" ] && [ "$FK_PRE" != "NULL" ] || { echo "OVERHAUL FIXTURE: FAIL the two widened FKs were not found pre-migration (name change upstream?)" >&2; exit 1; }

# 3) RED — the pre-migration shape, stated positively so the green half cannot pass vacuously.
#    Echoed before it is asserted, so a run's transcript carries the evidence rather than just
#    the absence of a failure.
echo "RED  pre-migration shape: staging_items.status=$(q "SELECT CONCAT(COLUMN_TYPE,' DEFAULT ',COLUMN_DEFAULT) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME='status';" | tail -1)"
echo "RED  pre-migration shape: inbound_shipments.status=$(q "SELECT CONCAT(COLUMN_TYPE,' DEFAULT ',COLUMN_DEFAULT) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inbound_shipments' AND COLUMN_NAME='status';" | tail -1)"
echo "RED  pre-migration shape: staging_items receipt columns=$(q "SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME,' ',COLUMN_TYPE,' NULLABLE=',IS_NULLABLE,' DEFAULT ',COALESCE(COLUMN_DEFAULT,'<null>')) ORDER BY COLUMN_NAME SEPARATOR '; ') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME IN ('locationId','receivedBy','receivedAt');" | tail -1)"
assert_eq "RED staging enum is the W1 list" "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME='status';" "enum('RECEIVED','GRADUATED','DISCARDED')"
assert_eq "RED header enum is the W1 list" "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inbound_shipments' AND COLUMN_NAME='status';" "enum('OPEN','CLOSED','CANCELLED')"
assert_eq "RED staging default is RECEIVED" "SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME='status';" "RECEIVED"
assert_eq "RED receivedAt still defaults CURRENT_TIMESTAMP" "SELECT CONCAT(COLUMN_DEFAULT,'|',IS_NULLABLE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME='receivedAt';" "CURRENT_TIMESTAMP|NO"
assert_eq "RED the three widenings are NOT NULL" "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME IN ('locationId','receivedBy','receivedAt') AND IS_NULLABLE='NO';" "3"
assert_eq "RED no wave column exists yet" "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND ((TABLE_NAME='staging_items' AND COLUMN_NAME IN ('orderedProductId','orderedQuantity','lineTotalCents','verifiedQuantity','verifiedBy','verifiedAt','labelingRequired','stockedQuantity','disposedQuantity')) OR (TABLE_NAME='inventory_logs' AND COLUMN_NAME IN ('stagingItemId','receiptCostCents','bookingKey')) OR (TABLE_NAME='inbound_shipments' AND COLUMN_NAME IN ('orderedAt','supplier','feesCents','feesNote')) OR (TABLE_NAME='inventory_exceptions' AND COLUMN_NAME='resolution'));" "0"
assert_eq "RED no wave index exists yet" "SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND INDEX_NAME IN ('inbound_shipments_status_orderedAt_idx','inventory_logs_stagingItemId_idx','inventory_logs_stagingItemId_bookingKey_key');" "0"

# 4) the FIRST-statement failure (PK-3): pre-create the file's first added column with the WRONG
#    shape, so `migrate deploy` dies 1060 before ANY migration-owned statement commits.
q "ALTER TABLE inbound_shipments ADD COLUMN feesCents VARCHAR(8) NULL;"
if DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy; then echo "OVERHAUL FIXTURE: FAIL [1060 probe] deploy unexpectedly succeeded" >&2; exit 1; fi
assert_eq "probe: migration recorded FAILED" "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='$MIG' AND finished_at IS NULL AND rolled_back_at IS NULL;" "1"
# the failure must be THE 1060 duplicate-column on feesCents, not any failure: a transient error
# resolved-and-retried would otherwise walk straight through this phase
echo "PROBE first-statement failure: $(q "SELECT CONCAT('_prisma_migrations row: finished_at=',COALESCE(finished_at,'<null>'),' rolled_back_at=',COALESCE(rolled_back_at,'<null>'),' 1060=',logs LIKE '%1060%',' feesCents=',logs LIKE '%feesCents%') FROM _prisma_migrations WHERE migration_name='$MIG';" | tail -1)"
assert_eq "probe: failure is 1060 on feesCents" "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='$MIG' AND finished_at IS NULL AND rolled_back_at IS NULL AND logs LIKE '%1060%' AND logs LIKE '%feesCents%';" "1"
# THE point of injecting at statement one: nothing else applied, so the re-run is clean
assert_eq "probe: no OTHER wave column applied" "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND ((TABLE_NAME='staging_items' AND COLUMN_NAME IN ('orderedProductId','orderedQuantity','lineTotalCents','verifiedQuantity','verifiedBy','verifiedAt','labelingRequired','stockedQuantity','disposedQuantity')) OR (TABLE_NAME='inventory_logs' AND COLUMN_NAME IN ('stagingItemId','receiptCostCents','bookingKey')) OR (TABLE_NAME='inbound_shipments' AND COLUMN_NAME IN ('orderedAt','supplier','feesNote')) OR (TABLE_NAME='inventory_exceptions' AND COLUMN_NAME='resolution'));" "0"
assert_eq "probe: no wave index applied" "SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND INDEX_NAME IN ('inbound_shipments_status_orderedAt_idx','inventory_logs_stagingItemId_idx','inventory_logs_stagingItemId_bookingKey_key');" "0"
assert_eq "probe: no wave FK applied" "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA='fresh' AND CONSTRAINT_NAME IN ('staging_items_verifiedBy_fkey','staging_items_orderedProductId_fkey');" "0"
assert_eq "probe: the enums are untouched" "SELECT CONCAT((SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME='status'),'/',(SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inbound_shipments' AND COLUMN_NAME='status'));" "enum('RECEIVED','GRADUATED','DISCARDED')/enum('OPEN','CLOSED','CANCELLED')"
# recovery: undo the conflicting structure by hand, mark the attempt rolled back, deploy again
q "ALTER TABLE inbound_shipments DROP COLUMN feesCents;"
DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate resolve --rolled-back "$MIG"
DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy
assert_eq "chain complete (derived)" "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='$MIG' AND finished_at IS NOT NULL;" "1"

# 5) GREEN — the end state
# 5a) the enums are APPENDS; the stored values of the seeded rows never move
assert_eq "GREEN staging enum appended" "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME='status';" "enum('RECEIVED','GRADUATED','DISCARDED','ORDERED','VERIFIED','LABELING','COMPLETE')"
assert_eq "GREEN header enum appended" "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inbound_shipments' AND COLUMN_NAME='status';" "enum('OPEN','CLOSED','CANCELLED','ORDERED','RECEIVING')"
assert_eq "GREEN seeded line statuses unchanged" "SELECT GROUP_CONCAT(status ORDER BY id) FROM staging_items WHERE id IN (500,501,502);" "RECEIVED,GRADUATED,DISCARDED"
assert_eq "GREEN seeded header statuses unchanged" "SELECT GROUP_CONCAT(status ORDER BY id) FROM inbound_shipments;" "CANCELLED,CLOSED,OPEN"
# 5b) the defaults: the line default FLIPS, the header default does NOT
assert_eq "GREEN staging default ORDERED" "SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME='status';" "ORDERED"
assert_eq "GREEN header default OPEN" "SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inbound_shipments' AND COLUMN_NAME='status';" "OPEN"
# 5c) receivedAt: default GONE, nullable, DATETIME(0) precision unchanged, no ON UPDATE snuck in
assert_eq "GREEN receivedAt default dropped" "SELECT CONCAT(COALESCE(COLUMN_DEFAULT,'<null>'),'|',IS_NULLABLE,'|',COLUMN_TYPE,'|',EXTRA) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME='receivedAt';" "<null>|YES|datetime|"
assert_eq "GREEN locationId/receivedBy nullable" "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME IN ('locationId','receivedBy') AND IS_NULLABLE='YES' AND DATA_TYPE='int';" "2"
# 5d) the new columns exist with the shapes the cores rely on
assert_eq "GREEN staging wave columns" "SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLUMN_TYPE,':',IS_NULLABLE,':',COALESCE(COLUMN_DEFAULT,'<null>')) ORDER BY COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND COLUMN_NAME IN ('orderedProductId','orderedQuantity','lineTotalCents','verifiedQuantity','verifiedBy','verifiedAt','labelingRequired','stockedQuantity','disposedQuantity');" "disposedQuantity:int:NO:0,labelingRequired:tinyint(1):NO:1,lineTotalCents:int:YES:<null>,orderedProductId:int:YES:<null>,orderedQuantity:int:YES:<null>,stockedQuantity:int:NO:0,verifiedAt:datetime(3):YES:<null>,verifiedBy:int:YES:<null>,verifiedQuantity:int:YES:<null>"
assert_eq "GREEN ledger wave columns" "SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLUMN_TYPE,':',IS_NULLABLE) ORDER BY COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inventory_logs' AND COLUMN_NAME IN ('stagingItemId','receiptCostCents','bookingKey');" "bookingKey:varchar(36):YES,receiptCostCents:int:YES,stagingItemId:int:YES"
assert_eq "GREEN header wave columns" "SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLUMN_TYPE,':',IS_NULLABLE) ORDER BY COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inbound_shipments' AND COLUMN_NAME IN ('orderedAt','supplier','feesCents','feesNote');" "feesCents:int:YES,feesNote:varchar(255):YES,orderedAt:datetime(3):YES,supplier:varchar(255):YES"
assert_eq "GREEN exception resolution column" "SELECT CONCAT(COLUMN_TYPE,'|',IS_NULLABLE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inventory_exceptions' AND COLUMN_NAME='resolution';" "varchar(32)|YES"
# 5e) the legacy rows are byte-identical, and no row appeared or vanished
assert_eq "GREEN line digest unchanged" "$LINE_DIGEST" "$DIGEST_PRE"
assert_eq "GREEN header digest unchanged" "$HDR_DIGEST" "$HDIGEST_PRE"
assert_eq "GREEN row counts unchanged" "SELECT CONCAT((SELECT COUNT(*) FROM staging_items),'/',(SELECT COUNT(*) FROM inbound_shipments));" "3/3"
# 5f) the THREE frozen indexes by EXACT signature (plan P-6)
assert_eq "GREEN idx status,orderedAt" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inbound_shipments' AND INDEX_NAME='inbound_shipments_status_orderedAt_idx';" "2|1|BTREE|YES|0|status:A,orderedAt:A"
assert_eq "GREEN idx stagingItemId" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inventory_logs' AND INDEX_NAME='inventory_logs_stagingItemId_idx';" "1|1|BTREE|YES|0|stagingItemId:A"
assert_eq "GREEN unique stagingItemId,bookingKey" "SELECT $SIG FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='inventory_logs' AND INDEX_NAME='inventory_logs_stagingItemId_bookingKey_key';" "2|0|BTREE|YES|0|stagingItemId:A,bookingKey:A"
# and the pre-overhaul ledger rows (both columns NULL) stay legal under that UNIQUE
q "INSERT INTO inventory_logs (userId, productId, delta, changeTime, locationId, logType) VALUES (900, 700, 1, '2026-08-01 12:00:00.000', 1, 'ADJUSTMENT'), (900, 700, 1, '2026-08-01 12:00:01.000', 1, 'ADJUSTMENT');"
assert_eq "GREEN NULL bookingKeys are unconstrained" "SELECT COUNT(*) FROM inventory_logs WHERE stagingItemId IS NULL AND bookingKey IS NULL;" "2"
# 5g) the two NEW foreign keys landed; the two WIDENED relations were NOT dropped and recreated
#     (PK-1 — the widened relations carry their current actions EXPLICITLY in the schema)
assert_eq "GREEN fk verifiedBy" "SELECT CONCAT(COLUMN_NAME,'->',REFERENCED_TABLE_NAME,'.',REFERENCED_COLUMN_NAME) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND CONSTRAINT_NAME='staging_items_verifiedBy_fkey';" "verifiedBy->users.id"
assert_eq "GREEN fk orderedProductId" "SELECT CONCAT(COLUMN_NAME,'->',REFERENCED_TABLE_NAME,'.',REFERENCED_COLUMN_NAME) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='fresh' AND TABLE_NAME='staging_items' AND CONSTRAINT_NAME='staging_items_orderedProductId_fkey';" "orderedProductId->products.id"
assert_eq "GREEN new fk actions SET NULL/CASCADE" "SELECT GROUP_CONCAT(CONCAT(CONSTRAINT_NAME,':',DELETE_RULE,'/',UPDATE_RULE) ORDER BY CONSTRAINT_NAME) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='fresh' AND CONSTRAINT_NAME IN ('staging_items_verifiedBy_fkey','staging_items_orderedProductId_fkey');" "staging_items_orderedProductId_fkey:SET NULL/CASCADE,staging_items_verifiedBy_fkey:SET NULL/CASCADE"
assert_eq "GREEN widened FKs survive under their ORIGINAL names/actions (PK-1)" "$WIDENED_FK" "$FK_PRE"
# 5h) the ORACLE the whole stored-counter decision rests on: stockedQuantity == SUM(ledger)
assert_eq "GREEN stockedQuantity oracle runs and holds" "SELECT COUNT(*) FROM staging_items s WHERE s.stockedQuantity <> (SELECT COALESCE(SUM(delta),0) FROM inventory_logs WHERE stagingItemId = s.id AND logType='STOCK_IN');" "0"
# 5i) the behaviour the code wave depends on: a line born from the DB defaults is an ORDERED
#     supply-order line with NO receipt act recorded — never a RECEIVED box in the legacy queue
q "INSERT INTO staging_items (id, description, createdAt, updatedAt) VALUES (503, 'new-flow line, defaults only', '2026-08-18 09:00:00', '2026-08-18 09:00:00');"
assert_eq "GREEN status omitted -> ORDERED" "SELECT status FROM staging_items WHERE id=503;" "ORDERED"
assert_eq "GREEN receipt columns omitted -> NULL" "SELECT CONCAT(COALESCE(receivedAt,'<null>'),'|',COALESCE(locationId,'<null>'),'|',COALESCE(receivedBy,'<null>')) FROM staging_items WHERE id=503;" "<null>|<null>|<null>"
assert_eq "GREEN counters default to 0/true" "SELECT CONCAT(stockedQuantity,'|',disposedQuantity,'|',labelingRequired) FROM staging_items WHERE id=503;" "0|0|1"

echo "OVERHAUL MIGRATION: PASS"
