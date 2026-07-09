import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getSales, SalesGroupBy } from "@/lib/analytics/queries";
import { resolveCallerCompanyIds, serializeSalesRows } from "@/lib/analytics/company-scope";

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
  // Whitelist groupBy: an unknown value would map to by[undefined] in getSales and 500
  // inside prisma.groupBy({ by: undefined }). Default to "product" on missing/invalid.
  const rawGroupBy = sp.get("groupBy");
  const groupBy: SalesGroupBy =
    rawGroupBy && ["product", "day", "integration", "company"].includes(rawGroupBy)
      ? (rawGroupBy as SalesGroupBy)
      : "product";

  const companyIds = await resolveCallerCompanyIds(user, companyId);

  const rows = await getSales({ companyIds, productId, from, to, groupBy });

  // Serialize the Prisma Decimal revenue sum to a string per row so NextResponse.json
  // never emits a raw Decimal object. Other _sum fields are plain numbers.
  const series = serializeSalesRows(rows);

  return NextResponse.json({
    series,
    groupBy,
    mode: "historical",
    note: "revenue = direct (non-bundle) sales only; bundle units are included, bundle revenue is not represented",
  });
});
