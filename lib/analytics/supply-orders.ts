import prisma from '@/lib/prisma';
import { InboundShipmentStatus, StagingItemStatus, inventory_logs_logType } from '@prisma/client';
import { RECEIPT_EVENT_DEFINITION } from '@/lib/reports/movement';
import type { Resolution } from '@/lib/exceptions/kinds';

/**
 * SUPPLY-ORDER ANALYTICS (spec §8, contract pack C3b/PK2-13, seam S18).
 *
 * The numbers behind the analytics hub's "Supply orders" card: what the fees
 * cost, what suppliers failed to deliver (GROSS and NET of what they made good),
 * what the labeling bench lost, what arrived above the order, and what the dock
 * actually stocked. Next-free (the route is the Next half) and read-only.
 *
 * THE TRUTHFUL-DATA RULE, which decides every field here: `valueCents` is NULL
 * **only** when nothing contributed — `contributingRows === 0` — and then it
 * carries a `reason` naming what was missing. Rows that contribute a known ZERO
 * produce `0`. "Nobody lost anything this month" and "we cannot say what was
 * lost" are different answers, and a card that renders both as $0.00 tells the
 * reader the second is the first.
 *
 * THREE POPULATIONS, deliberately not mixed:
 *
 *   ORDERS + FEES are the non-cancelled headers whose `orderedAt` falls in the
 *   window. A legacy pre-staging receipt has no `orderedAt` at all, so it is not
 *   a member of that population — it is counted SEPARATELY, by `createdAt`, and
 *   named as excluded in the coverage string rather than silently dropped or
 *   silently folded in.
 *
 *   THE THREE EXCEPTION METRICS are the register rows whose `lastSeenAt` falls
 *   in the window, OPEN AND RESOLVED. There is no disposal timestamp anywhere in
 *   this lane — the subject's cumulative money IS the current truth — so
 *   `lastSeenAt` is the only honest window basis, and a settled shortage still
 *   cost what it cost, which is why resolution is not a filter.
 *
 *   THE RECEIPTS ROLL-UP is the LEDGER (spec D10): stock-in rows that name a
 *   supply-order line, keyed by `changeTime` — when the units were stocked. An
 *   order placed in July and stocked in August is August's receiving work and
 *   July's fee, so this population has its own clock and never borrows the
 *   ordered-date one.
 *
 * GROSS AND NET ARE BOTH REPORTED, and neither replaces the other (spec D10).
 * The gross shortage is what the window's shortages cost; the net subtracts what
 * the supplier made good (`supplier-credited` / `reshipped`). The net is AS OF
 * NOW — settling a row does not move its `lastSeenAt`, so a credit note issued
 * in September changes August's net the moment it is recorded. That is the
 * intended behavior of a "what has this cost us" figure, and the definition
 * string says so out loud rather than letting a reader assume the number is
 * frozen.
 *
 * ROWS WHOSE LINE LEFT THE ORDER ARE NOT MONEY — fix-delta 2 FD2-1
 * (removed-line money). Resolution is not a filter, but REMOVAL is: a line the
 * operator took off the order (`DISCARDED`) never had a shortage or a surplus,
 * and its settled row survives only as the history of something that is no
 * longer there. The removal zeroes the row's money at the source; this read is
 * the second half of the same fact, so a row written before that fix — or by
 * any other path — cannot report a supplier loss for a line nobody ordered. The
 * excluded rows are COUNTED and named in the coverage rather than quietly
 * dropped.
 */

export type SupplyOrderAnalyticsMetric = {
  valueCents: number | null;
  /** What the number MEANS — rides every display (spec §8). */
  definition: string;
  /** Numerator/denominator plus what is deliberately outside the population. */
  coverage: string;
  contributingRows: number;
  /** Non-null EXACTLY when `valueCents` is null. */
  reason: string | null;
};

export type SupplyOrdersAnalytics = {
  window: { from: string; to: string };
  orders: { count: number; byStatus: Record<string, number> };
  /**
   * What actually ARRIVED in the window, on the LEDGER time basis (spec D10):
   * the stock-in batches whose `changeTime` falls in it, not the orders whose
   * `orderedAt` does. An order placed in July and stocked in August is August's
   * receiving work and July's fee — two different questions, two different
   * clocks, and mixing them would misreport both.
   */
  receipts: {
    orders: number;
    linesVerified: number;
    batches: number;
    unitsStocked: number;
    receiptCostCents: SupplyOrderAnalyticsMetric;
    /** The GRAIN, stated: `RECEIPT_EVENT_DEFINITION` (seam S18). */
    definition: string;
  };
  metrics: {
    fees: SupplyOrderAnalyticsMetric;
    supplierShortageCost: SupplyOrderAnalyticsMetric;
    supplierShortageCostNet: SupplyOrderAnalyticsMetric;
    labelingLossCost: SupplyOrderAnalyticsMetric;
    surplusValue: SupplyOrderAnalyticsMetric;
  };
};

/** The two register kinds this lane's money lives in. */
const MONEY_KINDS = ['recv-discrepancy', 'labeling-loss'] as const;

/**
 * The follow-up classes that mean THE SUPPLIER MADE IT GOOD (spec D10).
 *
 * Typed against the closed `Resolution` vocabulary so a renamed class breaks the
 * build here instead of quietly dropping out of the net. Every OTHER resolution
 * — `accepted-loss` above all — leaves the money exactly where the gross put it:
 * the units never arrived and nobody paid us back for them.
 */
const MADE_GOOD_RESOLUTIONS: ReadonlySet<string> = new Set<Resolution>([
  'supplier-credited',
  'reshipped',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `[from 00:00 UTC, the day AFTER `to` 00:00 UTC)`.
 *
 * Half-open and computed in UTC so the end bound is exact: a `<= to 23:59:59`
 * form drops whatever lands in the final second, and local-time arithmetic would
 * move the boundary twice a year.
 */
function windowBounds(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS);
  return { start, end };
}

/** The stored subject as an object, whatever shape the connector handed back. */
function subjectObject(subject: unknown): Record<string, unknown> {
  const value = typeof subject === 'string' ? safeParse(subject) : subject;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A money field that is REALLY there.
 *
 * A subject raised before this lane carried no money at all, and reading its
 * absence as 0 would report "this discrepancy cost nothing" about a row that
 * simply never said. Only a finite number counts.
 */
function centsOf(subject: Record<string, unknown>, field: string): number | null {
  const value = subject[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The staging line a subject names, when it names one at all.
 *
 * A row whose subject carries no usable id CANNOT be judged against a line, and
 * an unknown line is not a removed one: it stays in the fold. Dropping it would
 * silently delete real money on the strength of a missing field.
 */
function stagingItemIdOf(subject: Record<string, unknown>): number | null {
  const value = subject.stagingItemId;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Assemble one metric from a fold, applying the null-only-when-empty rule.
 *
 * The `reason` is DENOMINATOR-AWARE (spec REV-10 clause 8 / codex CR-6): "no row
 * was seen" and "rows were seen, none of them priced" are DIFFERENT facts, and
 * only the second one is a coverage hole worth chasing. Reporting them with the
 * same sentence sends the reader looking for missing rows that are right there.
 */
function metric(args: {
  valueCents: number;
  contributingRows: number;
  /** Rows of this KIND in the window — the denominator the reason speaks about. */
  kindRows: number;
  definition: string;
  coverage: string;
  /** "labeling-loss row", "recv-discrepancy rows", "non-cancelled supply orders". */
  emptyReason: string;
  /** "N <rows> remain in this window's population (K further ...); none carries ...". */
  unpricedReason: (kindRows: number) => string;
}): SupplyOrderAnalyticsMetric {
  const empty = args.contributingRows === 0;
  return {
    valueCents: empty ? null : args.valueCents,
    definition: args.definition,
    coverage: args.coverage,
    contributingRows: args.contributingRows,
    reason: empty
      ? args.kindRows === 0
        ? args.emptyReason
        : args.unpricedReason(args.kindRows)
      : null,
  };
}

/** The sentence every coverage string ends with (spec §8 / pack C3b). */
function legacyNote(legacyHeaders: number): string {
  return (
    `Legacy pre-staging receipts are excluded: ${legacyHeaders} were created in this window ` +
    'and none carries an order date or the money fields this lane added.'
  );
}

/**
 * The rows this window saw whose LINE has since left the order — fix-delta 2
 * FD2-1 (removed-line money).
 *
 * Stated ALWAYS, zero included, for the same reason `legacyNote` is: a reader
 * who cannot see that the exclusion exists cannot tell a window with nothing
 * removed from a window whose removals were never accounted for.
 */
function removedNote(kind: string, removed: number): string {
  return `${removed} further ${kind} row(s) belong to removed lines and are excluded.`;
}

/**
 * What the RECEIPTS population deliberately leaves out (spec D10).
 *
 * The roll-up counts only stock-in batches that name a supply-order line, so a
 * pre-overhaul receipt or a manual stock-in is outside it — and a reader who
 * cannot see that would take these figures for the whole of the window's
 * stock-in ledger. Said in words rather than counted: counting the excluded rows
 * would take a second read of the same table to answer a question about a
 * population this card does not report.
 */
const RECEIPTS_POPULATION_NOTE =
  'Stock-in rows that name no supply-order line (pre-overhaul receipts and manual ' +
  'stock-ins) are outside this population.';

/**
 * The EMPTY reason for an exception metric, aware of the exclusion above.
 *
 * "No row was seen in this window" is false about a window whose only rows name
 * lines that have since been removed — they were seen, and then deliberately
 * left out, which is a different fact and a different thing to go looking for.
 */
function emptyExceptionReason(noun: string, kind: string, removed: number): string {
  return removed > 0
    ? `${removed} ${kind} row(s) were seen in this window; every one belongs to a line removed from its order`
    : `no ${noun} row was seen in this window`;
}

/**
 * The UNPRICED reason for an exception metric, aware of the same exclusion.
 *
 * The denominator this sentence speaks about is the population AFTER the removed
 * lines left it (FD3-4), and a reader who sees only the reason would take "N
 * rows, none priced" for the whole window. Naming the excluded rows here as well
 * means the reason ALONE can never understate what the window held — the same
 * job `removedNote` does for the coverage string, zero included.
 */
function unpricedExceptionReason(
  kind: string,
  removed: number,
  figure: string,
): (kindRows: number) => string {
  return (kindRows) =>
    `${kindRows} ${kind} rows remain in this window's population (${removed} further belong ` +
    `to removed lines); none carries a ${figure} figure`;
}

/**
 * The window's supply-order money, with every number's basis stated.
 */
export async function getSupplyOrdersAnalytics(opts: {
  from: string;
  to: string;
}): Promise<SupplyOrdersAnalytics> {
  const { start, end } = windowBounds(opts.from, opts.to);

  const [headers, legacyHeaders, exceptions, stockedBatches] = await Promise.all([
    prisma.inboundShipment.findMany({
      where: {
        orderedAt: { gte: start, lt: end },
        // Cancelled in SQL, not in JS: a cancelled order was never delivered
        // against, so its fees are not a cost of this window.
        status: { not: InboundShipmentStatus.CANCELLED },
      },
      select: { status: true, feesCents: true },
    }),
    prisma.inboundShipment.count({
      where: { orderedAt: null, createdAt: { gte: start, lt: end } },
    }),
    prisma.inventoryException.findMany({
      where: { kind: { in: [...MONEY_KINDS] }, lastSeenAt: { gte: start, lt: end } },
      // `resolution` rides along for the NET (spec D10): the settlement CLASS is
      // a column, not a subject field, so the net costs no second read.
      select: { kind: true, subject: true, resolution: true },
    }),
    // The receipts population (spec D10): one row per stock-in BATCH, and only
    // the batches that name a supply-order line — a stock-in with no line is a
    // manual correction or a pre-overhaul receipt, and counting it as receiving
    // work would credit the dock with something no order asked for.
    prisma.inventory_logs.findMany({
      where: {
        logType: inventory_logs_logType.STOCK_IN,
        stagingItemId: { not: null },
        changeTime: { gte: start, lt: end },
      },
      select: {
        delta: true,
        stagingItemId: true,
        inboundShipmentId: true,
        receiptCostCents: true,
      },
    }),
  ]);

  // --- orders + fees ------------------------------------------------------

  const byStatus: Record<string, number> = {};
  let feesCents = 0;
  let feeRows = 0;
  for (const header of headers) {
    byStatus[header.status] = (byStatus[header.status] ?? 0) + 1;
    // NULL means "not recorded" (every legacy header, and nothing the new form
    // writes) — it is not a zero fee.
    if (header.feesCents !== null) {
      feesCents += header.feesCents;
      feeRows += 1;
    }
  }

  // --- the lines those rows name (fix-delta 2 FD2-1, removed-line money) ---
  //
  // ONE read, after the subjects are parsed once, so every row in this answer is
  // judged against the SAME line state — two reads could put the same line on
  // both sides of the exclusion within one card.

  const rows = exceptions.map((row) => ({
    kind: row.kind,
    subject: subjectObject(row.subject),
    resolution: row.resolution,
  }));
  const stagingItemIds = Array.from(
    new Set(
      rows.map((row) => stagingItemIdOf(row.subject)).filter((id): id is number => id !== null),
    ),
  );
  const lines = stagingItemIds.length
    ? await prisma.stagingItem.findMany({
        where: { id: { in: stagingItemIds } },
        select: { id: true, status: true },
      })
    : [];
  const removedLines = new Set(
    lines.filter((line) => line.status === StagingItemStatus.DISCARDED).map((line) => line.id),
  );

  // --- the register metrics ----------------------------------------------

  let shortageCents = 0;
  let shortageRows = 0;
  let settledCents = 0;
  let settledRows = 0;
  let lossCents = 0;
  let lossRows = 0;
  let surplusCents = 0;
  let surplusRows = 0;
  let discrepancyRows = 0;
  let labelingRows = 0;
  let removedDiscrepancyRows = 0;
  let removedLabelingRows = 0;

  for (const row of rows) {
    const subject = row.subject;
    const stagingItemId = stagingItemIdOf(subject);
    const removed = stagingItemId !== null && removedLines.has(stagingItemId);
    if (row.kind === 'recv-discrepancy') {
      if (removed) {
        removedDiscrepancyRows += 1;
        continue;
      }
      discrepancyRows += 1;
      const short = centsOf(subject, 'lossCents');
      if (short !== null) {
        shortageCents += short;
        shortageRows += 1;
        // The NET's subtrahend (spec D10). Only a PRICED row can be subtracted:
        // a credited shortage that never recorded what it lost tells us nothing
        // about how much came back, and inventing a 0 for it would understate
        // the gross and the net by the same unknown amount.
        if (MADE_GOOD_RESOLUTIONS.has(row.resolution ?? '')) {
          settledCents += short;
          settledRows += 1;
        }
      }
      const surplus = centsOf(subject, 'surplusValueCents');
      if (surplus !== null) {
        surplusCents += surplus;
        surplusRows += 1;
      }
    } else {
      if (removed) {
        removedLabelingRows += 1;
        continue;
      }
      labelingRows += 1;
      const lost = centsOf(subject, 'lossCents');
      if (lost !== null) {
        lossCents += lost;
        lossRows += 1;
      }
    }
  }

  // --- the receipts roll-up (spec D10, the LEDGER time basis) -------------
  //
  // COUNT(*) is the batch count because the overhaul writes exactly one stock-in
  // row per batch (D12) — the grain the definition string names. The two DISTINCT
  // counts answer different questions off the same rows: how many LINES the dock
  // verified, and how many ORDERS those lines came off.

  const receiptLines = new Set<number>();
  const receiptOrders = new Set<string>();
  let unitsStocked = 0;
  let receiptCostCents = 0;
  let pricedReceiptRows = 0;

  for (const batch of stockedBatches) {
    unitsStocked += batch.delta;
    if (batch.stagingItemId !== null) {
      receiptLines.add(batch.stagingItemId);
    }
    // A batch stocked outside any supply order is still receiving work; it is
    // simply not an ORDER, and counting a null as one would invent a delivery.
    if (batch.inboundShipmentId !== null) {
      receiptOrders.add(batch.inboundShipmentId);
    }
    // NULL means "no figure was booked with this batch" — never a free receipt.
    if (batch.receiptCostCents !== null) {
      receiptCostCents += batch.receiptCostCents;
      pricedReceiptRows += 1;
    }
  }

  const receiptBatches = stockedBatches.length;

  const legacy = legacyNote(legacyHeaders);
  const removedDiscrepancy = removedNote('recv-discrepancy', removedDiscrepancyRows);
  const removedLabeling = removedNote('labeling-loss', removedLabelingRows);

  return {
    window: { from: opts.from, to: opts.to },
    orders: { count: headers.length, byStatus },
    receipts: {
      orders: receiptOrders.size,
      linesVerified: receiptLines.size,
      batches: receiptBatches,
      unitsStocked,
      receiptCostCents: metric({
        valueCents: receiptCostCents,
        contributingRows: pricedReceiptRows,
        definition:
          'The exact dollars booked with each stock-in batch (receiptCostCents), summed over ' +
          'the receipt events in this window. Frozen at the moment of stocking, so a later ' +
          'cost change never rewrites what a receipt cost.',
        coverage:
          `${pricedReceiptRows} of ${receiptBatches} receipt events whose changeTime falls in ` +
          `this window record a receipt cost; ${receiptBatches - pricedReceiptRows} record no ` +
          'figure at all (not a zero). ' +
          RECEIPTS_POPULATION_NOTE,
        kindRows: receiptBatches,
        emptyReason: 'no stock-in batch against a supply-order line was seen in this window',
        unpricedReason: (batches) =>
          `${batches} stock-in batches were stocked in this window; none records a receipt cost`,
      }),
      definition: RECEIPT_EVENT_DEFINITION,
    },
    metrics: {
      fees: metric({
        valueCents: feesCents,
        contributingRows: feeRows,
        definition:
          'Shipping and other fees charged on the order itself, summed over non-cancelled ' +
          'supply orders whose orderedAt falls in the window. Fees are separate from line ' +
          'costs and never bend the unit cost of a product (premise 1).',
        coverage:
          `${feeRows} of ${headers.length} non-cancelled supply orders ordered in this window ` +
          `record a fee amount; the rest carry no figure at all (not a zero). ${legacy}`,
        kindRows: headers.length,
        emptyReason: 'no non-cancelled supply order was ordered in this window',
        unpricedReason: (rows) =>
          `${rows} non-cancelled supply orders were ordered in this window; none records a fee amount`,
      }),
      supplierShortageCost: metric({
        valueCents: shortageCents,
        contributingRows: shortageRows,
        definition:
          'GROSS value of units ordered but never delivered, folded from the current ' +
          'recv-discrepancy subjects. Credits and reshipments are NOT subtracted — a ' +
          'shortage that was later settled still cost this much.',
        coverage:
          `${shortageRows} of ${discrepancyRows} recv-discrepancy rows whose lastSeenAt falls ` +
          'in this window carry a loss figure (open and resolved rows both count; rows raised ' +
          `before this lane carry no money fields). ${removedDiscrepancy} ${legacy}`,
        kindRows: discrepancyRows,
        emptyReason: emptyExceptionReason(
          'receiving-discrepancy',
          'recv-discrepancy',
          removedDiscrepancyRows,
        ),
        unpricedReason: unpricedExceptionReason(
          'recv-discrepancy',
          removedDiscrepancyRows,
          'loss',
        ),
      }),
      // The SAME population, the SAME priced rows, the SAME removed-line
      // exclusion as the gross above — the only difference is the subtraction,
      // which is why this metric's emptiness tracks the gross exactly.
      supplierShortageCostNet: metric({
        valueCents: shortageCents - settledCents,
        contributingRows: shortageRows,
        definition:
          'GROSS supplier shortage MINUS the loss of every recv-discrepancy row resolved ' +
          'supplier-credited or reshipped — what the shortages in this window have cost ' +
          "after the supplier made good. net is AS OF NOW (a settlement in September " +
          "changes August's net) — settlements do not move lastSeenAt.",
        coverage:
          `${shortageRows} of ${discrepancyRows} recv-discrepancy rows whose lastSeenAt falls ` +
          `in this window carry a loss figure, and ${settledRows} of those are settled ` +
          'supplier-credited or reshipped (their loss is subtracted here and NOT from the ' +
          `gross). ${removedDiscrepancy} ${legacy}`,
        kindRows: discrepancyRows,
        emptyReason: emptyExceptionReason(
          'receiving-discrepancy',
          'recv-discrepancy',
          removedDiscrepancyRows,
        ),
        unpricedReason: unpricedExceptionReason(
          'recv-discrepancy',
          removedDiscrepancyRows,
          'loss',
        ),
      }),
      labelingLossCost: metric({
        valueCents: lossCents,
        contributingRows: lossRows,
        definition:
          'Value of units verified at the dock and then lost before they became stock — ' +
          'the labeling bench — folded from the current labeling-loss subjects. Never a ' +
          'stock movement: these units were never stock.',
        coverage:
          `${lossRows} of ${labelingRows} labeling-loss rows whose lastSeenAt falls in this ` +
          'window carry a loss figure (each row is cumulative for its line; open and resolved ' +
          `rows both count). ${removedLabeling} ${legacy}`,
        kindRows: labelingRows,
        emptyReason: emptyExceptionReason('labeling-loss', 'labeling-loss', removedLabelingRows),
        unpricedReason: unpricedExceptionReason('labeling-loss', removedLabelingRows, 'loss'),
      }),
      surplusValue: metric({
        valueCents: surplusCents,
        contributingRows: surplusRows,
        definition:
          'Value of units delivered ABOVE what was ordered, folded from the current ' +
          'recv-discrepancy subjects. Priced at the unit cost of the line itself, whether ' +
          'the surplus was kept or returned.',
        coverage:
          `${surplusRows} of ${discrepancyRows} recv-discrepancy rows whose lastSeenAt falls ` +
          'in this window carry a surplus figure (open and resolved rows both count; rows ' +
          `raised before this lane carry no money fields). ${removedDiscrepancy} ${legacy}`,
        kindRows: discrepancyRows,
        emptyReason: emptyExceptionReason(
          'receiving-discrepancy',
          'recv-discrepancy',
          removedDiscrepancyRows,
        ),
        unpricedReason: unpricedExceptionReason(
          'recv-discrepancy',
          removedDiscrepancyRows,
          'surplus',
        ),
      }),
    },
  };
}
