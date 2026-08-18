import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import {
  CreateSupplyOrderSchema,
  assertProductCreateOmitsCostPrice,
  assertProductSizePair,
  assertRealCalendarDate,
} from '@/lib/validation/supply-orders';
import {
  getSupplyOrderDetail,
  listSupplyOrders,
  type SupplyOrderModel,
} from '@/lib/supply-orders/queries';
import { resolveSupplyOrderProduct } from '@/lib/supply-orders/product-resolve';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * The list filter, widened for the overhaul (spec §5.1): the five header
 * statuses, MULTI-select, plus the model discriminator.
 *
 * Reader-tolerant validation is deliberately NOT wanted (Lane 3 R-L7): a typo'd
 * status must be a clean 400 rather than a silent "everything". The statuses
 * live in one enum with the legacy three, because the list is ONE endpoint over
 * ONE dataset — `?model=` is what separates the two families, never the status.
 */
const StatusFilterSchema = z.enum([
  InboundShipmentStatus.OPEN,
  InboundShipmentStatus.CLOSED,
  InboundShipmentStatus.CANCELLED,
  InboundShipmentStatus.ORDERED,
  InboundShipmentStatus.RECEIVING,
]);

const ModelFilterSchema = z.enum(['legacy', 'supply-order']);

/** `?status=ORDERED,RECEIVING`; absent (or empty) leaves the default set. */
function parseStatusFilter(raw: string | null): InboundShipmentStatus[] | undefined {
  if (raw === null || raw === '') return undefined;
  return raw.split(',').map((value) => StatusFilterSchema.parse(value.trim()));
}

function parseModelFilter(raw: string | null): SupplyOrderModel | undefined {
  if (raw === null || raw === '') return undefined;
  return ModelFilterSchema.parse(raw);
}

// GET /api/inbound-shipments?status=a,b&model= — THE POLYMORPHIC ORDERS LIST.
//
// One shape per header, discriminated by `model` (`orderedAt IS NULL` is a
// legacy W1 receipt, rendered exactly as it always was). Every quantity is
// computed on read from the lines (T4) — there is no stored rollup to go stale.
export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const params = request.nextUrl.searchParams;
  const statuses = parseStatusFilter(params.get('status'));
  const model = parseModelFilter(params.get('model'));

  const shipments = await listSupplyOrders({ statuses, model });

  return NextResponse.json({ shipments });
});

/**
 * POST /api/inbound-shipments — ENTER A SUPPLY ORDER (spec §4.1, pack C3a.0).
 *
 * The W1 header-only create is gone: an order is a supplier, a date and the
 * lines that were ordered, so `lines` is required (1..50) and a body without
 * them is a 400 rather than an empty header nobody can act on.
 *
 * ONE TRANSACTION covers all of it — the products a "create new" line minted,
 * the header, every line, and every audit row — under ONE batchId minted
 * OUTSIDE the retry, so a re-run after a deadlock stays one batch in the change
 * feed rather than two half-batches.
 *
 * The APPROVAL GATE is not this route's to interpret: `resolveSupplyOrderProduct`
 * (S10) is the one place that decides which products a line may point at and
 * how a new one is created, and its refusals travel out as their own 400s.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'inbound-shipments:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const raw = await request.json();

  // RAW-BODY assertion, before the parse: Zod strips unknown keys, so a
  // `costPrice` smuggled onto a new product would vanish silently and the client
  // would believe the cost it sent was stored (premise 1 / D10).
  const rawLines = (raw as { lines?: unknown })?.lines;
  if (Array.isArray(rawLines)) {
    for (const line of rawLines) {
      assertProductCreateOmitsCostPrice((line as { product?: { productFields?: unknown } })
        ?.product?.productFields);
    }
  }

  const body = CreateSupplyOrderSchema.parse(raw);
  assertRealCalendarDate(body.orderedAt, 'orderedAt');
  for (const line of body.lines) {
    if (line.product.mode === 'new') assertProductSizePair(line.product.productFields);
  }

  // The ordered date is a CALENDAR DAY the operator typed; the column stores its
  // UTC midnight so every reader sees the same day regardless of server zone.
  const orderedAt = new Date(`${body.orderedAt}T00:00:00.000Z`);

  const actor = { id: user.id, isAdmin: user.isAdmin };
  const batchId = newBatchId();

  const orderId = await withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
      // Resolve EVERY line's product first: a refusal (the approval gate, a
      // duplicate, an unknown location) must land before anything is written.
      const resolved = [];
      for (const line of body.lines) {
        resolved.push(await resolveSupplyOrderProduct(tx, line.product, actor));
      }

      const header = await tx.inboundShipment.create({
        data: {
          status: InboundShipmentStatus.ORDERED,
          orderedAt,
          supplier: body.supplier ?? null,
          supplierRef: body.supplierRef ?? null,
          notes: body.notes ?? null,
          feesCents: body.feesCents,
          feesNote: body.feesNote ?? null,
          createdBy: user.id,
        },
      });

      const lineIds: number[] = [];
      for (let index = 0; index < body.lines.length; index += 1) {
        const line = body.lines[index];
        const product = resolved[index];
        const created = await tx.stagingItem.create({
          data: {
            status: StagingItemStatus.ORDERED,
            // The product's name AT SAVE TIME. A rename later must not rewrite
            // what this order said it bought.
            description: product.productName,
            orderedProductId: product.productId,
            resolvedProductId: product.productId,
            orderedQuantity: line.orderedQuantity,
            lineTotalCents: line.lineTotalCents,
            labelingRequired: line.labelingRequired,
            notes: line.notes ?? null,
            shipmentId: header.id,
            // The receipt columns belong to the legacy flow; the new flow stamps
            // verifiedBy/At when the delivery is counted and picks a location per
            // labeled batch.
            receivedBy: null,
            receivedAt: null,
            locationId: null,
          },
        });
        lineIds.push(created.id);
      }

      for (let index = 0; index < resolved.length; index += 1) {
        const product = resolved[index];
        if (!product.created) continue;
        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: 'PRODUCT_CREATE',
          entityType: 'PRODUCT',
          entityId: product.productId,
          action: `Created product ${product.productName} while entering supply order ${header.id}`,
          batchId,
          details: {
            productName: product.productName,
            approvalStatus: product.approvalStatus,
            shipmentId: header.id,
            lineId: lineIds[index],
          },
        });
      }

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: 'SHIPMENT_CREATE',
        entityType: 'SHIPMENT',
        entityId: header.id,
        action: `Entered supply order ${header.id}`,
        batchId,
        details: {
          supplier: header.supplier,
          supplierRef: header.supplierRef,
          orderedAt,
          feesCents: header.feesCents,
          lineCount: body.lines.length,
          orderedUnits: body.lines.reduce((sum, line) => sum + line.orderedQuantity, 0),
          lineTotalCents: body.lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
          lineIds,
          productsCreated: resolved.filter((p) => p.created).map((p) => p.productId),
        },
      });

      return header.id;
    },
    // THE BUDGET (spec REV-10 clause 9). Up to 50 lines, each resolving (or
    // creating) a product before the header exists: Prisma's 5s default is a
    // realistic loss for an order somebody typed by hand. 20s to finish, 5s to
    // get a connection.
    { timeout: 20_000, maxWait: 5_000 },
    ),
  );

  // The SAME shape GET serves, so a creating client never has to reconcile two
  // dialects (and reads the order back with its lines already folded in).
  const detail = await getSupplyOrderDetail(orderId);
  const response = NextResponse.json(detail, { status: 201 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
