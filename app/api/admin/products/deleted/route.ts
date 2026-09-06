import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/admin/products/deleted - List all soft deleted products (Admin only)
export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAdmin();

  // Get all soft deleted products
  const deletedProducts = await prisma.product.findMany({
    where: {
      deletedAt: {
        not: null,
      },
    },
    include: {
      deletedByUser: {
        select: {
          id: true,
          username: true,
          email: true,
        },
      },
    },
    orderBy: {
      deletedAt: "desc",
    },
  });

  // The loc-1 `products.quantity` mirror is retired (B2.5) — strip it from every
  // listed row so a dead column never reaches the wire. The `include` shape (and
  // therefore `deletedByUser`) is untouched.
  const products = deletedProducts.map((row) => {
    const { quantity: _retiredMirror, ...product } = row;
    return product;
  });

  return NextResponse.json({
    products,
    total: products.length,
  });
});
