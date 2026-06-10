import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { Prisma, Product, product_locations, Location } from "@prisma/client";

export const dynamic = "force-dynamic";

interface ProductWithLocations {
  id: number;
  name: string;
  baseName: string;
  variant: string | null;
  combinedMinimum: number;
  locations: {
    locationId: number;
    locationName: string;
    quantity: number;
    minQuantity: number;
  }[];
  totalQuantity: number;
}

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const _locationId = searchParams.get("locationId");
  // Clamp pagination: NaN-safe via the `|| fallback`, pageSize capped at 100.
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "12", 10) || 12));
  const search = searchParams.get("search") || "";

  // Build where clause for search - exclude soft deleted products.
  // SHOW contract: provisional (PENDING_REVIEW) products stay visible here -- do NOT
  // add an approvalStatus filter. Locked by __tests__/integration/read-path-isolation.test.ts.
  const whereClause: Prisma.ProductWhereInput = {
    deletedAt: null,
  };
  if (search) {
    whereClause.OR = [
      { name: { contains: search } },
      { baseName: { contains: search } },
      { variant: { contains: search } },
    ];
  }

  // Get total count for pagination
  const total = await prisma.product.count({ where: whereClause });

  // Get products with their location quantities
  const products = await prisma.product.findMany({
    where: whereClause,
    skip: (page - 1) * pageSize,
    take: pageSize,
    orderBy: [{ baseName: "asc" }, { variant: "asc" }],
    include: {
      product_locations: {
        include: {
          locations: true,
        },
      },
    },
  });

  // Transform data to include location breakdown
  const transformedProducts: ProductWithLocations[] = products.map(
    (
      product: Product & {
        product_locations: (product_locations & {
          locations: Location;
        })[];
      }
    ) => {
      const locations = product.product_locations.map((pl) => ({
        locationId: pl.locationId,
        locationName: pl.locations.name,
        quantity: pl.quantity,
        minQuantity: pl.minQuantity ?? 0,
      }));

      const totalQuantity = locations.reduce((sum: number, loc) => sum + loc.quantity, 0);

      return {
        id: product.id,
        name: product.name,
        baseName: product.baseName || "",
        variant: product.variant,
        combinedMinimum: product.lowStockThreshold ?? 0,
        locations: locations.sort((a, b) => b.quantity - a.quantity),
        totalQuantity,
      };
    }
  );

  return NextResponse.json({
    products: transformedProducts,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page < Math.ceil(total / pageSize),
    },
  });
});
