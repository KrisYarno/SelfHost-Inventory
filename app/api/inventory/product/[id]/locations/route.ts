import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type { ProductLocationQuantity } from "@/types/inventory";

export const dynamic = "force-dynamic";

/**
 * GET /api/inventory/product/[id]/locations
 * Returns quantities for a product at ALL locations
 * Used by StockInDialog to show available stock at each location
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    // Get product (excluding soft deleted)
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // Get all locations
    const allLocations = await prisma.location.findMany({
      orderBy: { name: "asc" },
    });

    // Get product_locations for this product
    const productLocations = await prisma.product_locations.findMany({
      where: { productId },
      select: {
        locationId: true,
        quantity: true,
        version: true,
      },
    });

    // Create a map for quick lookup
    const locationQuantityMap = new Map<number, { quantity: number; version: number }>();
    for (const pl of productLocations) {
      locationQuantityMap.set(pl.locationId, { quantity: pl.quantity, version: pl.version });
    }

    // Build response with all locations (including those with 0 quantity)
    const locations: ProductLocationQuantity[] = allLocations.map((loc: { id: number; name: string }) => {
      const plData = locationQuantityMap.get(loc.id);
      return {
        locationId: loc.id,
        locationName: loc.name,
        quantity: plData?.quantity ?? 0,
        version: plData?.version ?? 0,
      };
    });

    return NextResponse.json({
      productId: product.id,
      productName: product.name,
      locations,
    });
  } catch (error) {
    console.error("Error fetching product locations:", error);
    return NextResponse.json(
      { error: "Failed to fetch product locations" },
      { status: 500 }
    );
  }
}
