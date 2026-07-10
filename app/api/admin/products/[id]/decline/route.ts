import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, apiHandler, requireCSRF } from '@/lib/api-utils';
import { declineProduct } from '@/lib/products/decline';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

// POST /api/admin/products/[id]/decline - Decline a provisional product (Admin only).
// Reverses outstanding stock and soft-deletes the product. Idempotent: declining an
// already-declined product is a no-op (declineProduct returns { reversed: false }).
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, 'product-decline:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
  }

  // One batchId spans the whole decline flow so the audit event correlates with
  // the stock-reversal ledger rows declineProduct writes for this request.
  const batchId = newBatchId();

  // Phase C (DECLINE SEAM FIX / R-D2): record the PRODUCT_DECLINE event INSIDE
  // declineProduct's retried transaction (via the record callback) so the audit
  // row is atomic with the stock reversal. A failed audit write now hard-aborts
  // and rolls back the reversal instead of leaving it committed-but-unrecorded.
  const result = await declineProduct(id, { id: user.id }, {
    batchId,
    record: async (tx, ctx) => {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: 'PRODUCT_DECLINE',
        entityType: 'PRODUCT',
        entityId: id,
        action: `Declined product ${id}`,
        details: { reversed: ctx.reversed, alreadyDeclined: ctx.alreadyDeclined },
        batchId,
      });
    },
  });

  const response = NextResponse.json(result);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
