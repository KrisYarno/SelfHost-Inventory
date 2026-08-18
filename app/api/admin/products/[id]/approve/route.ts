import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { pendingWithStockKey } from '@/lib/exceptions/kinds';
import { resolveException } from '@/lib/exceptions/write';
import { recordChange } from '@/lib/change-tracking';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';
import { withDeadlockRetry } from '@/lib/inventory';

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
  // product agree on WHEN this was settled — minted OUTSIDE the retry below, so
  // a re-run stamps the instant of the REVIEW, not of the retry (the house rule:
  // the count route's countedAt, the graduation's batchId).
  const reviewedAt = new Date();

  // Receiving/Labeling overhaul (pack C2b.3, OCp2-4): the resolution below now
  // takes a LOCKING read on the register row, so this transaction can genuinely
  // deadlock — a booking that holds that exception row may be waiting on the
  // product row this approval holds. Decline has always retried (declineProduct
  // carries its own wrapper); approve had nothing, so the loser's answer to the
  // admin was a 500. A deadlock is a RETRY, not an answer.
  const updated = await withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
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
    })
  );

  const response = NextResponse.json({
    id: updated.id,
    approvalStatus: updated.approvalStatus,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
