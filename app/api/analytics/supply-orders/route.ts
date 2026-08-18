import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import {
  SupplyOrdersAnalyticsQuerySchema,
  assertAnalyticsWindow,
} from '@/lib/validation/supply-orders';
import { getSupplyOrdersAnalytics } from '@/lib/analytics/supply-orders';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/supply-orders?from=&to= — the hub card's numbers (plan
 * P-10, spec §8).
 *
 * The house analytics idiom, followed deliberately (`app/api/analytics/
 * operations/route.ts` is the model): `apiHandler` + `requireApproved`, the
 * query parsed and asserted, the producer called, the payload returned. No CSRF,
 * no rate limiter, no audit and no side-effect registry entry — this is a read,
 * and everything that makes it truthful (the definition and coverage strings,
 * the null-vs-known-zero rule) lives in the producer where the numbers do.
 *
 * GLOBAL by construction, like the other analytics reads: supply orders belong
 * to the warehouse, not to a sales channel, so there is no company dimension to
 * scope by.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const params = request.nextUrl.searchParams;
  const query = SupplyOrdersAnalyticsQuerySchema.parse({
    from: params.get('from'),
    to: params.get('to'),
  });
  // Both ends must be real days and the window must run forwards — a shape-only
  // parse would happily accept 2026-02-30.
  assertAnalyticsWindow(query);

  const analytics = await getSupplyOrdersAnalytics(query);

  return NextResponse.json(analytics);
});
