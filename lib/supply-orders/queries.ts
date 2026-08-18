import prisma from '@/lib/prisma';
import { Prisma, InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import {
  rollupDiscrepancies,
  supplyOrderLineDiscrepancy,
  type RollupModel,
  type SupplyOrderDiscrepancyRollup,
  type SupplyOrderLineDiscrepancy,
} from '@/lib/shipments/rollup';
import {
  toShipmentDetail,
  toShipmentSummary,
  shipmentDetailLineQuery,
  type ShipmentDetail,
  type ShipmentSummary,
} from '@/lib/shipments/queries';
import { lineMoney } from '@/lib/supply-orders/money';
import { labelingLossKey, recvDiscrepancyKey } from '@/lib/exceptions/kinds';
import { assertLegacyLine } from '@/lib/staging/legacy-line';

/**
 * THE ONE OWNER OF THE POLYMORPHIC READ SHAPE (plan P-8, contract pack C2c.3;
 * seams S16/S17).
 *
 * ONE dataset, TWO models. `inbound_shipments.orderedAt IS NULL` means a LEGACY
 * (W1) pre-staging receipt — history, read-only, and shaped exactly as it always
 * was; anything else is a SUPPLY ORDER in the new flow. Every read surface in
 * the lane comes through here so that discriminator is computed in exactly one
 * place and both shapes are declared side by side.
 *
 * THE LEGACY BRANCH IS NOT RE-IMPLEMENTED. It hands its rows to the EXPORTED
 * `toShipmentSummary` / `toShipmentDetail` mappers verbatim (S16). A second,
 * "compatible" implementation of a settled history shape is a silent rewrite of
 * the past — and the assert-at-mapping invariant those mappers carry (a legacy
 * row HAS a location, a receiver and a receipt time) is exactly the sort of rule
 * a copy loses.
 *
 * `shipmentId` IS A SOFT REFERENCE (no FK, no Prisma relation — T1), so nothing
 * here uses a header `include` for lines: every read is "the header, then its
 * lines", which is also what keeps the list at two queries regardless of page
 * size.
 *
 * READ-ONLY, and deliberately so: this module writes nothing, holds no locks and
 * takes no `tx`. The cores (`verify.ts`, `booking.ts`) own the writes, and the
 * ROUTES own the transactions.
 */

export type SupplyOrderModel = RollupModel;

/** The discriminator, in one place: `orderedAt IS NULL` is W1 history. */
export function modelOf(header: { orderedAt: Date | null }): SupplyOrderModel {
  return header.orderedAt === null ? 'legacy' : 'supply-order';
}

// ---------------------------------------------------------------------------
// Wire shapes (seam S17 — M3 routes, M4 UI and M5 hooks all read these)
// ---------------------------------------------------------------------------

export type SupplyOrderSummaryNewFlow = {
  model: 'supply-order';
  id: string;
  status: InboundShipmentStatus;
  supplier: string | null;
  supplierRef: string | null;
  /** Non-null BY the discriminator: this is what makes the order an order. */
  orderedAt: Date;
  feesCents: number | null;
  feesNote: string | null;
  createdBy: number;
  creator: { id: number; username: string } | null;
  closedBy: number | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  notes: string | null;
  lineCounts: {
    ordered: number;
    verified: number;
    labeling: number;
    complete: number;
    discarded: number;
  };
  units: { verified: number; stocked: number; disposed: number };
  discrepancy: SupplyOrderDiscrepancyRollup;
};

export type SupplyOrderSummary =
  | { model: 'legacy'; legacy: ShipmentSummary }
  | SupplyOrderSummaryNewFlow;

export type SupplyOrderLineView = {
  id: number;
  orderedProductId: number | null;
  /**
   * The ORDERED product's CURRENT name — NULL when nothing was ordered (an
   * unordered arrival). Deliberately not `productName`, which is the snapshot
   * of what ARRIVED: "ordered as X, re-mapped to Y" needs both halves named.
   */
  orderedProductName: string | null;
  /** The RESOLVED (delivered) product — what a batch actually books into. */
  productId: number | null;
  /** The `description` snapshot: the product's name at the last write. */
  productName: string;
  status: StagingItemStatus;
  orderedQuantity: number | null;
  verifiedQuantity: number | null;
  stockedQuantity: number;
  disposedQuantity: number;
  remaining: number;
  lineTotalCents: number | null;
  unitCostCents: number | null;
  /** "$1,250.00 / 100 ordered = $12.50/unit" — the derivation rides the number. */
  derivation: string | null;
  labelingRequired: boolean;
  locationId: number | null;
  verifiedAt: Date | null;
  verifiedBy: number | null;
  discrepancy: SupplyOrderLineDiscrepancy | null;
  /** The exception rows that EXIST for this line — the join aid, not a guess. */
  exceptionKeys: string[];
};

export type SupplyOrderExceptionView = {
  key: string;
  kind: string;
  subject: Prisma.JsonValue;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolvedBy: number | null;
  resolution: string | null;
  note: string | null;
  /** Parsed from the key — both kinds are keyed at the LINE grain. */
  lineId: number;
};

export type SupplyOrderDetail =
  | { model: 'legacy'; legacy: ShipmentDetail }
  | (SupplyOrderSummaryNewFlow & {
      lines: SupplyOrderLineView[];
      exceptions: SupplyOrderExceptionView[];
    });

/** Only the header columns the queue's SELECT carries — never a full rollup. */
export type LabelingQueueOrder = {
  id: string;
  status: InboundShipmentStatus;
  supplier: string | null;
  supplierRef: string | null;
  orderedAt: Date;
};

export type LegacyLineView = {
  id: number;
  description: string;
  status: StagingItemStatus;
  productId: number | null;
  productName: string | null;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  locationId: number;
  locationName: string | null;
  receivedAt: Date;
  receivedBy: number;
  /**
   * The receiver's username — NULL when the user row did not come back. PII
   * DISCIPLINE (S26): a user reaches this shape as `{ id, username }` and never
   * as a row, so the archive can name a person without carrying one.
   */
  receivedByName: string | null;
  shipmentId: string | null;
};

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The most headers one Orders-list request will ever return. A BOUND, not a
 * cursor — the same QA-6 reasoning the legacy list carries: receiving is the
 * surface that accumulates rows for years, and the newest page is what an
 * operator is looking at.
 */
export const SUPPLY_ORDER_LIST_LIMIT = 100;

/** The labeling queue's bound (spec §4.3.1), applied IN SQL after the filter. */
export const LABELING_QUEUE_LIMIT = 100;

/** The legacy-history list's bound — read-only archive, one page at a time. */
export const LEGACY_LINE_LIMIT = 200;

/** The statuses the Orders list shows when the caller names none. */
const DEFAULT_LIST_STATUSES: readonly InboundShipmentStatus[] = [
  InboundShipmentStatus.ORDERED,
  InboundShipmentStatus.RECEIVING,
];

// ---------------------------------------------------------------------------
// Rows as they come off Prisma
// ---------------------------------------------------------------------------

type HeaderRow = {
  id: string;
  supplierRef: string | null;
  supplier: string | null;
  status: InboundShipmentStatus;
  notes: string | null;
  createdBy: number;
  closedBy: number | null;
  orderedAt: Date | null;
  feesCents: number | null;
  feesNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  creator?: { id: number; username: string } | null;
};

type LineRow = {
  id: number;
  description: string;
  status: StagingItemStatus;
  shipmentId: string | null;
  orderedProductId: number | null;
  resolvedProductId: number | null;
  orderedQuantity: number | null;
  verifiedQuantity: number | null;
  stockedQuantity: number;
  disposedQuantity: number;
  lineTotalCents: number | null;
  labelingRequired: boolean;
  locationId: number | null;
  verifiedAt: Date | null;
  verifiedBy: number | null;
  /** The legacy columns the legacy mappers read off the same rows. */
  expectedQuantity: number | null;
  countedQuantity: number | null;
  /** The ordered product, as the DETAIL read's relation `select` returns it… */
  orderedProduct?: { name: string } | null;
  /** …and as the QUEUE's SQL returns the same name, flat off its LEFT JOIN. */
  orderedProductName?: string | null;
};

/** The columns both models' mappers read off a line. */
const lineSelect = {
  id: true,
  description: true,
  status: true,
  shipmentId: true,
  orderedProductId: true,
  resolvedProductId: true,
  orderedQuantity: true,
  verifiedQuantity: true,
  stockedQuantity: true,
  disposedQuantity: true,
  lineTotalCents: true,
  labelingRequired: true,
  locationId: true,
  verifiedAt: true,
  verifiedBy: true,
  expectedQuantity: true,
  countedQuantity: true,
} as const;

const headerInclude = { creator: { select: { id: true, username: true } } } as const;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Fold a supply-order header and ITS lines into the summary shape. */
function toSupplyOrderSummary(
  header: HeaderRow,
  lines: readonly LineRow[],
): SupplyOrderSummaryNewFlow {
  const lineCounts = {
    ordered: 0,
    verified: 0,
    labeling: 0,
    complete: 0,
    discarded: 0,
  };
  const units = { verified: 0, stocked: 0, disposed: 0 };

  for (const line of lines) {
    switch (line.status) {
      case StagingItemStatus.ORDERED:
        lineCounts.ordered += 1;
        break;
      case StagingItemStatus.VERIFIED:
        lineCounts.verified += 1;
        break;
      case StagingItemStatus.LABELING:
        lineCounts.labeling += 1;
        break;
      case StagingItemStatus.COMPLETE:
        lineCounts.complete += 1;
        break;
      case StagingItemStatus.DISCARDED:
        lineCounts.discarded += 1;
        break;
      default:
        // A legacy status on a supply order is not a thing the new flow writes;
        // censusing it under a new-flow name would invent a fact.
        break;
    }
    if (line.status === StagingItemStatus.DISCARDED) {
      // CENSUSED AND NOTHING ELSE (QA-1). A line removed from the order (spec
      // REV-10 clause 3) is settled work — a VERIFIED zero-counter line may
      // leave, and carrying its count into the header's units left the order
      // claiming units it no longer has any line for. Same scoping the legacy
      // half applies to its uncounted census (`lib/shipments/rollup.ts`).
      continue;
    }
    units.verified += line.verifiedQuantity ?? 0;
    units.stocked += line.stockedQuantity;
    units.disposed += line.disposedQuantity;
  }

  return {
    model: 'supply-order',
    id: header.id,
    status: header.status,
    supplier: header.supplier,
    supplierRef: header.supplierRef,
    // Non-null by the discriminator — the caller reached this branch BECAUSE
    // `orderedAt` is set.
    orderedAt: header.orderedAt as Date,
    feesCents: header.feesCents,
    feesNote: header.feesNote,
    createdBy: header.createdBy,
    creator: header.creator ?? null,
    closedBy: header.closedBy,
    closedAt: header.closedAt,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    notes: header.notes,
    lineCounts,
    units,
    discrepancy: rollupDiscrepancies(lines, { model: 'supply-order' }),
  };
}

/** One supply-order line, with its money and its discrepancy resolved. */
function toSupplyOrderLine(line: LineRow, exceptionKeys: string[] = []): SupplyOrderLineView {
  const money = lineMoney({
    lineTotalCents: line.lineTotalCents,
    orderedQuantity: line.orderedQuantity,
    verifiedQuantity: line.verifiedQuantity,
  });

  return {
    id: line.id,
    orderedProductId: line.orderedProductId,
    // ONE name, TWO shapes of the same join: the detail reads it through the
    // relation, the queue through its own SELECT alias.
    orderedProductName: line.orderedProduct?.name ?? line.orderedProductName ?? null,
    productId: line.resolvedProductId,
    productName: line.description,
    status: line.status,
    orderedQuantity: line.orderedQuantity,
    verifiedQuantity: line.verifiedQuantity,
    stockedQuantity: line.stockedQuantity,
    disposedQuantity: line.disposedQuantity,
    remaining: (line.verifiedQuantity ?? 0) - line.stockedQuantity - line.disposedQuantity,
    lineTotalCents: line.lineTotalCents,
    unitCostCents: money.unitCostCents,
    derivation: money.derivation,
    labelingRequired: line.labelingRequired,
    locationId: line.locationId,
    verifiedAt: line.verifiedAt,
    verifiedBy: line.verifiedBy,
    discrepancy: supplyOrderLineDiscrepancy(line),
    exceptionKeys,
  };
}

/** The line id both exception kinds encode after the colon. */
function lineIdFromKey(key: string): number {
  return Number(key.slice(key.indexOf(':') + 1));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The Orders list: a bounded page of headers, then ONE line query for THAT
 * PAGE's orders, folded in JS.
 *
 * Newest first by `orderedAt` (the business date an operator thinks in),
 * `createdAt` breaking ties — and a legacy header, which has no `orderedAt`,
 * therefore sorts by when it was entered, which is the only date it has.
 */
export async function listSupplyOrders(opts: {
  statuses?: InboundShipmentStatus[];
  model?: SupplyOrderModel;
  limit?: number;
}): Promise<SupplyOrderSummary[]> {
  const statuses = opts.statuses ?? [...DEFAULT_LIST_STATUSES];
  const where: Prisma.InboundShipmentWhereInput = { status: { in: statuses } };
  if (opts.model === 'legacy') where.orderedAt = null;
  if (opts.model === 'supply-order') where.orderedAt = { not: null };

  const headers = (await prisma.inboundShipment.findMany({
    where,
    include: headerInclude,
    orderBy: [{ orderedAt: 'desc' }, { createdAt: 'desc' }],
    take: opts.limit ?? SUPPLY_ORDER_LIST_LIMIT,
  })) as HeaderRow[];

  if (headers.length === 0) return [];

  const lines = (await prisma.stagingItem.findMany({
    where: { shipmentId: { in: headers.map((h) => h.id) } },
    select: lineSelect,
  })) as LineRow[];

  const byOrder = new Map<string, LineRow[]>();
  for (const line of lines) {
    if (line.shipmentId === null) continue;
    const bucket = byOrder.get(line.shipmentId);
    if (bucket) bucket.push(line);
    else byOrder.set(line.shipmentId, [line]);
  }

  return headers.map((header) => {
    const own = byOrder.get(header.id) ?? [];
    if (modelOf(header) === 'legacy') {
      return { model: 'legacy', legacy: toShipmentSummary(header, own) };
    }
    return toSupplyOrderSummary(header, own);
  });
}

/**
 * One order, whole. `null` when the id is unknown.
 *
 * The legacy branch reads its lines exactly as the legacy detail always did
 * (its includes and its ordering ARE part of that mapping) and hands them to the
 * exported mapper; the supply-order branch reads them by id and adds a THIRD
 * read for the exception rows, looked up by DETERMINISTIC KEY rather than by
 * scanning the register — `recv-discrepancy:<lineId>` and `labeling-loss:
 * <lineId>` are the only two keys an order's lines can own.
 */
export async function getSupplyOrderDetail(id: string): Promise<SupplyOrderDetail | null> {
  const header = (await prisma.inboundShipment.findUnique({
    where: { id },
    include: headerInclude,
  })) as HeaderRow | null;
  if (!header) return null;

  if (modelOf(header) === 'legacy') {
    const items = await prisma.stagingItem.findMany({
      where: { shipmentId: id },
      ...shipmentDetailLineQuery,
    });
    return { model: 'legacy', legacy: toShipmentDetail(header, items) };
  }

  const rows = (await prisma.stagingItem.findMany({
    where: { shipmentId: id },
    // The ordered product's NAME and nothing else: the "ordered as" line needs
    // one column, and a hydrating `true` would ship the whole catalogue row.
    include: { orderedProduct: { select: { name: true } } },
    orderBy: { id: 'asc' },
  })) as LineRow[];

  const keys = rows.flatMap((row) => [recvDiscrepancyKey(row.id), labelingLossKey(row.id)]);
  const exceptionRows =
    keys.length === 0
      ? []
      : await prisma.inventoryException.findMany({ where: { key: { in: keys } } });

  const keysByLine = new Map<number, string[]>();
  for (const row of exceptionRows) {
    const lineId = lineIdFromKey(row.key);
    const bucket = keysByLine.get(lineId);
    if (bucket) bucket.push(row.key);
    else keysByLine.set(lineId, [row.key]);
  }

  return {
    ...toSupplyOrderSummary(header, rows),
    lines: rows.map((row) => toSupplyOrderLine(row, keysByLine.get(row.id) ?? [])),
    exceptions: exceptionRows.map((row) => ({
      key: row.key,
      kind: row.kind,
      subject: row.subject,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      resolvedAt: row.resolvedAt,
      resolvedBy: row.resolvedBy,
      resolution: row.resolution,
      note: row.note,
      lineId: lineIdFromKey(row.key),
    })),
  };
}

/** The queue's SELECT row: the line's columns plus its header's, one join. */
type LabelingQueueRow = LineRow & {
  orderId: string;
  orderStatus: InboundShipmentStatus;
  supplier: string | null;
  supplierRef: string | null;
  orderedAt: Date;
};

/** MySQL `COUNT(*)` arrives as a BigInt; a count fits a Number by construction. */
function toCount(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * THE LABELING QUEUE (spec §4.3.1): every line with units still to stock,
 * oldest verify first, grouped by order.
 *
 * RAW SQL, and a BATCH READ TRANSACTION, both deliberately (PK2-5):
 *
 *   - the filter joins two tables and compares two of the line's own columns
 *     (`stocked + disposed < verified`), which Prisma's query API cannot
 *     express; and
 *   - the BOUND has to be applied in SQL, AFTER the filter. Reading everything
 *     and slicing in JS is the same query bill as no bound at all, and this is
 *     the surface that grows with every delivery for years.
 *
 * The COUNT and the SELECT are INDEPENDENT statements, so they go in as a
 * `$transaction([...])` batch: one round trip, one read view, and a "N more"
 * cue that cannot contradict the rows above it.
 */
export async function listLabelingQueue(opts: {
  orderId?: string;
  limit?: number;
}): Promise<{
  groups: { order: LabelingQueueOrder; lines: SupplyOrderLineView[] }[];
  count: number;
  moreCount: number;
}> {
  const limit = opts.limit ?? LABELING_QUEUE_LIMIT;
  // The three filters, spelled once so the COUNT and the SELECT can never
  // disagree about what "in the queue" means: a SUPPLY ORDER's line
  // (`orderedAt IS NOT NULL`), verified but not finished, with units left.
  const filters = Prisma.sql`h.orderedAt IS NOT NULL AND s.status IN ('VERIFIED', 'LABELING') AND s.stockedQuantity + s.disposedQuantity < s.verifiedQuantity`;
  const orderFilter = opts.orderId ? Prisma.sql`AND h.id = ${opts.orderId}` : Prisma.empty;

  const [countRows, rows] = await prisma.$transaction([
    prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT COUNT(*) AS count FROM staging_items s JOIN inbound_shipments h ON h.id = s.shipmentId WHERE ${filters} ${orderFilter}`,
    ),
    prisma.$queryRaw<LabelingQueueRow[]>(
      // The ordered product joins LEFT, and only on the SELECT: a line whose
      // ordered product row is gone is still work in the queue, and the COUNT
      // beside it must not pay for a name nobody counts.
      Prisma.sql`SELECT s.id, s.description, s.status, s.shipmentId, s.orderedProductId, s.resolvedProductId, s.orderedQuantity, s.verifiedQuantity, s.stockedQuantity, s.disposedQuantity, s.lineTotalCents, s.labelingRequired, s.locationId, s.verifiedAt, s.verifiedBy, s.expectedQuantity, s.countedQuantity, op.name AS orderedProductName, h.id AS orderId, h.status AS orderStatus, h.supplier, h.supplierRef, h.orderedAt FROM staging_items s JOIN inbound_shipments h ON h.id = s.shipmentId LEFT JOIN products op ON op.id = s.orderedProductId WHERE ${filters} ${orderFilter} ORDER BY s.verifiedAt ASC, s.id ASC LIMIT ${limit}`,
    ),
  ]);

  const count = toCount(countRows[0]?.count);

  const groups: { order: LabelingQueueOrder; lines: SupplyOrderLineView[] }[] = [];
  const byOrder = new Map<string, { order: LabelingQueueOrder; lines: SupplyOrderLineView[] }>();
  for (const row of rows) {
    let group = byOrder.get(row.orderId);
    if (!group) {
      group = {
        order: {
          id: row.orderId,
          status: row.orderStatus,
          supplier: row.supplier,
          supplierRef: row.supplierRef,
          orderedAt: row.orderedAt,
        },
        lines: [],
      };
      byOrder.set(row.orderId, group);
      // The SQL's ordering is the queue's ordering: groups appear in the order
      // their OLDEST line does, so "work the top of the list" stays true.
      groups.push(group);
    }
    // No exception join here: the queue is a work list, and `exceptionKeys` is
    // the order DETAIL's join aid. An empty array says "this read did not ask",
    // which is the truthful answer.
    group.lines.push(toSupplyOrderLine(row));
  }

  return { groups, count, moreCount: Math.max(count - limit, 0) };
}

/**
 * The legacy (pre-staging) history list — read-only, for the archive page.
 *
 * Returns `{ lines, count, moreCount }`: the newest `limit` rows PLUS how many
 * older ones the bound left off, so the archive can say so out loud.
 *
 * `receivedAt IS NOT NULL` is the DURABLE discriminator: it is a column on the
 * LINE, so an orphan legacy row whose `shipmentId` was never set (or was
 * unlinked) is still history rather than disappearing from its own archive. The
 * status filter alone would not do it — GRADUATED and DISCARDED are legacy-only
 * today, but the rule that keeps them legacy-only is exactly this column.
 */
export async function listLegacyLines(opts: { limit?: number }): Promise<{
  lines: LegacyLineView[];
  count: number;
  moreCount: number;
}> {
  const limit = opts.limit ?? LEGACY_LINE_LIMIT;
  // ONE filter object, so the COUNT and the SELECT can never disagree about
  // what "legacy history" means, and ONE batch transaction so the "N older
  // lines not shown" cue is read from the same view as the rows above it (the
  // queue's idiom, PK2-5 / REV-10 clause 6). Without the count the archive
  // truncated at the bound in silence, which reads as "this is all of it".
  const where = {
    status: { in: [StagingItemStatus.GRADUATED, StagingItemStatus.DISCARDED] },
    receivedAt: { not: null },
  };

  const [count, rows] = await prisma.$transaction([
    prisma.stagingItem.count({ where }),
    prisma.stagingItem.findMany({
      where,
      include: {
        location: { select: { id: true, name: true } },
        resolvedProduct: { select: { id: true, name: true } },
        receivedByUser: { select: { id: true, username: true } },
      },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    }),
  ]);

  const lines = rows.map((row) => {
    // The three receipt columns are NULL-widened on the table but non-null on
    // every legacy row (P-7 / C1.5). Assert the data invariant rather than
    // casting it away: a new-flow line reaching this mapper is a 500 naming the
    // invariant, never a silently-null location rendered as one.
    assertLegacyLine(row);
    return {
      id: row.id,
      description: row.description,
      status: row.status,
      productId: row.resolvedProductId,
      productName: row.resolvedProduct?.name ?? null,
      expectedQuantity: row.expectedQuantity,
      countedQuantity: row.countedQuantity,
      locationId: row.locationId,
      locationName: row.location?.name ?? null,
      receivedAt: row.receivedAt,
      receivedBy: row.receivedBy,
      receivedByName: row.receivedByUser?.username ?? null,
      shipmentId: row.shipmentId,
    };
  });

  return { lines, count, moreCount: Math.max(count - limit, 0) };
}
