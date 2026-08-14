import prisma from "@/lib/prisma";
import { requireCompanyMembership } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";

/**
 * Phase 0b-2 (spec REV-2 / OC-1 / G2-5): resolve a caller-supplied external
 * order id and prove the caller may reference it, BEFORE that id is written
 * anywhere.
 *
 * EXTRACTED at W2-1 (pack REV-11 T7) from app/api/inventory/deduct-simple/
 * route.ts, unchanged. It moved because the intent chip gives a SECOND surface
 * (the adjust route) the same job, and the moment two routes each grow their own
 * "prove the caller may reference this order", one of them is wrong. Behaviour
 * across the extraction is pinned twice over: this module's own unit suite, and
 * deduct-simple's untouched 0b-2 route pins in
 * __tests__/integration/api/change-tracking-ledger-semantics.test.ts.
 *
 * A client-supplied id is not evidence. Recording it unvalidated would
 * manufacture the exact false attribution this lane exists to remove — a forged
 * id would make another company's order look fulfilled out of our stock, and the
 * D1 reconciliation would read it as class-(c) evidence and believe it.
 *
 * BOTH failure modes — an id that resolves to nothing, and one that resolves to a
 * company the caller is not a member of — collapse into ONE 400 VALIDATION_ERROR.
 * Deliberate, and a departure from the fulfill route's 404s: there the order is
 * the addressed resource in the PATH, so "not found" is the honest answer. Here
 * it is an annotation on a body that WRITES STOCK, so the honest answer is "this
 * payload is not valid" — and one uniform outcome keeps the route from becoming
 * an order-id existence oracle for an approved user of another company. Never a
 * silent drop: an intent we cannot verify must fail the request, not ride along
 * as if it were true.
 *
 * The membership decision itself stays in `requireCompanyMembership` (the ONE
 * membership predicate — never re-implemented here); only its documented failure
 * signal is translated. A non-AppError (a DB fault) propagates untouched.
 *
 * NOT Next-free, and it cannot be: `requireCompanyMembership` lives in
 * @/lib/api-utils, which imports `next/server`. Re-implementing the predicate to
 * win a module-purity property would be exactly the duplication this extraction
 * exists to prevent, so the coupling stays and is stated instead.
 */
export async function resolveSelectedExternalOrderId(
  selectedExternalOrderId: string,
  user: { id: number; isAdmin: boolean }
): Promise<string> {
  const order = await prisma.externalOrder.findUnique({
    where: { id: selectedExternalOrderId },
    select: { companyId: true },
  });

  if (order) {
    try {
      await requireCompanyMembership(user.id, order.companyId, user.isAdmin);
      return selectedExternalOrderId;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }

  throw new AppError(
    "selectedExternalOrderId does not reference an order you can access",
    "VALIDATION_ERROR",
    400
  );
}
