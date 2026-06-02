import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, apiHandler } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { validateCSRFToken } from '@/lib/csrf';
import { auditService } from '@/lib/audit';
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

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
  }

  const updated = await prisma.product.update({
    where: { id },
    data: {
      approvalStatus: 'APPROVED',
      reviewedBy: user.id,
      reviewedAt: new Date(),
    },
  });

  await auditService.log({
    userId: user.id,
    actionType: 'PRODUCT_APPROVE',
    entityType: 'PRODUCT',
    entityId: updated.id,
    action: `Approved product ${updated.id}`,
  });

  const response = NextResponse.json({
    id: updated.id,
    approvalStatus: updated.approvalStatus,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
