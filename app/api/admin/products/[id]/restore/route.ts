import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: {
    id: string;
  };
}

// POST /api/admin/products/[id]/restore - Restore a soft deleted product (Admin only)
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

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

  const priorDeletedAt = existingProduct.deletedAt;

  // Restore + record atomically (D4/D8): capture the stock that RE-ENTERS
  // current-state views (nonzero rows only) as the soft-delete is reversed —
  // the symmetric counterpart of PRODUCT_DELETE's heldStock snapshot.
  const product = await prisma.$transaction(async (tx) => {
    const heldStock = await tx.product_locations.findMany({
      where: { productId, quantity: { not: 0 } },
      select: { locationId: true, quantity: true },
    });

    const restored = await tx.product.update({
      where: { id: productId },
      data: {
        deletedAt: null,
        deletedBy: null,
      },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "PRODUCT_RESTORE",
      entityType: "PRODUCT",
      entityId: restored.id,
      action: `Restored product "${restored.name}"`,
      changes: { deletedAt: { from: priorDeletedAt.toISOString(), to: null } },
      details: { productName: restored.name, heldStock },
    });

    return restored;
  });

  return NextResponse.json({
    message: "Product restored successfully",
    product,
  });
});
