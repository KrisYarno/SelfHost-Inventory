import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/admin/products/deleted - List all soft deleted products (Admin only)
export async function GET(_request: NextRequest) {
  try {
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

    return NextResponse.json({
      products: deletedProducts,
      total: deletedProducts.length,
    });
  } catch (error) {
    console.error("Error fetching deleted products:", error);
    return NextResponse.json({ error: "Failed to fetch deleted products" }, { status: 500 });
  }
}
