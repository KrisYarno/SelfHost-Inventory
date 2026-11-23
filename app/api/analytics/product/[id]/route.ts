import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";
import { getStockSeries, getSales } from "@/lib/analytics/queries";
import { resolveCallerCompanyIds, serializeSalesRows } from "@/lib/analytics/company-scope";
import { REVENUE_CAVEAT_NOTE } from "@/lib/analytics/constants";

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
// N0 (C7, RB-8 narrowed): this is a SHOW surface — a PENDING_REVIEW product is real
// stock and is served (see read-path-isolation). What it must not do is invent one:
//   - the id must be a positive Int (/^[1-9]\d{0,9}$/ and <= 2147483647), else 400;
//   - the EXISTENCE check runs FIRST, before any series read: an unknown id is a
//     404, never a 200 of nulls and zeros;
//   - a SOFT-DELETED product is served (identity by ID, like the History route),
//     with product.deletedAt set so the page can say so. deletedAt is always present.
//
const PRODUCT_ID_RE = /^[1-9]\d{0,9}$/;
const MAX_INT = 2147483647;

export const GET = apiHandler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const { user } = await requireApproved();

    if (!PRODUCT_ID_RE.test(params.id) || Number(params.id) > MAX_INT) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }
    const productId = Number(params.id);

    // Existence FIRST — nothing else is read for a product that does not exist.
    const identity = await prisma.product.findUnique({
      where: { id: productId },
      select: { name: true, baseName: true, variant: true, deletedAt: true },
    });
    if (!identity) {
      throw new AppError("Product not found", "NOT_FOUND", 404);
    }

    const sp = request.nextUrl.searchParams;
    const from = sp.get("from") ?? undefined;
    const to = sp.get("to") ?? undefined;
    const companyId = sp.get("companyId");

    // Sales scope (stock is GLOBAL): explicit companyId => membership-checked; else
    // sum the caller's OWN memberships. A non-member NEVER reaches the data layer.
    const companyIds = await resolveCallerCompanyIds(user, companyId);

    // The D-L2 History-host header consumes product identity (name/baseName/variant,
    // read above) + current GLOBAL stock (sum across all locations — the physical
    // pool, never company-scoped).
    const [stock, salesRows, stockAgg] = await Promise.all([
      getStockSeries({ productId, from, to }),
      getSales({ companyIds, productId, from, to }),
      prisma.product_locations.aggregate({
        _sum: { quantity: true },
        where: { productId },
      }),
    ]);

    // Serialize the Prisma Decimal revenue sum to a string per row so NextResponse.json
    // never emits a raw Decimal object. Other _sum fields are plain numbers.
    const sales = serializeSalesRows(salesRows);

    return NextResponse.json({
      productId,
      product: {
        name: identity.name ?? null,
        baseName: identity.baseName ?? null,
        variant: identity.variant ?? null,
        currentStock: stockAgg._sum.quantity ?? 0,
        deletedAt: identity.deletedAt ? identity.deletedAt.toISOString() : null,
      },
      stock: { series: stock, mode: "historical (GLOBAL inventory)" },
      sales: {
        series: sales,
        mode: "historical (your companies)",
        note: REVENUE_CAVEAT_NOTE,
      },
    });
  }
);
