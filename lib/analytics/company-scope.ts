import prisma from "@/lib/prisma";
import { requireCompanyMembership } from "@/lib/api-utils";
import { serializeSalesRows } from "@/lib/analytics/serialize";

// ER-D1: shared caller-company resolution + sales-row Decimal serialization for the
// analytics routes (/api/analytics/sales, product/[id], products), which had all
// duplicated this verbatim. Semantics are byte-identical to the prior inline code.
//
// Lane 4 (codex #4): serializeSalesRows now LIVES in lib/analytics/serialize.ts
// (Next-free) so the assistant tool layer + MCP sidecar can reuse it; it is
// re-exported here unchanged so existing route imports keep working.
export { serializeSalesRows };

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
