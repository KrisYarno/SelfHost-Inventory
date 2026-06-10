import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, apiHandler, requireCSRF } from '@/lib/api-utils';
import { declineProduct } from '@/lib/products/decline';
import { auditService } from '@/lib/audit';
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

  const result = await declineProduct(id, { id: user.id });

  await auditService.log({
    userId: user.id,
    actionType: 'PRODUCT_DECLINE',
    entityType: 'PRODUCT',
    entityId: id,
    action: `Declined product ${id}`,
    details: { reversed: result.reversed, alreadyDeclined: result.alreadyDeclined },
  });

  const response = NextResponse.json(result);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
