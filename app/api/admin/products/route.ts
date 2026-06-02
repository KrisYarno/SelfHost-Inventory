import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { ProductApprovalStatus, Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const VALID_APPROVAL = new Set<string>(Object.values(ProductApprovalStatus));

// GET /api/admin/products?approvalStatus=PENDING_REVIEW
// Admin-only product list for the review queue. Filters by approvalStatus when
// provided (defaults to all non-deleted products) and hydrates the creator so
// the review UI can show who logged each provisional product.
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const approvalStatusParam =
    request.nextUrl.searchParams.get("approvalStatus");

  const where: Prisma.ProductWhereInput = {
    deletedAt: null,
    ...(approvalStatusParam && VALID_APPROVAL.has(approvalStatusParam)
      ? { approvalStatus: approvalStatusParam as ProductApprovalStatus }
      : {}),
  };

  const products = await prisma.product.findMany({
    where,
    include: {
      createdByUser: {
        select: { id: true, username: true, email: true },
      },
      product_locations: {
        select: { quantity: true },
      },
    },
    // Product has no createdAt column; id-desc is a stable newest-first proxy.
    orderBy: { id: "desc" },
  });

  const productsWithQuantity = products.map((product) => {
    const currentQuantity = product.product_locations.reduce(
      (sum, pl) => sum + pl.quantity,
      0
    );
    return {
      ...product,
      currentQuantity,
      product_locations: undefined,
    };
  });

  return NextResponse.json({
    products: productsWithQuantity,
    total: productsWithQuantity.length,
  });
});
