import prisma from '@/lib/prisma';
import type { InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import {
  lineDiscrepancy,
  rollupDiscrepancies,
  type DiscrepancyRollup,
  type LineDiscrepancy,
} from '@/lib/shipments/rollup';
import { assertLegacyLine } from '@/lib/staging/legacy-line';

/**
 * Read helpers for the receiving header (contract pack REV-2 T4, W1-2a).
 *
 * The list and the detail hydrate the SAME header shape (`ShipmentSummary`) so
 * the receiving pages (W1-4b, seam S10) render one contract; the detail simply
 * adds `items`. Every quantity on the header is COMPUTED ON READ from the
 * linked staging rows — see lib/shipments/rollup.ts for the three rules.
 *
 * `shipmentId` is a SOFT ref (cross-aggregate, no FK, no Prisma relation — T1),
 * so the lines are fetched with an explicit second query rather than an
 * `include`. That is the deliberate cost of the soft-ref rule, and it keeps the
 * list at two queries regardless of page size — bounded by
 * `SHIPMENT_LIST_LIMIT`, so "regardless of page size" is now a promise about a
 * page rather than about the whole table (QA-6).
 */

const shipmentInclude = {
  creator: { select: { id: true, username: true } },
} as const;

/** The columns the rollup + the close guard read off each linked line. */
const lineSelect = {
  id: true,
  status: true,
  expectedQuantity: true,
  countedQuantity: true,
  shipmentId: true,
} as const;

export type ShipmentLine = {
  id: number;
  status: StagingItemStatus;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  shipmentId: string | null;
};

export type ShipmentSummary = {
  id: string;
  supplierRef: string | null;
  status: InboundShipmentStatus;
  notes: string | null;
  createdBy: number;
  closedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  creator: { id: number; username: string } | null;
  /** Linked staging lines, any status. */
  itemCount: number;
  receivedItemCount: number;
  graduatedItemCount: number;
  /**
   * Linked + RECEIVED + never counted — the ONLY thing that blocks a close.
   * Since QA-5 this equals `discrepancy.uncountedItemCount` BY CONSTRUCTION
   * (the rollup adopted the same scope); both are kept because the header field
   * is the close guard's number and the rollup field is the arithmetic's, and a
   * caller reading either must get the same answer.
   */
  uncountedReceivedItemCount: number;
  discrepancy: DiscrepancyRollup;
};

export type ShipmentDetailItem = {
  id: number;
  description: string;
  status: StagingItemStatus;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  unitCostCents: number | null;
  resolvedProductId: number | null;
  locationId: number;
  vendor: string | null;
  reference: string | null;
  notes: string | null;
  receivedAt: Date;
  countedAt: Date | null;
  countedBy: number | null;
  location: { id: number; name: string } | null;
  resolvedProduct: { id: number; name: string } | null;
  flags: LineDiscrepancy;
};

export type ShipmentDetail = ShipmentSummary & { items: ShipmentDetailItem[] };

type ShipmentRow = {
  id: string;
  supplierRef: string | null;
  status: InboundShipmentStatus;
  notes: string | null;
  createdBy: number;
  closedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  creator?: { id: number; username: string } | null;
};

/**
 * Fold a header row and its linked lines into the wire shape. Exported because
 * POST returns it for a brand-new (line-less) shipment, so create/list/detail
 * all speak one dialect.
 */
export function toShipmentSummary(
  row: ShipmentRow,
  lines: readonly Pick<ShipmentLine, 'status' | 'expectedQuantity' | 'countedQuantity'>[],
): ShipmentSummary {
  return {
    id: row.id,
    supplierRef: row.supplierRef,
    status: row.status,
    notes: row.notes,
    createdBy: row.createdBy,
    closedBy: row.closedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
    creator: row.creator ?? null,
    itemCount: lines.length,
    receivedItemCount: lines.filter((l) => l.status === 'RECEIVED').length,
    graduatedItemCount: lines.filter((l) => l.status === 'GRADUATED').length,
    uncountedReceivedItemCount: lines.filter(
      (l) => l.status === 'RECEIVED' && l.countedQuantity === null,
    ).length,
    discrepancy: rollupDiscrepancies(lines),
  };
}

/**
 * The most headers one list request will ever return (QA-6).
 *
 * The list was unbounded: `findMany` with no `take`, followed by a second query
 * with `shipmentId IN (every id it found)`. That is fine at five shipments and
 * an unpayable bill at five thousand — both queries and the JSON grow forever,
 * and receiving is precisely the surface that accumulates rows for years.
 *
 * A BOUND, not a cursor: the newest 100 headers are what a receiving screen is
 * for, and cursor pagination is registered for W3 if growth ever demands it
 * rather than invented here. The page is the newest-first slice the list already
 * renders, so nothing about what an operator sees changes today.
 */
export const SHIPMENT_LIST_LIMIT = 100;

/**
 * List shipments (optionally filtered by status), newest first, each with its
 * linked-line counts and computed discrepancy rollup. Two queries: the newest
 * page of headers, then every line belonging to THAT PAGE's shipments.
 */
export async function listInboundShipments(
  status?: InboundShipmentStatus,
): Promise<ShipmentSummary[]> {
  const shipments = await prisma.inboundShipment.findMany({
    where: status ? { status } : {},
    include: shipmentInclude,
    orderBy: { createdAt: 'desc' },
    take: SHIPMENT_LIST_LIMIT,
  });

  if (shipments.length === 0) return [];

  const lines = (await prisma.stagingItem.findMany({
    where: { shipmentId: { in: shipments.map((s) => s.id) } },
    select: lineSelect,
  })) as ShipmentLine[];

  const byShipment = new Map<string, ShipmentLine[]>();
  for (const line of lines) {
    if (line.shipmentId === null) continue;
    const bucket = byShipment.get(line.shipmentId);
    if (bucket) bucket.push(line);
    else byShipment.set(line.shipmentId, [line]);
  }

  return shipments.map((s) => toShipmentSummary(s, byShipment.get(s.id) ?? []));
}

/**
 * A single shipment with its linked staging lines, per-line discrepancy flags,
 * and the same header rollup the list carries. `null` when the id is unknown.
 */
export async function getInboundShipmentDetail(id: string): Promise<ShipmentDetail | null> {
  const shipment = await prisma.inboundShipment.findUnique({
    where: { id },
    include: shipmentInclude,
  });
  if (!shipment) return null;

  const items = await prisma.stagingItem.findMany({
    where: { shipmentId: id },
    include: {
      location: { select: { id: true, name: true } },
      resolvedProduct: { select: { id: true, name: true } },
    },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });

  return {
    ...toShipmentSummary(shipment, items),
    items: items.map((item) => {
      // The three receipt columns are NULL-widened on the table but non-null on
      // every legacy row, and this detail only ever reads legacy shipments
      // (P-7 / C1.5). Assert the data invariant instead of casting it away.
      assertLegacyLine(item);
      return {
        id: item.id,
        description: item.description,
        status: item.status,
        expectedQuantity: item.expectedQuantity,
        countedQuantity: item.countedQuantity,
        unitCostCents: item.unitCostCents,
        resolvedProductId: item.resolvedProductId,
        locationId: item.locationId,
        vendor: item.vendor,
        reference: item.reference,
        notes: item.notes,
        receivedAt: item.receivedAt,
        countedAt: item.countedAt,
        countedBy: item.countedBy,
        location: item.location ?? null,
        resolvedProduct: item.resolvedProduct ?? null,
        flags: lineDiscrepancy(item),
      };
    }),
  };
}
