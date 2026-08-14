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
// copied as recorded. THIS APPLIES TO THE STRUCTURED ID ONLY — see below.
//
// ---------------------------------------------------------------------------
// THE SECOND SOURCE (reference-resolution round): free text
// ---------------------------------------------------------------------------
// The prod backfill run was a CLEAN ZERO. `details.selectedExternalOrderId` has
// never been written in production — 0 of 1,897 all-time accrual events — because
// packers never pick an order in the workbench: they TYPE the Woo order number
// into the free-text field, which lands as `details.orderReference`. All 10
// distinct prod references resolve exactly against `external_orders.orderNumber`.
// The evidence this script was written to move exists; it is in the other field.
//
// AND ITS BAR IS DIFFERENT. "No re-validation" is a statement about the
// structured id, which a server-side resolver had already proven before it was
// recorded. Free text was proven by nothing — it is a string a human typed while
// packing. So the reference source carries its own evidence bar, and it is the
// strictest one that still recovers the prod data:
//
//   the TRIMMED reference must look like an order number AND equal exactly ONE
//   `external_orders.orderNumber`.
//
// Zero matches, two or more matches, and shapes that are not order numbers are
// each skipped BY NAME (three new classes below), so everything W3's matcher
// inherits is reported rather than guessed at here. Every OTHER guarantee — the
// fill-only WHERE, the --until cutoff, batch linkage, stamped-conflict, foreign
// rows, dry-run-by-default, ids-only output — is SHARED, one implementation,
// exercised by both sources.
//
const ACCRUAL_ACTION_TYPE = "INVENTORY_BULK_UPDATE";
const ACCRUAL_DETAILS_KEY = "selectedExternalOrderId";
const ACCRUAL_REFERENCE_KEY = "orderReference";
const ACCRUAL_INTENT_KEY = "intent";
/** deduct-simple posts type "DEDUCTION", which lib/inventory.ts books as SALE. */
const ACCRUAL_LOG_TYPE = "SALE";
/** The one chip value that means "attribute this to the order" (lib/inventory/intent.ts). */
const ORDER_INTENT = "order";

/**
 * WHICH EVIDENCE stamped a batch. Two sources, named identically here and in
 * the live route (lib/orders/resolve-order-reference.ts writes the same two
 * tokens into `details.orderAttributionSource`), because an operator reading a
 * stamped row and an operator reading this summary must be reading one
 * vocabulary. They do NOT carry the same confidence, which is exactly why the
 * summary refuses to add them up into a single number.
 */
const ATTRIBUTION_SOURCE = Object.freeze({
  /** 0b-2's structured id: resolved and membership-checked BEFORE it was written. */
  SELECTED: "selected",
  /** Free text, resolved HERE against a unique order number. */
  REFERENCE_RESOLVED: "reference-resolved",
});

/**
 * A PLAUSIBLE ORDER NUMBER, defined conservatively FROM THE DATA: a run of
 * ASCII digits, 1–20 of them.
 *
 * Every one of the 10 distinct references production has ever recorded is a
 * plain digit string, and every one of them resolves. So digits is what this
 * bar admits, and nothing else — `#12345`, `WC-123`, `12 345` and `walk-in 88`
 * are `reference-unusable` even when a normalization could plausibly have
 * rescued the first two. Inventing that normalization is a MATCHER's job (W3),
 * and it would create attributions from a rule nobody reviewed; this script
 * only moves evidence that is already unambiguous. The 20-digit ceiling is not
 * a real order-number bound, it is a sanity bound: nothing longer is a Woo
 * order number, and a 200-character digit run is a paste accident.
 *
 * THE SAME RULE, DUPLICATED ON PURPOSE: lib/orders/resolve-order-reference.ts
 * carries an identical regex because this script is standalone by contract (it
 * imports @prisma/client and its own planner, never lib/ or next/). The two
 * copies are pinned equal in
 * __tests__/unit/lib/orders/resolve-order-reference.test.ts.
 */
const ORDER_REFERENCE_SHAPE = /^[0-9]{1,20}$/;

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

  // -- EVENT level, REFERENCE source. The three ways free text fails the
  //    exact-unique bar. All three are W3's inheritance, named so the operator
  //    can size it before W3 is built.
  /** The typed text is not a plausible order number at all (see ORDER_REFERENCE_SHAPE). */
  REFERENCE_UNUSABLE: "reference-unusable",
  /** A plausible number that matches NO order. Nothing to attribute to. */
  REFERENCE_UNMATCHED: "reference-unmatched",
  /** Two or more orders carry that number. Which one is unknowable here. */
  REFERENCE_AMBIGUOUS: "reference-ambiguous",
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
 * Does this event carry the STRUCTURED key at all? Presence on either the value
 * or the type claims the event for the 0b-2 source, whatever its contents.
 *
 * That precedence is the whole reason the two sources never compete: the id was
 * validated at write and the free text was not, so when both are present the
 * stronger evidence decides — and when the id is CORRUPT the event is still
 * `unusable-accrued-id`, never quietly re-judged under a weaker bar. Corrupt
 * structured evidence is a signal, not a licence to substitute.
 */
function hasStructuredAccrual(ev) {
  return ev.accruedOrderIdType != null || ev.accruedOrderId != null;
}

/** The trimmed reference, or null when the value is not a string at all. */
function normalizeOrderReference(value) {
  return typeof value === "string" ? value.trim() : null;
}

/**
 * A usable order reference is a JSON STRING whose TRIMMED value looks like an
 * order number.
 *
 * The type discipline is W2S-3's, for W2S-3's reason: JSON_UNQUOTE renders a
 * JSON number as the string "12345", so the value alone cannot say whether the
 * route recorded text or something else got in. `orderReference` is written from
 * a zod `z.string()`, so STRING is the only type it has ever had — and an event
 * carrying any other type is not the shape this script maps.
 */
function isUsableOrderReference(value, jsonType) {
  if (jsonType !== "STRING") return false;
  const trimmed = normalizeOrderReference(value);
  return trimmed !== null && ORDER_REFERENCE_SHAPE.test(trimmed);
}

/**
 * orderNumber -> the DISTINCT order ids carrying it.
 *
 * The runner's `WHERE orderNumber IN (...)` is a CANDIDATE fetch, not the
 * decision: MySQL's collation is case- and pad-insensitive, so `12345 ` comes
 * back for `12345`. The bar is EXACT, so equality is decided here on the raw
 * strings, and only exact hits count toward uniqueness.
 */
function buildOrderNumberIndex(matches) {
  const index = new Map();
  for (const m of matches) {
    if (typeof m.orderNumber !== "string" || typeof m.orderId !== "string") continue;
    if (!index.has(m.orderNumber)) index.set(m.orderNumber, new Set());
    index.get(m.orderNumber).add(m.orderId);
  }
  return index;
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
 * @param {Array<{auditLogId:number, batchId:string|null, accruedOrderId:*, accruedOrderIdType:string|null, orderReference:*, orderReferenceType:string|null, intent:string|null, intentType:string|null, createdAt:Date|null}>} input.events
 *        The accrual events, as the runner projects them (ids only). An event
 *        carries the structured key, the free-text key, or both.
 * @param {Array<{id:number, batchId:string|null, logType:string, orderRecordId:string|null}>} input.ledgerRows
 *        Every inventory_logs row belonging to those batchIds.
 * @param {Array<{orderNumber:string, orderId:string}>} [input.orderNumberMatches]
 *        Candidate `external_orders` rows for the references these events carry.
 *        Empty (or omitted) is a legitimate world — it just means no reference
 *        resolves, which is what the structured-only path always saw.
 * @param {Date} input.cutoff
 *        REQUIRED (W2S-2). The W2 deploy moment: the instant the live route
 *        started sending an intent. Before it, an event with no intent key had
 *        nowhere to record one and IS backfillable; after it, the same event is
 *        a stale client whose movement the route deliberately left unattributed.
 *        There is no safe default — a planner that guessed would silently pick
 *        one of those two meanings for every row.
 * @returns {{fills:Array, skips:Array, summary:object}}
 */
function buildBackfillPlan({ events = [], ledgerRows = [], orderNumberMatches = [], cutoff } = {}) {
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
    // WHICH EVIDENCE. Two sources of very different strength, never summed into
    // one figure: an operator must be able to see that (say) every fill in a run
    // came from free text before deciding what the run proved.
    eventsLinkableBySource: {},
    batchesPlannedBySource: {},
    rowsToFillBySource: {},
  };
  const skips = [];
  const orderNumberIndex = buildOrderNumberIndex(orderNumberMatches);

  /** One event-level skip: no fill derives from the event, so it owns no rows. */
  const skipEvent = (cls, ev) => {
    bump(summary.eventsSkippedByClass, cls);
    skips.push({
      class: cls,
      batchId: ev.batchId ?? null,
      auditLogIds: [ev.auditLogId],
      rowCount: 0,
    });
  };

  // ---- event-level screening ----------------------------------------------
  //
  // ONE ORDER OF QUESTIONS, both sources: is the evidence usable? is its era
  // readable? does it link to rows? and (references only) does it resolve? Every
  // event lands in exactly one class, and the classes are asked in that order so
  // an event never gets counted twice or filed under the second-most-true reason.
  const byBatch = new Map();
  for (const ev of events) {
    const structured = hasStructuredAccrual(ev);
    let source;
    let reference = null;

    if (structured) {
      if (!isUsableOrderId(ev.accruedOrderId, ev.accruedOrderIdType)) {
        skipEvent(SKIP_CLASS.UNUSABLE_ACCRUED_ID, ev);
        continue;
      }
      source = ATTRIBUTION_SOURCE.SELECTED;
    } else {
      if (!isUsableOrderReference(ev.orderReference, ev.orderReferenceType)) {
        skipEvent(SKIP_CLASS.REFERENCE_UNUSABLE, ev);
        continue;
      }
      source = ATTRIBUTION_SOURCE.REFERENCE_RESOLVED;
      reference = normalizeOrderReference(ev.orderReference);
    }

    // W2S-2. An event that CARRIES an intent is judged on that intent whatever
    // its date (`order` fills; anything else is the operator's stated answer,
    // settled at batch level below). An event with NO intent key is only
    // readable as "the accrual had nowhere to go" while that was still true.
    // The rule is about the ERA, not about which key the event carries, so it
    // reaches the reference source unchanged.
    if (!hasIntentKey(ev) && !isBeforeCutoff(ev.createdAt, cutoff)) {
      skipEvent(SKIP_CLASS.POST_CUTOFF_NO_INTENT, ev);
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

    let orderRecordId = ev.accruedOrderId;
    if (source === ATTRIBUTION_SOURCE.REFERENCE_RESOLVED) {
      // THE EVIDENCE BAR. Exactly one order, or nothing — with the two failure
      // modes named apart, because they mean different things to W3: unmatched
      // is "we have no such order" (a gap, or a number from another system) and
      // ambiguous is "we have too many" (a real collision a matcher must break).
      const candidates = orderNumberIndex.get(reference);
      const ids = candidates ? [...candidates] : [];
      if (ids.length === 0) {
        skipEvent(SKIP_CLASS.REFERENCE_UNMATCHED, ev);
        continue;
      }
      if (ids.length > 1) {
        skipEvent(SKIP_CLASS.REFERENCE_AMBIGUOUS, ev);
        continue;
      }
      orderRecordId = ids[0];
    }

    summary.eventsLinkable += 1;
    bump(summary.eventsLinkableBySource, source);
    if (!byBatch.has(ev.batchId)) byBatch.set(ev.batchId, []);
    // The event is never mutated — the planner is handed the runner's rows and
    // must leave them exactly as they arrived (pinned).
    byBatch.get(ev.batchId).push({ ev, orderRecordId, source });
  }

  // ---- rows, grouped by their batch ---------------------------------------
  const rowsByBatch = new Map();
  for (const r of ledgerRows) {
    if (typeof r.batchId !== "string" || r.batchId.length === 0) continue;
    if (!rowsByBatch.has(r.batchId)) rowsByBatch.set(r.batchId, []);
    rowsByBatch.get(r.batchId).push(r);
  }

  // ---- batch-level decisions ----------------------------------------------
  //
  // From here down NOTHING knows which source an entry came from except the
  // label it carries: a batch is a batch, and every guarantee below (stated
  // intent, conflict, foreign rows, fill-only, stamped-conflict) is ONE
  // implementation both sources are judged by.
  const fills = [];
  const evidence = [];
  for (const batchId of [...byBatch.keys()].sort()) {
    const batchEntries = byBatch.get(batchId);
    const batchEvents = batchEntries.map((e) => e.ev);
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

    const distinctIds = [...new Set(batchEntries.map((e) => e.orderRecordId))];
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
    // A batch fed by both sources is labelled by the STRONGER one: the
    // structured id was proven server-side at write, so once it is present it is
    // what the fill rests on and the reference merely agrees. (Two events on one
    // batchId is already a rarity; disagreement between them is a conflicting
    // accrual and never reaches here.)
    const source = batchEntries.some((e) => e.source === ATTRIBUTION_SOURCE.SELECTED)
      ? ATTRIBUTION_SOURCE.SELECTED
      : ATTRIBUTION_SOURCE.REFERENCE_RESOLVED;

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

    // The writer's contract, THREE KEYS, unchanged since W2-2: the evidence
    // label rides in `evidence` alongside rather than on the fill itself, so
    // every existing assertion about what `updateRows` is handed still holds
    // byte for byte.
    fills.push({ batchId, orderRecordId, logIds: fillable.map((r) => r.id) });
    evidence.push({
      batchId,
      source,
      orderRecordId,
      auditLogIds,
      rowCount: fillable.length,
    });
    summary.batchesPlanned += 1;
    bump(summary.batchesPlannedBySource, source);
    summary.rowsToFill += fillable.length;
    add(summary.rowsToFillBySource, source, fillable.length);
  }

  return { fills, evidence, skips, summary };
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
  ACCRUAL_REFERENCE_KEY,
  ACCRUAL_INTENT_KEY,
  ACCRUAL_LOG_TYPE,
  ORDER_INTENT,
  ATTRIBUTION_SOURCE,
  ORDER_REFERENCE_SHAPE,
  SKIP_CLASS,
  isUsableOrderId,
  isUsableOrderReference,
  normalizeOrderReference,
  buildBackfillPlan,
  executeBackfillPlan,
};
