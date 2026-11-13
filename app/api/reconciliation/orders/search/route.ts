import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, requireApproved } from '@/lib/api-utils';
import { resolveCallerCompanyIds } from '@/lib/analytics/company-scope';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';
import {
  NO_COMPANY_MEMBERSHIP_NOTE,
  NO_MEMBER_ORDER_NOTE,
  assertOrderSearchInput,
  searchOrders,
  type Viewer,
} from '@/lib/reconciliation/attribution';

export const dynamic = 'force-dynamic';

/**
 * A query-string number: absent or empty -> `undefined` (the default applies);
 * a run of ASCII digits -> that number; anything else -> `NaN`, which
 * `assertOrderSearchInput` refuses with the field's sentence. `+5`, `5.0`, `-1`
 * and `1e3` are not runs of digits.
 */
function wholeNumberParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  return /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
}

/**
 * GET /api/reconciliation/orders/search?q=&productId=&limit= — the order search
 * behind the Attribute… picker and the adjust dialog's order number field (pack
 * C2a.5; spec REV-7 §4.2; widened in Part 2, pack CB3b-ii.1 + § P2-B3-1, and
 * re-cut in § P2-B3-1R, R-a.1).
 *
 * `orderNumber` MATCHES ANYWHERE, ranked exact -> starts-with -> contains (the
 * producer's three group reads), at most `limit` rows (default and largest 20),
 * with `exactCount` (how many orders carry exactly this number) and an exact
 * `moreCount` so the caller can say how many it left off rather than implying
 * it showed everything. With `productId`, each row also says what its lines
 * show about that product (`thisProduct`).
 *
 * VALIDATION, IN THE PACK'S ORDER: the text is trimmed; an absent or blank `q`
 * returns nothing and asks the database nothing — not even the caller's
 * memberships, and nothing else is validated: an empty search is not a request
 * for every order. Then the text's length (at most 40), `productId` (a positive
 * whole number) and `limit` (1..20) — every refusal a 400 `VALIDATION_ERROR`
 * with its sentence, before the membership read.
 *
 * NOT ADMIN-ONLY since B3-1: an approved operator picks the order they are
 * removing stock for. An admin searches every order; anyone else searches the
 * orders of their OWN companies (`searchOrders` scopes all five statements).
 * Zero memberships is an empty answer, never a 403. A member's empty answer to
 * a real search carries the house sentence (`note`, pack row 94), because "none
 * in your companies" is not "none anywhere" — and a member of NO company is
 * told that instead (B3-1 FR1): "no match" would send them hunting for a number
 * no search of theirs can find. An admin's empty answer carries no note. These
 * are the first member-scoped routes under `app/api/reconciliation/`.
 *
 * Rate-limited per user (the house idiom), with the limiter's headers on the 200.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'reconciliation:orders-search', {
    identifier: user.id,
    limit: 60,
  });

  const params = request.nextUrl.searchParams;
  const q = (params.get('q') ?? '').trim();
  if (q === '') {
    return applyRateLimitHeaders(
      NextResponse.json({ orders: [], moreCount: 0, exactCount: 0 }),
      rateLimitHeaders
    );
  }
  const opts = assertOrderSearchInput(q, {
    productId: wholeNumberParam(params.get('productId')),
    limit: wholeNumberParam(params.get('limit')),
  });

  const viewer: Viewer = user.isAdmin
    ? { kind: 'admin' }
    : { kind: 'member', companyIds: await resolveCallerCompanyIds(user, null) };
  const result = await searchOrders(q, viewer, opts);

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
