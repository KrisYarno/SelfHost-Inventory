import { NextRequest, NextResponse } from "next/server";
import { requireApproved, requireCompanyMembership, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { getStockSeries, getSales } from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// Unified per-product analytics for one internal product:
//   - stock => GLOBAL inventory (never company-scoped; a no-companies caller still sees it).
//   - sales => the caller's OWN companies only ("ownership" view), or one explicit company.
//     A caller with zero companies gets GLOBAL stock but an empty sales series (no leak).
//
// Query params (all optional; omitting them preserves the historical default):
//   - from / to  => date-bound BOTH the GLOBAL stock series and the sales rows.
//   - companyId  => explicit company: requireCompanyMembership (admins bypass; 404 on
//     non-member, anti-enumeration), then scope sales to that one company. Omit => sum the
//     caller's OWN memberships (default; zero memberships => getSales returns []).
//
// TODO(reports-rework): share caller-company resolution + sales-row serialization with
// /api/analytics/sales (duplicated intentionally to avoid re-touching the reviewed sales
// route mid-build).
export const GET = apiHandler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const { user } = await requireApproved();

    const productId = parseInt(params.id, 10);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    const sp = request.nextUrl.searchParams;
    const from = sp.get("from") ?? undefined;
    const to = sp.get("to") ?? undefined;
    const companyId = sp.get("companyId");

    // Sales scope (stock is GLOBAL): explicit companyId => membership-checked; else
    // sum the caller's OWN memberships. A non-member NEVER reaches the data layer.
    let companyIds: string[];
    if (companyId) {
      // Throws AppError 404 on non-member (admins bypass inside). apiHandler maps it.
      await requireCompanyMembership(user.id, companyId, user.isAdmin);
      companyIds = [companyId];
    } else {
      const memberships = await prisma.userCompany.findMany({
        where: { userId: user.id },
        select: { companyId: true },
      });
      companyIds = memberships.map((m: { companyId: string }) => m.companyId);
    }

    const [stock, salesRows] = await Promise.all([
      getStockSeries({ productId, from, to }),
      getSales({ companyIds, productId, from, to }),
    ]);

    // Serialize the Prisma Decimal revenue sum to a string per row so NextResponse.json
    // never emits a raw Decimal object. Other _sum fields are plain numbers.
    const sales = salesRows.map((row) => {
      const sum = (row as { _sum?: { revenue?: unknown } })._sum;
      if (sum && sum.revenue != null) {
        return { ...row, _sum: { ...sum, revenue: sum.revenue.toString() } };
      }
      return row;
    });

    return NextResponse.json({
      productId,
      stock: { series: stock, mode: "historical (GLOBAL inventory)" },
      sales: {
        series: sales,
        mode: "historical (your companies)",
        note: "revenue = direct (non-bundle) sales only; bundle units are included, bundle revenue is not represented",
      },
    });
  }
);
