import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: {
    id: string;
  };
}

// POST /api/admin/products/[id]/restore - Restore a soft deleted product (Admin only)
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
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

  return NextResponse.json({
    message: "Product restored successfully",
    product,
  });
});
