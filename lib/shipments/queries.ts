import prisma from '@/lib/prisma';
import type { InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import {
  lineDiscrepancy,
  rollupDiscrepancies,
  type DiscrepancyRollup,
  type LineDiscrepancy,
} from '@/lib/shipments/rollup';

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
 * list at two queries regardless of page size.
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
  /** Linked + RECEIVED + never counted — the ONLY thing that blocks a close. */
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
 * List shipments (optionally filtered by status), newest first, each with its
 * linked-line counts and computed discrepancy rollup. Two queries: the headers,
 * then every line belonging to any of them.
 */
export async function listInboundShipments(
  status?: InboundShipmentStatus,
): Promise<ShipmentSummary[]> {
  const shipments = await prisma.inboundShipment.findMany({
    where: status ? { status } : {},
    include: shipmentInclude,
    orderBy: { createdAt: 'desc' },
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
    items: items.map((item) => ({
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
    })),
  };
}
