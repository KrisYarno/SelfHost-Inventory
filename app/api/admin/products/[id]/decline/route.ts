import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
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

  // One batchId spans the whole decline flow so the audit row correlates with the
  // stock-reversal ledger rows declineProduct writes for this request.
  const batchId = newBatchId();

  const result = await declineProduct(id, { id: user.id });

  // declineProduct owns its own (concurrency-hardened, retried) transaction, so the
  // audit row is recorded in its own tx here — recordChange still hard-aborts (a
  // failed audit write throws) rather than the legacy fire-and-forget swallow.
  // SEAM: making the audit atomic with the reversal would need a record-callback
  // seam inside lib/products/decline.ts (out of this task's file scope).
  await prisma.$transaction(async (tx) => {
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: 'PRODUCT_DECLINE',
      entityType: 'PRODUCT',
      entityId: id,
      action: `Declined product ${id}`,
      details: { reversed: result.reversed, alreadyDeclined: result.alreadyDeclined },
      batchId,
    });
  });

  const response = NextResponse.json(result);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
