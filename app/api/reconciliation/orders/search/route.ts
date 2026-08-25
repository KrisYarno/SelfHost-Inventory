import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, requireAdmin } from '@/lib/api-utils';
import { searchOrders } from '@/lib/reconciliation/attribution';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reconciliation/orders/search?q= — the Attribute… picker's search
 * (pack C2a.5; spec REV-7 §4.2).
 *
 * `orderNumber` STARTS WITH what was typed, at most twenty rows, and an exact
 * `moreCount` so the picker can say how many it left off rather than implying it
 * showed everything. An absent or blank `q` returns nothing and asks the
 * database nothing — an empty search is not a request for every order.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const q = request.nextUrl.searchParams.get('q') ?? '';
  const result = await searchOrders(q, { kind: 'admin' });

  return NextResponse.json(result);
});
