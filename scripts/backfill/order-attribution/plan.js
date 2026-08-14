//
// W2-2 — the order-attribution backfill's PURE core (design REV-2 §W2
// "Backfill", pack seam S6).
//
// Everything decision-shaped about the backfill lives here: which accrual events
// are usable, which batches are ambiguous, which ledger rows get filled, and
// what the summary says. The runner (./run.js) is the only file that touches a
// database; this one is fixture-testable and side-effect-free.
//
// WHAT THIS MAPS. Phase 0b-2 (deployed 2026-08-13, code 3f978eb) made
// app/api/inventory/deduct-simple/route.ts accrue the packer's resolved order id
// into its AUDIT event's details — `details.selectedExternalOrderId`, on an
// INVENTORY_BULK_UPDATE row — at a time when inventory_logs had nowhere to put
// it. W1-1 added the column and W2-1 started stamping it live. The rows written
// in between carry the intent in the audit trail and NULL in the ledger. The
// link between the two is the `batchId`: deduct-simple mints one per request and
// stamps it on the audit event AND on every ledger row that request writes, in
// the SAME transaction (lib/inventory.ts `createInventoryTransaction` opts).
//
// WHAT IT NEEDS FROM ITS CALLER. Two facts this module cannot derive, both
// added by the W2 seam check: the W2 DEPLOY MOMENT (`cutoff` — before it an
// absent intent key meant "nowhere to record one", after it the live route read
// it as `other` and deliberately left the movement unattributed) and the
// JSON_TYPE of each projected value (`accruedOrderIdType` — JSON_UNQUOTE hands
// numbers, booleans, arrays and objects over as strings). Neither has a safe
// default, so a missing cutoff throws and a missing type is unusable.
//
// WHAT THIS DOES NOT DO — and why (design, verbatim): "NO re-validation
// (validated at write; re-checking with no session would drop admin-accrued
// rows)". The accrued id was resolved and membership-checked by
// lib/orders/resolve-selected-order.ts before it was ever written. This script
// has no session, no actor and no membership context; a re-check here would
// evaluate the WRONG predicate and silently discard correct rows. The id is
// copied as recorded.
//
const ACCRUAL_ACTION_TYPE = "INVENTORY_BULK_UPDATE";
const ACCRUAL_DETAILS_KEY = "selectedExternalOrderId";
const ACCRUAL_INTENT_KEY = "intent";
/** deduct-simple posts type "DEDUCTION", which lib/inventory.ts books as SALE. */
const ACCRUAL_LOG_TYPE = "SALE";
/** The one chip value that means "attribute this to the order" (lib/inventory/intent.ts). */
const ORDER_INTENT = "order";

/**
 * The closed skip vocabulary. Every event and every row this script declines to
 * touch lands in exactly one of these, and every one of them is COUNTED in the
 * summary — the truthful-data north star applied to a repair script: an
 * attribution we cannot make is reported, never guessed.
 */
const SKIP_CLASS = Object.freeze({
  // -- EVENT level. No fill can be derived from the event at all, so it never
  //    reaches a batch and its rows are never examined (rowCount is 0, honestly).
  /** The event carries an accrued id but no batchId — nothing links it to rows. */
  NO_BATCH_ID: "no-batch-id",
  /** The accrued value is not a usable order id (empty, JSON null, non-string). */
  UNUSABLE_ACCRUED_ID: "unusable-accrued-id",
  /**
   * W2S-2: the event was written AFTER the W2 deploy and carries no intent key
   * at all — a stale client. The live route reads that as `other` and leaves the
   * movement unattributed on purpose; filling it would manufacture exactly the
   * attribution the route declined.
   */
  POST_CUTOFF_NO_INTENT: "post-cutoff-no-intent",

  // -- BATCH level. Rows exist and are deliberately left alone; every one of
  //    them is counted under its class.
  /** The operator's chip said this movement was NOT the order's. Their answer stands. */
  EXPLICIT_NON_ORDER_INTENT: "explicit-non-order-intent",
  /** Two events on one batchId name different orders — unresolvable, whole batch skipped. */
  CONFLICTING_ACCRUAL: "conflicting-accrual",
  /** The batchId matched no ledger rows at all. */
  NO_LEDGER_ROWS: "no-ledger-rows",
  /** The batch holds a row that is not a SALE — it is not purely the accrual class. */
  FOREIGN_ROWS_IN_BATCH: "foreign-rows-in-batch",
  /** Every row in the batch already carries an orderRecordId. Fill-only, so: nothing to do. */
  ALREADY_STAMPED: "already-stamped",
  /**
   * W2S-4: a row in the batch already names a DIFFERENT order than the accrual.
   * One batch is one request and one request is one order, so the disagreement
   * is about the whole batch — its null rows are left alone too, rather than
   * splitting one request across two orders.
   */
  STAMPED_CONFLICT: "stamped-conflict",
});

/**
 * A usable accrued id is a JSON STRING whose value is non-empty and not the
 * literal token "null".
 *
 * W2S-3: the TYPE has to come from the database. The projection is
 * JSON_UNQUOTE(JSON_EXTRACT(...)), which renders a JSON number, boolean, array
 * or object as a STRING — so `typeof value === "string"` is satisfied by all of
 * them and a `42` or a `["cm0..."]` would be copied into the ledger as an order
 * id. The paired JSON_TYPE(JSON_EXTRACT(...)) is the only thing that can tell
 * them apart, and an event that does not carry one is unusable rather than
 * assumed. The literal-"null" guard stays: JSON_UNQUOTE renders a JSON null as
 * the four-character string "null" and `JSON_EXTRACT(...) IS NOT NULL` is TRUE
 * for it. Never coerced, never trimmed into existence.
 */
function isUsableOrderId(value, jsonType) {
  return (
    jsonType === "STRING" &&
    typeof value === "string" &&
    value.length > 0 &&
    value !== "null"
  );
}

/**
 * W2S-2: does this event carry an `intent` key at all? A key present with any
 * value (including JSON null, which arrives as the string "null") is a client
 * that knows about the chip; the batch-level explicit-non-order check then
 * decides what its answer was. Absent on BOTH the value and the type means the
 * event never mentioned intent.
 */
function hasIntentKey(ev) {
  return ev.intentType != null || ev.intent != null;
}

/** Strictly before the cutoff. An unreadable date is never PROVEN pre-cutoff. */
function isBeforeCutoff(createdAt, cutoff) {
  if (createdAt == null) return false;
  const at = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() < cutoff.getTime();
}

function bump(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

function add(counter, key, n) {
  counter[key] = (counter[key] || 0) + n;
}

/**
 * Build the fill plan.
 *
 * @param {object} input
 * @param {Array<{auditLogId:number, batchId:string|null, accruedOrderId:*, accruedOrderIdType:string|null, intent:string|null, intentType:string|null, createdAt:Date|null}>} input.events
 *        The 0b-2 accrual events, as the runner projects them (ids only).
 * @param {Array<{id:number, batchId:string|null, logType:string, orderRecordId:string|null}>} input.ledgerRows
 *        Every inventory_logs row belonging to those batchIds.
 * @param {Date} input.cutoff
 *        REQUIRED (W2S-2). The W2 deploy moment: the instant the live route
 *        started sending an intent. Before it, an event with no intent key had
 *        nowhere to record one and IS backfillable; after it, the same event is
 *        a stale client whose movement the route deliberately left unattributed.
 *        There is no safe default — a planner that guessed would silently pick
 *        one of those two meanings for every row.
 * @returns {{fills:Array, skips:Array, summary:object}}
 */
function buildBackfillPlan({ events = [], ledgerRows = [], cutoff } = {}) {
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
    throw new Error(
      "buildBackfillPlan: a `cutoff` Date is required — the W2 deploy moment, " +
        "which is what makes an absent intent key readable either way"
    );
  }
  const summary = {
    eventsExamined: events.length,
    eventsLinkable: 0,
    batchesExamined: 0,
    batchesPlanned: 0,
    rowsExamined: 0,
    rowsToFill: 0,
    rowsAlreadyStamped: 0,
    rowsAlreadyStampedDiffering: 0,
    rowsSkipped: 0,
    eventsSkippedByClass: {},
    batchesSkippedByClass: {},
    rowsSkippedByClass: {},
  };
  const skips = [];

  // ---- event-level screening ----------------------------------------------
  const byBatch = new Map();
  for (const ev of events) {
    if (!isUsableOrderId(ev.accruedOrderId, ev.accruedOrderIdType)) {
      bump(summary.eventsSkippedByClass, SKIP_CLASS.UNUSABLE_ACCRUED_ID);
      skips.push({
        class: SKIP_CLASS.UNUSABLE_ACCRUED_ID,
        batchId: ev.batchId ?? null,
        auditLogIds: [ev.auditLogId],
        rowCount: 0,
      });
      continue;
    }
    // W2S-2. An event that CARRIES an intent is judged on that intent whatever
    // its date (`order` fills; anything else is the operator's stated answer,
    // settled at batch level below). An event with NO intent key is only
    // readable as "the accrual had nowhere to go" while that was still true.
    if (!hasIntentKey(ev) && !isBeforeCutoff(ev.createdAt, cutoff)) {
      bump(summary.eventsSkippedByClass, SKIP_CLASS.POST_CUTOFF_NO_INTENT);
      skips.push({
        class: SKIP_CLASS.POST_CUTOFF_NO_INTENT,
        batchId: ev.batchId ?? null,
        auditLogIds: [ev.auditLogId],
        rowCount: 0,
      });
      continue;
    }
    if (typeof ev.batchId !== "string" || ev.batchId.length === 0) {
      bump(summary.eventsSkippedByClass, SKIP_CLASS.NO_BATCH_ID);
      skips.push({
        class: SKIP_CLASS.NO_BATCH_ID,
        batchId: null,
        auditLogIds: [ev.auditLogId],
        rowCount: 0,
      });
      continue;
    }
    summary.eventsLinkable += 1;
    if (!byBatch.has(ev.batchId)) byBatch.set(ev.batchId, []);
    byBatch.get(ev.batchId).push(ev);
  }

  // ---- rows, grouped by their batch ---------------------------------------
  const rowsByBatch = new Map();
  for (const r of ledgerRows) {
    if (typeof r.batchId !== "string" || r.batchId.length === 0) continue;
    if (!rowsByBatch.has(r.batchId)) rowsByBatch.set(r.batchId, []);
    rowsByBatch.get(r.batchId).push(r);
  }

  // ---- batch-level decisions ----------------------------------------------
  const fills = [];
  for (const batchId of [...byBatch.keys()].sort()) {
    const batchEvents = byBatch.get(batchId);
    const auditLogIds = batchEvents.map((e) => e.auditLogId).sort((a, b) => a - b);
    const rows = (rowsByBatch.get(batchId) || []).slice().sort((a, b) => a.id - b.id);
    summary.batchesExamined += 1;
    summary.rowsExamined += rows.length;

    // An event whose chip says anything other than `order` is a STATED
    // classification: the operator packed against that order and told us the
    // deduction was not for it. Filling over that answer would manufacture the
    // exact attribution they declined — the opposite of a repair. Decided at
    // BATCH level (not per event) so the rows are counted exactly once, and
    // checked FIRST because a stated answer settles the batch whatever else is
    // ambiguous about it.
    if (batchEvents.some((e) => e.intent != null && e.intent !== ORDER_INTENT)) {
      bump(summary.batchesSkippedByClass, SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT);
      add(summary.rowsSkippedByClass, SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT, rows.length);
      summary.rowsSkipped += rows.length;
      skips.push({
        class: SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT,
        batchId,
        auditLogIds,
        rowCount: rows.length,
      });
      continue;
    }

    const distinctIds = [...new Set(batchEvents.map((e) => e.accruedOrderId))];
    if (distinctIds.length > 1) {
      // Two accruals, two orders, one set of rows: there is no honest way to
      // divide them. Nothing in this batch is touched.
      bump(summary.batchesSkippedByClass, SKIP_CLASS.CONFLICTING_ACCRUAL);
      add(summary.rowsSkippedByClass, SKIP_CLASS.CONFLICTING_ACCRUAL, rows.length);
      summary.rowsSkipped += rows.length;
      skips.push({
        class: SKIP_CLASS.CONFLICTING_ACCRUAL,
        batchId,
        auditLogIds,
        rowCount: rows.length,
      });
      continue;
    }

    const orderRecordId = distinctIds[0];

    if (rows.length === 0) {
      bump(summary.batchesSkippedByClass, SKIP_CLASS.NO_LEDGER_ROWS);
      skips.push({ class: SKIP_CLASS.NO_LEDGER_ROWS, batchId, auditLogIds, rowCount: 0 });
      continue;
    }

    // A deduct-simple batch is SALE rows and nothing else. A batch that holds
    // anything else is not the shape this script maps — a batchId collision, or
    // some future path reusing one — so the whole batch is left alone rather
    // than filled on a guess about which rows belong to the order.
    if (rows.some((r) => r.logType !== ACCRUAL_LOG_TYPE)) {
      bump(summary.batchesSkippedByClass, SKIP_CLASS.FOREIGN_ROWS_IN_BATCH);
      add(summary.rowsSkippedByClass, SKIP_CLASS.FOREIGN_ROWS_IN_BATCH, rows.length);
      summary.rowsSkipped += rows.length;
      skips.push({
        class: SKIP_CLASS.FOREIGN_ROWS_IN_BATCH,
        batchId,
        auditLogIds,
        rowCount: rows.length,
      });
      continue;
    }

    const stamped = rows.filter((r) => r.orderRecordId != null);
    const differing = stamped.filter((r) => r.orderRecordId !== orderRecordId);
    summary.rowsAlreadyStamped += stamped.length;
    summary.rowsAlreadyStampedDiffering += differing.length;

    // W2S-4: a batch is ONE deduct-simple request, and one request went out
    // against one order. A row already stamped with a DIFFERENT id means the
    // live path and the accrual disagree about this request — so filling its
    // null siblings from the accrual would split one request across two orders,
    // a state the live path cannot produce and no reconciliation could read.
    // Fill-only already spared the stamped rows; the siblings are spared too,
    // and the whole batch is reported under its own class. (Distinct from
    // conflicting-accrual, which is two ACCRUALS disagreeing — a different
    // question with a different answer.)
    if (differing.length > 0) {
      bump(summary.batchesSkippedByClass, SKIP_CLASS.STAMPED_CONFLICT);
      add(summary.rowsSkippedByClass, SKIP_CLASS.STAMPED_CONFLICT, rows.length);
      summary.rowsSkipped += rows.length;
      skips.push({
        class: SKIP_CLASS.STAMPED_CONFLICT,
        batchId,
        auditLogIds,
        rowCount: rows.length,
      });
      continue;
    }

    const fillable = rows.filter((r) => r.orderRecordId == null);
    if (fillable.length === 0) {
      bump(summary.batchesSkippedByClass, SKIP_CLASS.ALREADY_STAMPED);
      skips.push({
        class: SKIP_CLASS.ALREADY_STAMPED,
        batchId,
        auditLogIds,
        rowCount: rows.length,
      });
      continue;
    }

    fills.push({ batchId, orderRecordId, logIds: fillable.map((r) => r.id) });
    summary.batchesPlanned += 1;
    summary.rowsToFill += fillable.length;
  }

  return { fills, skips, summary };
}

/**
 * Execute a plan through an injected writer.
 *
 * DRY RUN IS THE DEFAULT and it is not a formality: with `apply` falsy the
 * writer is never called at all, so there is no code path in which a dry run
 * reaches the database.
 *
 * `rowsRaced` = planned minus written. It is not an error: the writer's own
 * `WHERE orderRecordId IS NULL` drops any row the live W2-1 stamping path
 * claimed between the SELECT and the UPDATE. Reported so the operator sees the
 * difference instead of wondering about it.
 */
async function executeBackfillPlan(plan, { apply = false, updateRows } = {}) {
  const result = { applied: Boolean(apply), batchesWritten: 0, rowsWritten: 0, rowsRaced: 0 };
  if (!apply) return result;
  if (typeof updateRows !== "function") {
    throw new Error("executeBackfillPlan: --apply requires an updateRows writer");
  }
  for (const fill of plan.fills) {
    const affected = await updateRows(fill);
    const written = Number(affected) || 0;
    result.rowsWritten += written;
    result.rowsRaced += fill.logIds.length - written;
    if (written > 0) result.batchesWritten += 1;
  }
  return result;
}

module.exports = {
  ACCRUAL_ACTION_TYPE,
  ACCRUAL_DETAILS_KEY,
  ACCRUAL_INTENT_KEY,
  ACCRUAL_LOG_TYPE,
  ORDER_INTENT,
  SKIP_CLASS,
  isUsableOrderId,
  buildBackfillPlan,
  executeBackfillPlan,
};
