import prisma from "@/lib/prisma";
import { requireCompanyMembership } from "@/lib/api-utils";

// ER-D1: shared caller-company resolution + sales-row Decimal serialization for the
// analytics routes (/api/analytics/sales, product/[id], products), which had all
// duplicated this verbatim. Semantics are byte-identical to the prior inline code.

/**
 * Resolve the set of companyIds a request is scoped to.
 *   - explicit companyId => requireCompanyMembership (admins bypass inside; throws
 *     AppError 404 on non-member — anti-enumeration), then scope to that one company.
 *   - no companyId => the caller's OWN memberships (ER-D3 memberships-only rule);
 *     zero memberships => [] (getSales treats [] as hard isolation -> empty series).
 *
 * A non-member NEVER reaches the data layer (the membership check throws first).
 */
export async function resolveCallerCompanyIds(
  user: { id: number; isAdmin: boolean },
  companyId: string | null
): Promise<string[]> {
  if (companyId) {
    // Throws AppError 404 on non-member (admins bypass inside). apiHandler maps it.
    await requireCompanyMembership(user.id, companyId, user.isAdmin);
    return [companyId];
  }
  // Ownership view: scope to the caller's OWN memberships, never all companies.
  const memberships = await prisma.userCompany.findMany({
    where: { userId: user.id },
    select: { companyId: true },
  });
  return memberships.map((m: { companyId: string }) => m.companyId);
}

/**
 * Serialize the Prisma Decimal `revenue` sum on each sales-groupBy row to a string,
 * leaving every other field untouched, so NextResponse.json never emits a raw
 * Decimal object. Rows without a revenue sum pass through unchanged.
 */
export function serializeSalesRows<T extends object>(rows: T[]): T[] {
  return rows.map((row) => {
    const sum = (row as { _sum?: { revenue?: unknown } })._sum;
    if (sum && sum.revenue != null) {
      return {
        ...row,
        _sum: { ...sum, revenue: (sum.revenue as { toString(): string }).toString() },
      } as T;
    }
    return row;
  });
}
