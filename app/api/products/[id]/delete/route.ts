import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      deletedAt: true,
      product_locations: {
        select: {
          quantity: true,
          locations: {
            select: { name: true },
          },
        },
      },
    },
  });

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  if (product.deletedAt) {
    return NextResponse.json({ error: "Product is already deleted" }, { status: 400 });
  }

  const totalInventory = product.product_locations.reduce((sum, loc) => sum + loc.quantity, 0);

  await prisma.product.update({
    where: { id: productId },
    data: {
      deletedAt: new Date(),
      deletedBy: user.id,
    },
  });

  await prisma.inventory_logs.create({
    data: {
      userId: user.id,
      productId: productId,
      delta: 0,
      changeTime: new Date(),
      logType: "ADJUSTMENT",
    },
  });

  return NextResponse.json({
    success: true,
    message: `Product "${product.name}" has been deleted`,
    productName: product.name,
    hadInventory: totalInventory > 0,
    inventoryAmount: totalInventory,
  });
});
