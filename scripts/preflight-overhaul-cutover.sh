#!/usr/bin/env bash
# THE CUTOVER PRECONDITION, MACHINE-CHECKED (spec section 11 "Cutover precondition";
# plan P-5 step 2; contract pack C7b.3).
#
# The Receiving/Labeling overhaul deletes the pre-staging flow outright. That is only
# safe while nothing is still IN it, and "nothing" is TWO persisted predicates:
#
#   open   = W1 receipts still open   (inbound_shipments OPEN with orderedAt IS NULL)
#   received = pre-staging boxes still queued (staging_items RECEIVED)
#
# Kris runs this against PROD after the write fence (plan P-5 step 1) and immediately
# before the flow deploy, and pastes the output into the deploy ledger. Both counts
# MUST read 0. A non-zero count is not a failure of this script — it is a drain that
# has not finished, or a straggler for the runbook (--print-runbook).
#
#   prod: scripts/preflight-overhaul-cutover.sh -- \
#           -f docker-compose.yml -f compose.stack.yml --env-file .env
#   dev:  scripts/preflight-overhaul-cutover.sh -- \
#           -f docker-compose.yml -f compose.dev.lan.yml --env-file .env
#
# Everything after `--` is passed to Docker Compose verbatim: the overlay set is the
# CALLER'S, because a bare `up`/`exec` on prod without compose.stack.yml would address
# the wrong project.
#
# CREDENTIALS NEVER LEAVE THE CONTAINER. The password is read INSIDE the db container
# from the service's own environment into `MYSQL_PWD` — never `-p<secret>` (which is
# visible in the container's process list), never into a host shell variable, never
# echoed. There is deliberately no `set -x` and the compose invocation is not printed:
# a debugging flag that dumps the command line is how a password reaches a terminal
# scrollback.
#
# Exit codes: 0 = GO, 1 = NO-GO (the counts are non-zero), 2 = the check could not run.
set -euo pipefail

# The straggler dispositions live with the plan's cutover runbook; `--print-runbook`
# prints the SQL itself so the admin does not have to go and find the document.
RUNBOOK_PATH="docs/superpowers/plans/2026-08-18-receiving-labeling-overhaul.md"

# ONE statement, two columns. One round trip, one transaction-free read, and the two
# numbers are read at the SAME instant — two separate queries could straddle a write
# and report a state that never existed.
SQL="SELECT (SELECT COUNT(*) FROM inbound_shipments WHERE status='OPEN' AND orderedAt IS NULL), (SELECT COUNT(*) FROM staging_items WHERE status='RECEIVED');"

usage() {
  cat <<'USAGE'
Usage: scripts/preflight-overhaul-cutover.sh [--print-sql | --print-runbook] [-- <docker compose args>]

  (no flag)         run the two-count check through `docker compose ... exec -T db`
                    and print GO / NO-GO.  Exit 0 = GO, 1 = NO-GO, 2 = could not run.
  --print-sql       print the counting SQL and exit (no database contact).
  --print-runbook   print the straggler runbook SQL (discard + hand-link) and exit.
  --                everything after this is passed to Docker Compose verbatim.

Environment:
  PREFLIGHT_COMPOSE_CMD   the compose command (default "docker compose"). Exists so the
                          shell self-test can drive the parser with a stub instead of a
                          real cluster; not for production use.
USAGE
}

print_runbook() {
  # A QUOTED heredoc: this is SQL to be read and pasted, so nothing in it is expanded,
  # interpolated or re-indented by the shell on the way out.
  cat <<'RUNBOOK'
-- ===========================================================================
-- CUTOVER STRAGGLER RUNBOOK (contract pack C7b.4; spec section 11 STRAGGLER POLICY)
--
-- A `staging_items` row that turns RECEIVED between the preflight check and the
-- image landing. Two dispositions, and the admin picks ONE per row:
--
--   (a) DISCARD    the box was never going to be graduated. Nothing arrived into
--                  stock, so nothing is reversed; the row is closed and audited.
--   (b) HAND-LINK  the units are real and belong to a supply order. The row becomes
--                  a VERIFIED supply-order line (an UNORDERED arrival) and the box
--                  is closed pointing at it.
--
-- BOTH run as ONE transaction, both check ROW_COUNT() before committing, and both
-- end by re-running the preflight, which must then read 0 0.
--
-- TWO RULES THAT ARE NOT NEGOTIABLE:
--   * verifiedQuantity is the count somebody actually MADE (`countedQuantity`).
--     NEVER `expectedQuantity` — that is what was expected, not what arrived.
--   * a line total is NEVER fabricated. Unknown money stays NULL; a NULL total
--     means a NULL unit cost, because $0.00 would be a number nobody can stand
--     behind.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- (a) DISCARD a cutover straggler
-- ---------------------------------------------------------------------------
SET @source = 0;   -- staging_items.id of the RECEIVED straggler
SET @actor  = 0;   -- users.id of the admin running this

START TRANSACTION;

-- 1. LOCK the source row and look at it before deciding anything.
SELECT id, status, description, shipmentId, resolvedProductId,
       expectedQuantity, countedQuantity, locationId, receivedBy, receivedAt
  FROM staging_items
 WHERE id = @source
   FOR UPDATE;                                   -- MUST return exactly 1 row, status RECEIVED

-- 2. THE GUARDED WRITE. The WHERE is the entire precondition: a row somebody else
--    already settled matches nothing, and this transaction rolls back.
UPDATE staging_items
   SET status    = 'DISCARDED',
       notes     = CONCAT_WS('\n', NULLIF(notes,''), '[cutover straggler discarded]'),
       updatedAt = UTC_TIMESTAMP(3)
 WHERE id = @source
   AND status = 'RECEIVED';

-- 3. EXACTLY ONE row must have moved. Anything else -> ROLLBACK; re-read; start again.
SELECT ROW_COUNT() AS rows_discarded;            -- MUST be 1

-- 4. The audit row, in the SAME transaction as the write it describes.
INSERT INTO audit_logs
  (userId, actorKind, actionType, entityType, entityId, action, details, affectedCount, createdAt)
VALUES
  (@actor, 'USER', 'STAGING_DISCARD', 'STAGING', CAST(@source AS CHAR),
   CONCAT('Discarded cutover straggler staging item ', @source),
   JSON_OBJECT('source', 'cutover-runbook', 'disposition', 'discarded'),
   1, UTC_TIMESTAMP(3));

COMMIT;

-- 5. Re-run scripts/preflight-overhaul-cutover.sh — it must now print PREFLIGHT: GO.


-- ---------------------------------------------------------------------------
-- (b) HAND-LINK a cutover straggler onto a supply order
-- ---------------------------------------------------------------------------
SET @source      = 0;      -- staging_items.id of the RECEIVED straggler
SET @targetOrder = '';     -- inbound_shipments.id of the supply order the units belong to
SET @product     = 0;      -- products.id that ACTUALLY arrived
SET @actor       = 0;      -- users.id of the admin running this
SET @choice      = 1;      -- labelingRequired: 1 = still needs labeling, 0 = ready to stock
SET @lineTotal   = NULL;   -- lineTotalCents: the TOTAL PAID for these units, or NULL when
                           -- unknown. NEVER inferred, never fabricated.

START TRANSACTION;

-- 1. LOCK + VALIDATE. Each of these three MUST return exactly one row; an empty
--    result means the precondition does not hold -> ROLLBACK.
SELECT id, status, countedQuantity, receivedAt, receivedBy, locationId, description
  FROM staging_items
 WHERE id = @source
   AND status = 'RECEIVED'
   AND countedQuantity IS NOT NULL                -- the count is the whole point
   AND receivedAt IS NOT NULL                     -- the receipt instant is preserved, not invented
   FOR UPDATE;

SELECT id, status, orderedAt
  FROM inbound_shipments
 WHERE id = @targetOrder
   AND orderedAt IS NOT NULL                      -- a supply order, never a legacy W1 receipt
   AND status IN ('RECEIVING','CLOSED')           -- a line may still be added to a closed order
   FOR UPDATE;

SELECT id, name, approvalStatus, deletedAt
  FROM products
 WHERE id = @product
   AND deletedAt IS NULL                          -- a declined product is soft-deleted
   AND approvalStatus IN ('APPROVED','PENDING_REVIEW')
   FOR UPDATE;

-- 2. THE NEW SUPPLY-ORDER LINE, built FROM the straggler. It is an UNORDERED
--    arrival: nothing was ordered, so orderedProductId and orderedQuantity stay
--    NULL and the money basis is the verified count. The receipt facts
--    (locationId, receivedBy, receivedAt) are PRESERVED, not re-stamped.
INSERT INTO staging_items
  (description, status, shipmentId,
   orderedProductId, resolvedProductId, orderedQuantity, lineTotalCents,
   verifiedQuantity, verifiedBy, verifiedAt, labelingRequired,
   stockedQuantity, disposedQuantity,
   locationId, receivedBy, receivedAt, createdAt, updatedAt)
SELECT p.name, 'VERIFIED', @targetOrder,
       NULL, @product, NULL, @lineTotal,
       s.countedQuantity, @actor, UTC_TIMESTAMP(3), @choice,
       0, 0,
       s.locationId, s.receivedBy, s.receivedAt, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
  FROM staging_items s
  JOIN products p ON p.id = @product
 WHERE s.id = @source
   AND s.status = 'RECEIVED';

SELECT ROW_COUNT() AS rows_inserted;             -- MUST be 1
SET @newLine = LAST_INSERT_ID();                 -- captured BEFORE any later INSERT moves it

-- 3. THE REGISTER ROW. An unordered arrival IS a receiving discrepancy by
--    construction, so the row is raised with the COMPLETE subject: expected and
--    ordered are NULL (nothing was expected, so nothing is short or over), the
--    counts are the verified count, and the unit cost is the HALF-EVEN share of a
--    KNOWN total. A NULL (or zero) total leaves the unit cost NULL.
INSERT INTO inventory_exceptions
  (`key`, kind, subject, firstSeenAt, lastSeenAt, note)
SELECT CONCAT('recv-discrepancy:', @newLine),
       'recv-discrepancy',
       JSON_OBJECT(
         'stagingItemId',     @newLine,
         'shipmentId',        @targetOrder,
         'productId',         @product,
         'orderedProductId',  NULL,
         'expectedQty',       NULL,
         'countedQty',        s.verifiedQuantity,
         'orderedQuantity',   NULL,
         'verifiedQuantity',  s.verifiedQuantity,
         'shortUnits',        0,
         'overUnits',         0,
         'unitCostCents',
           CASE
             WHEN @lineTotal IS NULL OR @lineTotal = 0
               OR s.verifiedQuantity IS NULL OR s.verifiedQuantity <= 0 THEN NULL
             -- round-half-even(total / basis), the arithmetic lib/supply-orders/money.ts
             -- performs: MySQL's ROUND() is half-away-from-zero and would drift the
             -- product cost series upward on every tie.
             WHEN 2 * (@lineTotal MOD s.verifiedQuantity) > s.verifiedQuantity
               THEN FLOOR(@lineTotal / s.verifiedQuantity) + 1
             WHEN 2 * (@lineTotal MOD s.verifiedQuantity) < s.verifiedQuantity
               THEN FLOOR(@lineTotal / s.verifiedQuantity)
             ELSE FLOOR(@lineTotal / s.verifiedQuantity)
                  + (FLOOR(@lineTotal / s.verifiedQuantity) MOD 2)
           END,
         'lossCents',         0,
         'surplusValueCents', 0,
         'note',              CONCAT('cutover straggler hand-linked from staging item ', @source)
       ),
       UTC_TIMESTAMP(3), UTC_TIMESTAMP(3),
       CONCAT('cutover straggler hand-linked from staging item ', @source)
  FROM staging_items s
 WHERE s.id = @newLine;

SELECT ROW_COUNT() AS register_rows_written;     -- MUST be 1

-- 4. THE SOURCE, closed, naming where its units went.
UPDATE staging_items
   SET status    = 'DISCARDED',
       notes     = CONCAT_WS('\n', NULLIF(notes,''),
                             CONCAT('[cutover straggler hand-linked to line ', @newLine, ']')),
       updatedAt = UTC_TIMESTAMP(3)
 WHERE id = @source
   AND status = 'RECEIVED';

SELECT ROW_COUNT() AS rows_discarded;            -- MUST be 1

-- 5. TWO CORRELATED audit rows under ONE batchId: the line that was created and the
--    box that was closed are one act, and the ledger must read that way afterwards.
SET @batch = UUID();

INSERT INTO audit_logs
  (userId, actorKind, actionType, entityType, entityId, batchId, action, details, affectedCount, createdAt)
VALUES
  (@actor, 'USER', 'STAGING_CREATE', 'STAGING', CAST(@newLine AS CHAR), @batch,
   CONCAT('Hand-linked cutover straggler ', @source, ' as supply-order line ', @newLine),
   JSON_OBJECT('source', 'cutover-runbook', 'shipmentId', @targetOrder, 'productId', @product,
               'fromStagingItemId', @source, 'lineTotalCents', @lineTotal,
               'labelingRequired', @choice),
   1, UTC_TIMESTAMP(3)),
  (@actor, 'USER', 'STAGING_DISCARD', 'STAGING', CAST(@source AS CHAR), @batch,
   CONCAT('Discarded cutover straggler ', @source, ' - hand-linked to line ', @newLine),
   JSON_OBJECT('source', 'cutover-runbook', 'disposition', 'hand-linked',
               'toStagingItemId', @newLine),
   1, UTC_TIMESTAMP(3));

-- 6. VERIFY BEFORE COMMITTING. Read it back; if any column disagrees -> ROLLBACK.
SELECT (SELECT status           FROM staging_items WHERE id = @newLine) AS new_line_status,    -- VERIFIED
       (SELECT verifiedQuantity FROM staging_items WHERE id = @newLine) AS new_line_verified,  -- = the source count
       (SELECT shipmentId       FROM staging_items WHERE id = @newLine) AS new_line_order,     -- = @targetOrder
       (SELECT status           FROM staging_items WHERE id = @source)  AS source_status,      -- DISCARDED
       (SELECT COUNT(*) FROM inventory_exceptions
         WHERE `key` = CONCAT('recv-discrepancy:', @newLine))           AS register_rows;      -- 1

COMMIT;

-- 7. Re-run scripts/preflight-overhaul-cutover.sh — it must now print PREFLIGHT: GO.
RUNBOOK
}

MODE="check"
COMPOSE_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --print-sql)
      MODE="print-sql"
      shift
      ;;
    --print-runbook)
      MODE="print-runbook"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      COMPOSE_ARGS=("$@")
      break
      ;;
    *)
      echo "preflight: unknown argument '$1' (Docker Compose arguments go after --)" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  print-sql)
    printf '%s\n' "$SQL"
    exit 0
    ;;
  print-runbook)
    print_runbook
    exit 0
    ;;
esac

# The compose command as an ARRAY: "docker compose" is two words, and a caller's
# override may be more. Word-splitting it once here beats an unquoted expansion at
# the call site.
read -r -a COMPOSE_CMD <<<"${PREFLIGHT_COMPOSE_CMD:-docker compose}"

# Everything sensitive happens INSIDE the container: `$MYSQL_PASSWORD`, `$MYSQL_USER`
# and `$MYSQL_DATABASE` are the db service's OWN environment (docker-compose.yml), and
# the single quotes below are what keep this shell from ever expanding them. MYSQL_PWD
# rather than -p<secret>: the latter is readable in `ps` for the life of the query.
REMOTE_SHELL='export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysql --batch --skip-column-names -u"$MYSQL_USER" "$MYSQL_DATABASE"'

# --batch --skip-column-names: two integers, tab-separated, no header, no box drawing.
# The SQL arrives on stdin (which is why `exec -T` is not optional).
if ! OUTPUT=$(printf '%s\n' "$SQL" \
  | "${COMPOSE_CMD[@]}" ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} exec -T db sh -lc "$REMOTE_SHELL"); then
  echo "PREFLIGHT: ERROR - the counting query did not run (compose arguments, or the db service is not up)" >&2
  exit 2
fi

LINE=$(printf '%s\n' "$OUTPUT" | grep -v '^[[:space:]]*$' | tail -n 1 || true)
read -r OPEN_HEADERS RECEIVED_ROWS _REST <<<"${LINE:-}"

if ! [[ "${OPEN_HEADERS:-}" =~ ^[0-9]+$ ]] || ! [[ "${RECEIVED_ROWS:-}" =~ ^[0-9]+$ ]]; then
  echo "PREFLIGHT: ERROR - expected two integers from the counting query" >&2
  exit 2
fi

if [ "$OPEN_HEADERS" = "0" ] && [ "$RECEIVED_ROWS" = "0" ]; then
  echo "PREFLIGHT: GO"
  exit 0
fi

echo "PREFLIGHT: NO-GO (open=$OPEN_HEADERS, received=$RECEIVED_ROWS)"
echo "Straggler runbook: $RUNBOOK_PATH (or run: $0 --print-runbook)"
exit 1
