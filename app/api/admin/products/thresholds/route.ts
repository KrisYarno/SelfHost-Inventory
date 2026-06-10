import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/admin/products/thresholds - Get all products with thresholds
export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAdmin();

  const locations = await prisma.location.findMany({
    orderBy: { name: "asc" },
  });

  const products = await prisma.product.findMany({
    where: { deletedAt: null, approvalStatus: "APPROVED" },
    include: {
      product_locations: {
        include: { locations: true },
      },
    },
    orderBy: { name: "asc" },
  });

  const payload = products.map((product) => {
    const totalStock = product.product_locations.reduce((sum, row) => sum + row.quantity, 0);

    const perLocation = locations.map((location) => {
      const row = product.product_locations.find((pl) => pl.locationId === location.id);
      return {
        locationId: location.id,
        locationName: location.name,
        quantity: row?.quantity ?? 0,
        minQuantity: row?.minQuantity ?? 0,
      };
    });

    return {
      id: product.id,
      name: product.name,
      combinedMinimum: product.lowStockThreshold ?? 0,
      totalStock,
      perLocation,
    };
  });

  return NextResponse.json({
    locations,
    products: payload,
  });
});

// PATCH /api/admin/products/thresholds - Bulk update thresholds
export const PATCH = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  const { updates } = body as {
    updates: Array<{
      productId: number;
      combinedMinimum?: number;
      perLocation?: { locationId: number; minQuantity: number }[];
    }>;
  };

  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  const ops: any[] = [];

  for (const update of updates) {
    if (!update.productId) {
      return NextResponse.json({ error: "Invalid update format" }, { status: 400 });
    }

    if (update.combinedMinimum !== undefined && update.combinedMinimum < 0) {
      return NextResponse.json({ error: "Combined minimum cannot be negative" }, { status: 400 });
    }

    if (update.combinedMinimum !== undefined) {
      ops.push(
        prisma.product.update({
          where: { id: update.productId },
          data: { lowStockThreshold: update.combinedMinimum },
        })
      );
    }

    if (Array.isArray(update.perLocation)) {
      for (const loc of update.perLocation) {
        if (loc.minQuantity < 0) {
          return NextResponse.json(
            { error: "Location minimum cannot be negative" },
            { status: 400 }
          );
        }
        ops.push(
          prisma.product_locations.upsert({
            where: {
              productId_locationId: {
                productId: update.productId,
                locationId: loc.locationId,
              },
            },
            update: {
              minQuantity: loc.minQuantity,
            },
            create: {
              productId: update.productId,
              locationId: loc.locationId,
              quantity: 0,
              minQuantity: loc.minQuantity,
            },
          })
        );
      }
    }
  }

  if (ops.length) {
    await prisma.$transaction(ops);
  }

  return NextResponse.json({
    success: true,
    updatedCount: updates.length,
  });
});
