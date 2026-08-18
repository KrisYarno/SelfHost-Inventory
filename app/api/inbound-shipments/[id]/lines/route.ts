import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import {
  AddArrivedLineSchema,
  LineInputSchema,
  assertProductCreateOmitsCostPrice,
  assertProductSizePair,
} from '@/lib/validation/supply-orders';
import { getSupplyOrderDetail, modelOf } from '@/lib/supply-orders/queries';
import { claimShipmentForVerify } from '@/lib/supply-orders/claims';
import { resolveSupplyOrderProduct } from '@/lib/supply-orders/product-resolve';
import { lineMoney } from '@/lib/supply-orders/money';
import { recvDiscrepancyKey } from '@/lib/exceptions/kinds';
import { upsertException } from '@/lib/exceptions/write';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

/**
 * POST /api/inbound-shipments/[id]/lines — ADD A LINE (spec §4.1.4 / §4.2.5).
 *
 * TWO acts behind one verb, and the HEADER'S STATUS chooses between them —
 * never the body, because a client that could pick would be able to record an
 * unordered arrival as if it had been ordered all along:
 *
 *   header ORDERED           an ORDERED LINE. Something else was ordered on this
 *                            purchase order before anything arrived.
 *   header RECEIVING|CLOSED  an UNORDERED ARRIVAL. Something turned up that was
 *                            never on the order (§4.2.5): the line is created
 *                            already VERIFIED, with `orderedQuantity` NULL —
 *                            the basis for its money is what actually arrived
 *                            (D4/PK-5) — and it raises `recv-discrepancy` with
 *                            the "unexpected arrival" NULL-expected subject.
 *
 * A SUBSTITUTION is NOT this route: the supplier sending the wrong thing is a
 * re-map of the ordered line through verify's `deliveredProduct`. This is only
 * for a product that was not on the order at all.
 *
 * THE FAN-OUT (PK2-10) commits under ONE batchId minted OUTSIDE the retry: the
 * `PRODUCT_CREATE` for a product the resolver minted, the `STAGING_CREATE` for
 * the line, and — for an unordered arrival — the exception row. This route is
 * therefore an EXCEPTION WRITER, allow-listed in
 * `__tests__/integration/exceptions-write-boundary.test.ts`.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'supply-order-lines:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;

  // WHICH BODY THIS IS depends on the header, so the header is read first. The
  // read decides only which SCHEMA to parse against; the atomic claim inside the
  // transaction is what makes the decision safe, and a status that moved in
  // between is a 409 rather than a line entered under the wrong rules.
  const header = await prisma.inboundShipment.findUnique({
    where: { id },
    select: { id: true, status: true, orderedAt: true },
  });
  if (!header) {
    throw new AppError('Inbound shipment not found', 'NOT_FOUND', 404);
  }
  if (modelOf(header) === 'legacy') {
    throw new AppError(
      `Inbound shipment ${id} is a legacy receipt (pre-staging history) and is read-only`,
      'LEGACY_READ_ONLY',
      409,
    );
  }
  const ordered = header.status === InboundShipmentStatus.ORDERED;
  const arrival =
    header.status === InboundShipmentStatus.RECEIVING ||
    header.status === InboundShipmentStatus.CLOSED;
  if (!ordered && !arrival) {
    throw new AppError(
      `Supply order ${id} is ${header.status.toLowerCase()} — no line can be added to it`,
      'CONFLICT',
      409,
    );
  }

  const raw = await request.json();
  assertProductCreateOmitsCostPrice(
    (raw as { product?: { productFields?: unknown } })?.product?.productFields,
  );

  const orderedLine = ordered ? LineInputSchema.parse(raw) : null;
  const arrivedLine = arrival ? AddArrivedLineSchema.parse(raw) : null;
  const selector = (orderedLine ?? arrivedLine)!.product;
  if (selector.mode === 'new') assertProductSizePair(selector.productFields);

  const actor = { id: user.id, isAdmin: user.isAdmin };
  const batchId = newBatchId();

  const lineId = await withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
      // The claim serializes this add against a concurrent close/cancel and
      // proves — under a locking read — that the header is not legacy history.
      const claimed = await claimShipmentForVerify(tx, id);
      if (claimed !== header.status) {
        throw new AppError(
          `Supply order ${id} moved to ${claimed.toLowerCase()} while the line was being added; reload and retry`,
          'CONFLICT',
          409,
        );
      }

      const product = await resolveSupplyOrderProduct(tx, selector, actor);
      const verifiedAt = new Date();

      const line = orderedLine
        ? await tx.stagingItem.create({
            data: {
              status: StagingItemStatus.ORDERED,
              description: product.productName,
              orderedProductId: product.productId,
              resolvedProductId: product.productId,
              orderedQuantity: orderedLine.orderedQuantity,
              lineTotalCents: orderedLine.lineTotalCents,
              labelingRequired: orderedLine.labelingRequired,
              notes: orderedLine.notes ?? null,
              shipmentId: id,
              receivedBy: null,
              receivedAt: null,
              locationId: null,
            },
          })
        : await tx.stagingItem.create({
            data: {
              // Already VERIFIED: the operator is holding the units as they type.
              status: StagingItemStatus.VERIFIED,
              description: product.productName,
              // NEVER an orderedQuantity and never an orderedProductId — the line
              // must stay unordered for every later query and analytic (PK-5).
              orderedProductId: null,
              resolvedProductId: product.productId,
              orderedQuantity: null,
              verifiedQuantity: arrivedLine!.verifiedQuantity,
              verifiedBy: user.id,
              verifiedAt,
              lineTotalCents: arrivedLine!.lineTotalCents ?? null,
              // The column default is TRUE (the bench is the normal path); the
              // schema leaves the field optional, so the default is restated here
              // rather than left to the driver.
              labelingRequired: arrivedLine!.labelingRequired ?? true,
              notes: arrivedLine!.note ?? null,
              shipmentId: id,
              receivedBy: null,
              receivedAt: null,
              locationId: null,
            },
          });

      if (product.created) {
        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: 'PRODUCT_CREATE',
          entityType: 'PRODUCT',
          entityId: product.productId,
          action: `Created product ${product.productName} while adding a line to supply order ${id}`,
          batchId,
          details: {
            productName: product.productName,
            approvalStatus: product.approvalStatus,
            shipmentId: id,
            lineId: line.id,
          },
        });
      }

      if (arrivedLine) {
        // The COMPLETE unordered subject (pack C3a.0). `expectedQty: null` is the
        // existing "unexpected arrival" rule; short/over/loss/surplus are all
        // ZERO because an unordered line's own arrival IS its basis — it can be
        // neither short nor over — and the unit cost is priced off the VERIFIED
        // count, NULL when the arrival carried no total (0 is not unknown).
        const money = lineMoney({
          lineTotalCents: arrivedLine.lineTotalCents ?? null,
          orderedQuantity: null,
          verifiedQuantity: arrivedLine.verifiedQuantity,
        });
        await upsertException(tx, {
          kind: 'recv-discrepancy',
          key: recvDiscrepancyKey(line.id),
          subject: {
            stagingItemId: line.id,
            shipmentId: id,
            productId: product.productId,
            orderedProductId: null,
            expectedQty: null,
            countedQty: arrivedLine.verifiedQuantity,
            orderedQuantity: null,
            verifiedQuantity: arrivedLine.verifiedQuantity,
            shortUnits: 0,
            overUnits: 0,
            lossCents: 0,
            surplusValueCents: 0,
            unitCostCents: money.unitCostCents,
            note: arrivedLine.note ?? null,
          },
          now: verifiedAt,
        });
      }

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: 'STAGING_CREATE',
        entityType: 'STAGING',
        entityId: line.id,
        action: arrivedLine
          ? `Recorded an unordered arrival on supply order ${id}`
          : `Added line ${line.id} to supply order ${id}`,
        batchId,
        details: arrivedLine
          ? {
              kind: 'unordered',
              shipmentId: id,
              productId: product.productId,
              productName: product.productName,
              verifiedQuantity: arrivedLine.verifiedQuantity,
              lineTotalCents: arrivedLine.lineTotalCents ?? null,
              labelingRequired: arrivedLine.labelingRequired ?? true,
              note: arrivedLine.note ?? null,
            }
          : {
              kind: 'ordered',
              shipmentId: id,
              productId: product.productId,
              productName: product.productName,
              orderedQuantity: orderedLine!.orderedQuantity,
              lineTotalCents: orderedLine!.lineTotalCents,
              labelingRequired: orderedLine!.labelingRequired,
            },
      });

      return line.id;
    }),
  );

  const detail = await getSupplyOrderDetail(id);
  const view =
    detail && detail.model === 'supply-order'
      ? (detail.lines.find((line) => line.id === lineId) ?? null)
      : null;

  const response = NextResponse.json(view, { status: 201 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
