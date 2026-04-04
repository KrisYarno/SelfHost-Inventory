import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  await requireApproved();

  const locationId = parseInt(params.id);
  if (isNaN(locationId)) {
    return NextResponse.json({ error: "Invalid location ID" }, { status: 400 });
  }

  // Verify location exists
  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: { id: true, name: true },
  });

  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  // Get all product_locations for this location with product details
  const productLocations = await prisma.product_locations.findMany({
    where: { locationId },
    include: {
      products: {
        select: {
          id: true,
          name: true,
          lowStockThreshold: true,
          deletedAt: true,
        },
      },
    },
  });

  // Filter out soft-deleted products
  const activeProductLocations = productLocations.filter(
    (pl) => pl.products.deletedAt === null
  );

  // Get last activity per product at this location
  const productIds = activeProductLocations.map((pl) => pl.products.id);

  const lastActivities = await prisma.inventory_logs.findMany({
    where: {
      locationId,
      productId: { in: productIds },
    },
    orderBy: { changeTime: "desc" },
    distinct: ["productId"],
    select: {
      productId: true,
      changeTime: true,
    },
  });

  const lastActivityMap = new Map<number, Date>(
    lastActivities.map((la) => [la.productId, la.changeTime])
  );

  // Build products array matching DrillDownModal expectations
  const products = activeProductLocations.map((pl) => ({
    id: pl.products.id,
    name: pl.products.name,
    stock: pl.quantity,
    lowStockThreshold: pl.products.lowStockThreshold ?? 10,
    lastActivity: lastActivityMap.get(pl.products.id) || null,
  }));

  // Sort: out-of-stock first, then low-stock, then by name
  products.sort((a, b) => {
    if (a.stock === 0 && b.stock !== 0) return -1;
    if (a.stock !== 0 && b.stock === 0) return 1;
    if (a.stock < a.lowStockThreshold && b.stock >= b.lowStockThreshold) return -1;
    if (a.stock >= a.lowStockThreshold && b.stock < b.lowStockThreshold) return 1;
    return a.name.localeCompare(b.name);
  });

  const totalProducts = products.length;
  const totalStock = products.reduce((sum, p) => sum + p.stock, 0);

  return NextResponse.json({
    locationName: location.name,
    totalProducts,
    totalStock,
    products,
  });
});
