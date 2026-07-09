import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { recordChange } from '@/lib/change-tracking';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

// POST /api/admin/products/[id]/approve - Approve a provisional product (Admin only).
// Flips approvalStatus to APPROVED and records the reviewer.
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, 'product-approve:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.product.update({
      where: { id },
      data: {
        approvalStatus: 'APPROVED',
        reviewedBy: user.id,
        reviewedAt: new Date(),
      },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: 'PRODUCT_APPROVE',
      entityType: 'PRODUCT',
      entityId: u.id,
      action: `Approved product ${u.id}`,
    });

    return u;
  });

  const response = NextResponse.json({
    id: updated.id,
    approvalStatus: updated.approvalStatus,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
