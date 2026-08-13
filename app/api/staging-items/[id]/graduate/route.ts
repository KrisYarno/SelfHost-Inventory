import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import {
  GraduateSchema,
  assertGraduateOmitsCount,
  assertGraduateOverridePair,
} from '@/lib/validation/staging';
import { graduateStagingItem } from '@/lib/staging/graduate';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

// POST /api/staging-items/[id]/graduate - Resolve a box into real inventory.
// The 409 (already graduated/discarded, cancelled shipment), 422 (uncounted or
// zero-counted) and 400 (bad target) AppErrors thrown by graduateStagingItem
// propagate through apiHandler's mapping.
//
// W1-3a (pack REV-3 T2): the request names NO quantity. What gets booked is the
// staging row's count, read inside the graduation transaction; the only thing a
// caller may ask for is an explicitly-named, explicitly-reasoned override, which
// gets its own audit line.
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'staging-graduate:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  // The count-46-book-50 guard runs on the RAW body: Zod would strip a stray
  // countedQuantity silently, and a caller that believes it just booked its own
  // number deserves a 400, not a surprise.
  const raw = await request.json();
  assertGraduateOmitsCount(raw);
  const body = GraduateSchema.parse(raw);
  assertGraduateOverridePair(body);

  // Graduation is the flagship multi-event flow: one user action fans out into a
  // STAGING_GRADUATE event, a PRODUCT_CREATE event (only when a new product is
  // minted), and (later, via the stock-in path) an inventory event. ONE batchId
  // groups them; every recordChange runs INSIDE graduateStagingItem's atomic
  // transaction (via the onRecord callback), so the events and the mutations
  // commit or roll back together — a 409/400 records nothing.
  const batchId = newBatchId();

  const result = await graduateStagingItem(
    id,
    body,
    { id: user.id, isAdmin: user.isAdmin },
    {
      // Phase C (P-C1): the SAME batchId groups the STAGING_GRADUATE +
      // PRODUCT_CREATE events AND the STOCK_IN ledger row the helper writes.
      batchId,
      onRecord: async (tx, ctx) => {
        if (ctx.created) {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'PRODUCT_CREATE',
            entityType: 'PRODUCT',
            entityId: ctx.productId,
            action: `Created product ${ctx.productId} via graduation of staging item ${id}`,
            details: {
              source: 'staging-graduation',
              stagingItemId: id,
              approvalStatus: ctx.approvalStatus,
              locationId: ctx.locationId,
            },
            batchId,
          });
        }

        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: 'STAGING_GRADUATE',
          entityType: 'STAGING',
          entityId: id,
          action: `Graduated staging item ${id} into product ${ctx.productId}`,
          details: {
            productId: ctx.productId,
            approvalStatus: ctx.approvalStatus,
            locationId: ctx.locationId,
            // BOTH numbers ride every graduation line, so a reader never has to
            // assume the ledger booked what the dock counted.
            countedQuantity: ctx.countedQuantity,
            bookedQuantity: ctx.bookedQuantity,
          },
          batchId,
        });

        // The override gets its OWN line (pack REV-3 T2/T4). A graduation that
        // books a different number than the dock reported is a distinct,
        // separately-filterable act — folding it into the details of the normal
        // line would hide it in exactly the feed built to surface it.
        if (ctx.override) {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'GRADUATE_OVERRIDE',
            entityType: 'STAGING',
            entityId: id,
            action: `Graduated staging item ${id} booking ${ctx.bookedQuantity} against a counted ${ctx.countedQuantity}`,
            details: {
              productId: ctx.productId,
              locationId: ctx.locationId,
              countedQuantity: ctx.countedQuantity,
              bookedQuantity: ctx.bookedQuantity,
              overrideReason: ctx.override.reason,
            },
            batchId,
          });
        }
      },
    }
  );

  const response = NextResponse.json(result, { status: 200 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
