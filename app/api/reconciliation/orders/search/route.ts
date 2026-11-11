import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, requireApproved } from '@/lib/api-utils';
import { resolveCallerCompanyIds } from '@/lib/analytics/company-scope';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';
import {
  NO_COMPANY_MEMBERSHIP_NOTE,
  NO_MEMBER_ORDER_NOTE,
  searchOrders,
  type Viewer,
} from '@/lib/reconciliation/attribution';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reconciliation/orders/search?q= — the order search behind the
 * Attribute… picker and the adjust dialog's order lookup (pack C2a.5; spec
 * REV-7 §4.2; widened in Part 2, pack CB3b-ii.1 + § P2-B3-1).
 *
 * `orderNumber` STARTS WITH what was typed, at most twenty rows, and an exact
 * `moreCount` so the caller can say how many it left off rather than implying
 * it showed everything. An absent or blank `q` returns nothing and asks the
 * database nothing — not even the caller's memberships: an empty search is not
 * a request for every order.
 *
 * NOT ADMIN-ONLY since B3-1: an approved operator picks the order they are
 * removing stock for. An admin searches every order; anyone else searches the
 * orders of their OWN companies (`searchOrders` scopes both the count and the
 * rows). Zero memberships is an empty answer, never a 403. A member's empty
 * answer to a real search carries the house sentence (`note`, pack row 94),
 * because "none in your companies" is not "none anywhere" — and a member of NO
 * company is told that instead (B3-1 FR1): "no match" would send them hunting
 * for a number no search of theirs can find. An admin's empty answer carries
 * no note. These are the first member-scoped routes under
 * `app/api/reconciliation/`.
 *
 * Rate-limited per user (the house idiom), with the limiter's headers on the 200.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'reconciliation:orders-search', {
    identifier: user.id,
    limit: 60,
  });

  const q = request.nextUrl.searchParams.get('q') ?? '';
  if (q.trim() === '') {
    return applyRateLimitHeaders(NextResponse.json({ orders: [], moreCount: 0 }), rateLimitHeaders);
  }

  const viewer: Viewer = user.isAdmin
    ? { kind: 'admin' }
    : { kind: 'member', companyIds: await resolveCallerCompanyIds(user, null) };
  const result = await searchOrders(q, viewer);

  // The zero-company member still goes through `searchOrders` (scoped to
  // nothing, so it answers empty); only the note names why.
  const body =
    viewer.kind === 'member' && result.orders.length === 0
      ? {
          ...result,
          note: viewer.companyIds.length === 0 ? NO_COMPANY_MEMBERSHIP_NOTE : NO_MEMBER_ORDER_NOTE,
        }
      : result;

  return applyRateLimitHeaders(NextResponse.json(body), rateLimitHeaders);
});
