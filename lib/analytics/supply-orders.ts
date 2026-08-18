import prisma from '@/lib/prisma';
import { InboundShipmentStatus } from '@prisma/client';

/**
 * SUPPLY-ORDER ANALYTICS (spec §8, contract pack C3b/PK2-13, seam S18).
 *
 * Four numbers for the analytics hub's "Supply orders" card: what the fees cost,
 * what suppliers failed to deliver, what the labeling bench lost, and what
 * arrived above the order. Next-free (the route is the Next half) and read-only.
 *
 * THE TRUTHFUL-DATA RULE, which decides every field here: `valueCents` is NULL
 * **only** when nothing contributed — `contributingRows === 0` — and then it
 * carries a `reason` naming what was missing. Rows that contribute a known ZERO
 * produce `0`. "Nobody lost anything this month" and "we cannot say what was
 * lost" are different answers, and a card that renders both as $0.00 tells the
 * reader the second is the first.
 *
 * TWO POPULATIONS, deliberately not mixed:
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
  metrics: {
    fees: SupplyOrderAnalyticsMetric;
    supplierShortageCost: SupplyOrderAnalyticsMetric;
    labelingLossCost: SupplyOrderAnalyticsMetric;
    surplusValue: SupplyOrderAnalyticsMetric;
  };
};

/** The two register kinds this lane's money lives in. */
const MONEY_KINDS = ['recv-discrepancy', 'labeling-loss'] as const;

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

/** Assemble one metric from a fold, applying the null-only-when-empty rule. */
function metric(args: {
  valueCents: number;
  contributingRows: number;
  definition: string;
  coverage: string;
  reason: string;
}): SupplyOrderAnalyticsMetric {
  const empty = args.contributingRows === 0;
  return {
    valueCents: empty ? null : args.valueCents,
    definition: args.definition,
    coverage: args.coverage,
    contributingRows: args.contributingRows,
    reason: empty ? args.reason : null,
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
 * The window's supply-order money, with every number's basis stated.
 */
export async function getSupplyOrdersAnalytics(opts: {
  from: string;
  to: string;
}): Promise<SupplyOrdersAnalytics> {
  const { start, end } = windowBounds(opts.from, opts.to);

  const [headers, legacyHeaders, exceptions] = await Promise.all([
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
      select: { kind: true, subject: true },
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

  // --- the register metrics ----------------------------------------------

  let shortageCents = 0;
  let shortageRows = 0;
  let lossCents = 0;
  let lossRows = 0;
  let surplusCents = 0;
  let surplusRows = 0;
  let discrepancyRows = 0;
  let labelingRows = 0;

  for (const row of exceptions) {
    const subject = subjectObject(row.subject);
    if (row.kind === 'recv-discrepancy') {
      discrepancyRows += 1;
      const short = centsOf(subject, 'lossCents');
      if (short !== null) {
        shortageCents += short;
        shortageRows += 1;
      }
      const surplus = centsOf(subject, 'surplusValueCents');
      if (surplus !== null) {
        surplusCents += surplus;
        surplusRows += 1;
      }
    } else {
      labelingRows += 1;
      const lost = centsOf(subject, 'lossCents');
      if (lost !== null) {
        lossCents += lost;
        lossRows += 1;
      }
    }
  }

  const legacy = legacyNote(legacyHeaders);

  return {
    window: { from: opts.from, to: opts.to },
    orders: { count: headers.length, byStatus },
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
        reason: 'no non-cancelled supply order in this window records a fee amount',
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
          `before this lane carry no money fields). ${legacy}`,
        reason: 'no receiving-discrepancy row was seen in this window',
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
          `rows both count). ${legacy}`,
        reason: 'no labeling-loss row was seen in this window',
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
          `raised before this lane carry no money fields). ${legacy}`,
        reason: 'no receiving-discrepancy row was seen in this window',
      }),
    },
  };
}
