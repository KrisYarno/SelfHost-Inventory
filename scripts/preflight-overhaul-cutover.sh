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
-- THE GUARDS ARE MECHANICAL, NOT HUMAN (rehearsed on a prod-dump restore, and this
-- is what the rehearsal caught). An earlier draft printed `SELECT ROW_COUNT();`
-- after each write with a comment saying it had to be 1 — a step a human is
-- supposed to read and act on. Pasted as a script, nobody reads it: re-running (a)
-- against a row that was ALREADY discarded sailed straight past the zero-row UPDATE
-- and inserted a SECOND `STAGING_DISCARD` audit row, so the ledger claimed the box
-- was discarded twice. Every write below is therefore gated on a captured flag:
--
--   * each guarded write is followed IMMEDIATELY by `SET @rcN = ROW_COUNT();`
--     (ROW_COUNT() reports the statement that just ran, so nothing may come between);
--   * every later write is `INSERT ... SELECT ... WHERE <flags>`, so a failed
--     precondition writes NOTHING rather than writing half the story;
--   * each procedure ends with a VERDICT row before the COMMIT.
--
-- Re-running either procedure is therefore safe: the second run reports NOTHING
-- CHANGED and its COMMIT is a no-op. Both still run as ONE transaction, and both
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

-- 1. LOCK the source row and look at it before deciding anything. This read is
--    for the eye and for the lock; the GUARD is the WHERE on the write below.
SELECT id, status, description, shipmentId, resolvedProductId,
       expectedQuantity, countedQuantity, locationId, receivedBy, receivedAt
  FROM staging_items
 WHERE id = @source
   FOR UPDATE;

-- 2. THE GUARDED WRITE. The WHERE is the entire precondition: a row somebody else
--    already settled matches nothing and this write moves zero rows.
UPDATE staging_items
   SET status    = 'DISCARDED',
       notes     = CONCAT_WS('\n', NULLIF(notes,''), '[cutover straggler discarded]'),
       updatedAt = UTC_TIMESTAMP(3)
 WHERE id = @source
   AND status = 'RECEIVED';
SET @rc1 = ROW_COUNT();
-- 3. (the line above) CAPTURED THE OUTCOME IMMEDIATELY. NOTHING may sit between a
--    write's `;` and its `SET @rcN = ROW_COUNT();` — not even a comment line: the
--    MySQL 8 client sends comment-only lines to the server as their own statements,
--    which resets ROW_COUNT() to 0 (the rehearsal caught exactly that: the row was
--    discarded, @rc1 read 0, no audit row was written).

-- 4. The audit row, in the SAME transaction as the write it describes AND gated on
--    that write having happened. On a re-run @rc1 is 0 and no row is inserted.
INSERT INTO audit_logs
  (userId, actorKind, actionType, entityType, entityId, action, details, affectedCount, createdAt)
SELECT @actor, 'USER', 'STAGING_DISCARD', 'STAGING', CAST(@source AS CHAR),
       CONCAT('Discarded cutover straggler staging item ', @source),
       JSON_OBJECT('source', 'cutover-runbook', 'disposition', 'discarded'),
       1, UTC_TIMESTAMP(3)
  FROM DUAL
 WHERE @rc1 = 1;

-- 5. READ IT BACK. `discard_audit_rows` is deliberately a COUNT: one row per
--    discard, however many times this procedure is pasted.
SELECT (SELECT status FROM staging_items WHERE id = @source)      AS source_status,
       (SELECT COUNT(*) FROM audit_logs
         WHERE entityType = 'STAGING'
           AND entityId   = CAST(@source AS CHAR)
           AND actionType = 'STAGING_DISCARD')                    AS discard_audit_rows;

-- 6. THE VERDICT. Read this line before typing COMMIT.
SELECT IF(@rc1 = 1,
          'OK — commit',
          'NOTHING CHANGED — precondition failed (row not RECEIVED); COMMIT is a no-op')
       AS verdict;

COMMIT;

-- 7. Re-run scripts/preflight-overhaul-cutover.sh — it must now print PREFLIGHT: GO.


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

-- 1. LOCK + VALIDATE, AS FLAGS. Each read takes its row lock and answers 1 or 0;
--    nothing below writes unless all three answered 1.
SELECT COUNT(*) INTO @okSource
  FROM staging_items
 WHERE id = @source
   AND status = 'RECEIVED'
   AND countedQuantity IS NOT NULL                -- the count is the whole point
   AND receivedAt IS NOT NULL                     -- the receipt instant is preserved, not invented
   FOR UPDATE;

SELECT COUNT(*) INTO @okOrder
  FROM inbound_shipments
 WHERE id = @targetOrder
   AND orderedAt IS NOT NULL                      -- a supply order, never a legacy W1 receipt
   AND status IN ('RECEIVING','CLOSED')           -- a line may still be added to a closed order
   FOR UPDATE;

SELECT COUNT(*) INTO @okProduct
  FROM products
 WHERE id = @product
   AND deletedAt IS NULL                          -- a declined product is soft-deleted
   AND approvalStatus IN ('APPROVED','PENDING_REVIEW')
   FOR UPDATE;

SELECT @okSource AS ok_source, @okOrder AS ok_order, @okProduct AS ok_product;

-- 2. THE NEW SUPPLY-ORDER LINE, built FROM the straggler and gated on all three
--    flags. It is an UNORDERED arrival: nothing was ordered, so orderedProductId
--    and orderedQuantity stay NULL and the money basis is the verified count. The
--    receipt facts (locationId, receivedBy, receivedAt) are PRESERVED, not re-stamped.
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
   AND s.status = 'RECEIVED'
   AND @okSource  = 1
   AND @okOrder   = 1
   AND @okProduct = 1;
SET @rc1 = ROW_COUNT();
SET @newLine = IF(@rc1 = 1, LAST_INSERT_ID(), NULL);

-- 3. THE REGISTER ROW, gated on the line having been created. An unordered arrival
--    IS a receiving discrepancy by construction, so the row is raised with the
--    COMPLETE subject: expected and ordered are NULL (nothing was expected, so
--    nothing is short or over), the counts are the verified count, and the unit cost
--    is the HALF-EVEN share of a KNOWN total. A NULL (or zero) total leaves it NULL.
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
 WHERE s.id = @newLine
   AND @rc1 = 1;
SET @rc2 = ROW_COUNT();

-- 4. THE SOURCE, closed, naming where its units went — gated on the line AND its
--    register row both existing, so the box is never closed against a half-built line.
UPDATE staging_items
   SET status    = 'DISCARDED',
       notes     = CONCAT_WS('\n', NULLIF(notes,''),
                             CONCAT('[cutover straggler hand-linked to line ', @newLine, ']')),
       updatedAt = UTC_TIMESTAMP(3)
 WHERE id = @source
   AND status = 'RECEIVED'
   AND @rc1 = 1
   AND @rc2 = 1;
SET @rc3 = ROW_COUNT();

-- 5. TWO CORRELATED audit rows under ONE batchId: the line that was created and the
--    box that was closed are one act, and the ledger must read that way afterwards.
--    Both are gated on the whole procedure having succeeded — an audit trail that
--    describes writes which did not happen is worse than no audit trail.
SET @batch = UUID();

INSERT INTO audit_logs
  (userId, actorKind, actionType, entityType, entityId, batchId, action, details, affectedCount, createdAt)
SELECT @actor, 'USER', 'STAGING_CREATE', 'STAGING', CAST(@newLine AS CHAR), @batch,
       CONCAT('Hand-linked cutover straggler ', @source, ' as supply-order line ', @newLine),
       JSON_OBJECT('source', 'cutover-runbook', 'shipmentId', @targetOrder, 'productId', @product,
                   'fromStagingItemId', @source, 'lineTotalCents', @lineTotal,
                   'labelingRequired', @choice),
       1, UTC_TIMESTAMP(3)
  FROM DUAL
 WHERE @rc1 = 1 AND @rc2 = 1 AND @rc3 = 1;

INSERT INTO audit_logs
  (userId, actorKind, actionType, entityType, entityId, batchId, action, details, affectedCount, createdAt)
SELECT @actor, 'USER', 'STAGING_DISCARD', 'STAGING', CAST(@source AS CHAR), @batch,
       CONCAT('Discarded cutover straggler ', @source, ' - hand-linked to line ', @newLine),
       JSON_OBJECT('source', 'cutover-runbook', 'disposition', 'hand-linked',
                   'toStagingItemId', @newLine),
       1, UTC_TIMESTAMP(3)
  FROM DUAL
 WHERE @rc1 = 1 AND @rc2 = 1 AND @rc3 = 1;

-- 6. READ IT BACK. On a successful run: VERIFIED / the source count / the target
--    order / DISCARDED / 1. On a refused run: all NULL and 0.
SELECT (SELECT status           FROM staging_items WHERE id = @newLine) AS new_line_status,
       (SELECT verifiedQuantity FROM staging_items WHERE id = @newLine) AS new_line_verified,
       (SELECT shipmentId       FROM staging_items WHERE id = @newLine) AS new_line_order,
       (SELECT status           FROM staging_items WHERE id = @source)  AS source_status,
       (SELECT COUNT(*) FROM inventory_exceptions
         WHERE `key` = CONCAT('recv-discrepancy:', @newLine))           AS register_rows;

-- 7. THE VERDICT. Read this line before typing COMMIT.
SELECT IF(@rc1 = 1 AND @rc2 = 1 AND @rc3 = 1,
          'OK — commit',
          'NOTHING CHANGED — precondition failed (row not RECEIVED / order not a RECEIVING|CLOSED supply order / product not eligible); COMMIT is a no-op')
       AS verdict;

COMMIT;

-- 8. Re-run scripts/preflight-overhaul-cutover.sh — it must now print PREFLIGHT: GO.
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
