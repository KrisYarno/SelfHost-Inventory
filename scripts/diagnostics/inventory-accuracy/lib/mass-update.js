//
// Phase 0a / D2 — the PURE mass-update batch discriminator. No DB, no I/O;
// every branch is pinned by
// __tests__/unit/scripts/diagnostics/inventory-accuracy-classify.test.js.
//
// Extracted out of d2-inbound.js so the identification rule — the thing the
// whole "OVERWRITE/COUNT-EVENT DATES" panel rests on — can be pinned against
// authored fixtures instead of only against a live restore.
//

/** FROZEN label (spec §D2 / G2-7). Never "baselines". */
const MASS_UPDATE_LABEL =
  "overwrite/count-event dates — touched rows only; physical-count coverage unknown";

const toSet = (v) => (v instanceof Set ? v : new Set(v || []));

/**
 * Identify a batch as a mass-update (overwrite/count) operation.
 *
 * THE HISTORICAL DISCRIMINATOR (frozen, spec §D2): audit actionType
 * INVENTORY_BULK_UPDATE + the `details.rows` shape, MINUS batches carrying SALE
 * ledger rows — deduct-simple writes the same actionType and is disambiguated by
 * row logType. Operations of >500 rows replace `details.rows` with
 * rowCount+rowsOmitted, so they are identified separately and labelled as such.
 * This branch is KEPT: it is the only evidence historical batches carry.
 *
 * THE FORWARD-COMPAT BRANCH (Phase 0b-1): from that deploy on, mass-update
 * stamps `logType: COUNT` on every ledger row it writes, and no other writer in
 * the repo writes COUNT. A batch carrying COUNT rows is therefore a count
 * operation on the LEDGER's own evidence — which is strictly stronger than the
 * audit shape, because the audit summary is best-effort (recordIngestion, P-B1:
 * a failed summary must not fail the operation), so a real mass update can exist
 * with ledger rows and no audit row at all. That batch is invisible to the frozen
 * rule and identified by this one.
 *
 * Both branches are reported: `evidence` names every one that matched, so the
 * artifact says WHY a batch was identified rather than only that it was, and a
 * historical batch is never silently re-labelled as if it carried ledger proof.
 *
 * @param {{auditActionTypes?: Set<string>|string[], logTypes?: Set<string>|string[],
 *          hasRowsShape?: boolean, hasRowsOmitted?: boolean}} batch
 * @returns {{isMassUpdate: boolean, isMassUpdateRowsOmitted: boolean, evidence: string[]}}
 *   `isMassUpdateRowsOmitted` stays the DEGRADED case — an operation identified
 *   only by the >500-row fallback, whose per-row audit detail is gone. A
 *   post-0b-1 batch with COUNT rows is a full identification even at >500 rows.
 */
function classifyMassUpdateBatch(batch) {
  const auditActionTypes = toSet(batch.auditActionTypes);
  const logTypes = toSet(batch.logTypes);
  const bulk = auditActionTypes.has("INVENTORY_BULK_UPDATE");
  const hasSale = logTypes.has("SALE");
  const hasRowsShape = batch.hasRowsShape === true;
  const hasRowsOmitted = batch.hasRowsOmitted === true;

  const evidence = [];
  const auditShape = bulk && hasRowsShape && !hasSale;
  const auditShapeRowsOmitted = bulk && !hasRowsShape && hasRowsOmitted && !hasSale;
  const countLogType = logTypes.has("COUNT");
  if (auditShape) evidence.push("audit-rows-shape");
  if (auditShapeRowsOmitted) evidence.push("audit-rows-omitted");
  if (countLogType) evidence.push("count-logtype");

  return {
    isMassUpdate: auditShape || countLogType,
    isMassUpdateRowsOmitted: auditShapeRowsOmitted && !countLogType,
    evidence,
  };
}

module.exports = { MASS_UPDATE_LABEL, classifyMassUpdateBatch };
