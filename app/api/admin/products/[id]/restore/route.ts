import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: {
    id: string;
  };
}

// POST /api/admin/products/[id]/restore - Restore a soft deleted product (Admin only)
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdmin();

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    // Check if product exists and is deleted
    const existingProduct = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!existingProduct) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    if (!existingProduct.deletedAt) {
      return NextResponse.json({ error: "Product is not deleted" }, { status: 400 });
    }

    // Restore the product
    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        deletedAt: null,
        deletedBy: null,
      },
    });

    // Note: We don't create an inventory log for restoration as it's not an inventory change
    // The soft delete fields being cleared serve as the audit trail

    return NextResponse.json({
      message: "Product restored successfully",
      product,
    });
  } catch (error) {
    console.error("Error restoring product:", error);
    return NextResponse.json({ error: "Failed to restore product" }, { status: 500 });
  }
}
