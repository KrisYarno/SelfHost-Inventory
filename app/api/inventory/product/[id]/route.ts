import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { getCurrentQuantity } from "@/lib/inventory";
import type { ProductInventoryHistory } from "@/types/inventory";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  await requireApproved();

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
  }

  const searchParams = request.nextUrl.searchParams;
  const locationId = searchParams.get("locationId");
  const limit = Math.min(1000, parseInt(searchParams.get("limit") || "100"));

  // Get product (excluding soft deleted)
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      deletedAt: null,
    },
  });

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  // Get location (default to first location if not specified)
  let location;
  if (locationId) {
    location = await prisma.location.findUnique({
      where: { id: parseInt(locationId) },
    });
  } else {
    location = await prisma.location.findFirst({
      orderBy: { id: "asc" },
    });
  }

  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  // Get current quantity
  const currentQuantity = await getCurrentQuantity(product.id, location.id);

  // Get history
  const history = await prisma.inventory_logs.findMany({
    where: {
      productId: product.id,
      locationId: location.id,
    },
    // SECURITY: select only safe relation fields — `users: true` would ship
    // passwordHash to any approved client (mirrors /api/inventory/logs).
    include: {
      users: { select: { id: true, username: true, email: true } },
      products: { select: { id: true, name: true, baseName: true, variant: true } },
      locations: { select: { id: true, name: true } },
    },
    orderBy: {
      changeTime: "desc",
    },
    take: limit,
  });

  const response: ProductInventoryHistory = {
    product,
    location,
    currentQuantity,
    history,
  };

  return NextResponse.json(response);
});
