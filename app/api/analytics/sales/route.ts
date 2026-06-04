import { NextRequest, NextResponse } from "next/server";
import { requireApproved, requireCompanyMembership, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { getSales, SalesGroupBy } from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// Company-scoped sales read from the materialized ProductSalesFact (F3).
// Multi-company is first-class:
//   - no companyId  => sum across ALL the caller's OWN companies ("ownership" view)
//   - explicit companyId => requireCompanyMembership (admins bypass; 404 on non-member,
//     anti-enumeration), then scope to that one company
//   - caller with zero companies => empty series (never an error, never a leak)
// Hard cross-company isolation: a non-member NEVER reaches the data layer.
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const sp = request.nextUrl.searchParams;
  const companyId = sp.get("companyId");
  const productId = sp.get("productId") ? parseInt(sp.get("productId")!, 10) : undefined;
  const from = sp.get("from") ?? undefined;
  const to = sp.get("to") ?? undefined;
  const groupBy = (sp.get("groupBy") as SalesGroupBy | null) ?? undefined;

  let companyIds: string[];
  if (companyId) {
    // Throws AppError 404 on non-member (admins bypass inside). apiHandler maps it.
    await requireCompanyMembership(user.id, companyId, user.isAdmin);
    companyIds = [companyId];
  } else {
    // Ownership view: scope to the caller's OWN memberships, never all companies.
    const memberships = await prisma.userCompany.findMany({
      where: { userId: user.id },
      select: { companyId: true },
    });
    companyIds = memberships.map((m: { companyId: string }) => m.companyId);
  }

  const rows = await getSales({ companyIds, productId, from, to, groupBy });

  // Serialize the Prisma Decimal revenue sum to a string per row so NextResponse.json
  // never emits a raw Decimal object. Other _sum fields are plain numbers.
  const series = rows.map((row) => {
    const sum = (row as { _sum?: { revenue?: unknown } })._sum;
    if (sum && sum.revenue != null) {
      return { ...row, _sum: { ...sum, revenue: sum.revenue.toString() } };
    }
    return row;
  });

  return NextResponse.json({
    series,
    groupBy: groupBy ?? "product",
    mode: "historical",
    note: "revenue = direct (non-bundle) sales only; bundle units are included, bundle revenue is not represented",
  });
});
