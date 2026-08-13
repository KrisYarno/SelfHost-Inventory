import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { pendingWithStockKey } from '@/lib/exceptions/kinds';
import { resolveException } from '@/lib/exceptions/write';
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
//
// W1-3b (pack REV-3 T1 LIFECYCLE): approval is one of the two acts that make
// `pending-with-stock` false — the units on the shelf now belong to a real
// catalog entry. The resolution is written INSIDE this transaction so the
// register can never disagree with the catalog.
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

  // One instant for the review stamp and the resolution, so the register and the
  // product agree on WHEN this was settled.
  const reviewedAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.product.update({
      where: { id },
      data: {
        approvalStatus: 'APPROVED',
        reviewedBy: user.id,
        reviewedAt,
      },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: 'PRODUCT_APPROVE',
      entityType: 'PRODUCT',
      entityId: u.id,
      action: `Approved product ${u.id}`,
    });

    // Fired unconditionally: resolving a key nobody raised is a silent no-op, so
    // an admin-created product (which never raised a row) costs one read and
    // nothing else.
    await resolveException(tx, {
      key: pendingWithStockKey(id),
      resolvedBy: user.id,
      note: 'resolved: product approved',
      now: reviewedAt,
    });

    return u;
  });

  const response = NextResponse.json({
    id: updated.id,
    approvalStatus: updated.approvalStatus,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
