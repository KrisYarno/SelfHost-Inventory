import type { InboundShipmentStatus, Prisma, StagingItemStatus } from '@prisma/client';
import {
  lineDiscrepancy,
  rollupDiscrepancies,
  type DiscrepancyRollup,
  type LineDiscrepancy,
} from '@/lib/shipments/rollup';
import { assertLegacyLine } from '@/lib/staging/legacy-line';

/**
 * The LEGACY (W1) receiving shape and its PURE mappers (contract pack REV-2 T4,
 * W1-2a; trimmed by the Receiving/Labeling overhaul's M6).
 *
 * The runtime entry points that used to live here — `listInboundShipments` and
 * `getInboundShipmentDetail` — are gone, and with them this module's Prisma
 * singleton: `lib/supply-orders/queries.ts` is now THE ONE owner of every
 * receiving read (seams S16/S17), and it renders a legacy header by handing its
 * rows to the mappers below. What survives is therefore SHAPE, not I/O — the
 * types, the two folds, the line read the legacy detail issues, and the page
 * bound the polymorphic list must agree with.
 *
 * Every quantity on the header is still COMPUTED ON READ from the linked
 * staging rows — see lib/shipments/rollup.ts for the three rules. `shipmentId`
 * remains a SOFT ref (cross-aggregate, no FK, no Prisma relation — T1), which
 * is why the lines arrive as a separate argument rather than an `include`.
 */

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
 * A BOUND, not a cursor: the newest 100 headers are what a receiving screen is
 * for, and cursor pagination is registered for W3 if growth ever demands it
 * rather than invented here.
 *
 * RETAINED after M6 deleted the legacy list it used to bound, because the
 * polymorphic list reads the SAME table: `SUPPLY_ORDER_LIST_LIMIT` is pinned
 * equal to this number, so one dataset cannot end up with two page sizes.
 */
export const SHIPMENT_LIST_LIMIT = 100;

/** The line columns the legacy DETAIL mapper reads (Prisma rows satisfy it). */
export type ShipmentDetailRow = {
  id: number;
  description: string;
  status: StagingItemStatus;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  unitCostCents: number | null;
  resolvedProductId: number | null;
  locationId: number | null;
  vendor: string | null;
  reference: string | null;
  notes: string | null;
  receivedAt: Date | null;
  receivedBy: number | null;
  countedAt: Date | null;
  countedBy: number | null;
  location?: { id: number; name: string } | null;
  resolvedProduct?: { id: number; name: string } | null;
};

/** The line read the legacy detail issues — its shape IS part of the mapping. */
export const shipmentDetailLineQuery = {
  include: {
    location: { select: { id: true, name: true } },
    resolvedProduct: { select: { id: true, name: true } },
  },
  orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
} satisfies Omit<Prisma.StagingItemFindManyArgs, 'where'>;

/**
 * Fold a header row and its linked lines into the DETAIL wire shape.
 *
 * EXPORTED for the Receiving/Labeling overhaul (seam S16): the polymorphic
 * detail in `lib/supply-orders/queries.ts` renders a LEGACY header by handing
 * its rows straight to this mapper, so legacy history keeps today's shape
 * verbatim instead of acquiring a second, subtly-different implementation.
 */
export function toShipmentDetail(
  row: ShipmentRow,
  items: readonly ShipmentDetailRow[],
): ShipmentDetail {
  return {
    ...toShipmentSummary(row, items),
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
