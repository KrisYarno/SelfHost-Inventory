import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { getStockSeries, getSales } from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// Unified per-product analytics for one internal product:
//   - stock => GLOBAL inventory (never company-scoped; a no-companies caller still sees it).
//   - sales => the caller's OWN companies only ("ownership" view); never all companies.
//     A caller with zero companies gets GLOBAL stock but an empty sales series (no leak).
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

    // Ownership view: scope sales to the caller's OWN memberships, never all companies.
    const memberships = await prisma.userCompany.findMany({
      where: { userId: user.id },
      select: { companyId: true },
    });
    const companyIds = memberships.map((m: { companyId: string }) => m.companyId);

    const [stock, salesRows] = await Promise.all([
      getStockSeries({ productId }),
      getSales({ companyIds, productId }),
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
