import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { ThresholdsUpdateSchema } from "@/lib/validation/admin";
import { recordChange, newBatchId, type ChangeDiff } from "@/lib/change-tracking";

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
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  // Schema enforces >= 0 integers and a non-empty updates array.
  const { updates } = ThresholdsUpdateSchema.parse(body);

  const productIds = updates.map((u) => u.productId);
  const locationPairs = updates.flatMap((u) =>
    (u.perLocation ?? []).map((loc) => ({ productId: u.productId, locationId: loc.locationId }))
  );

  // Callback-form tx (recordChange needs the tx client): fetch before-images
  // INSIDE the tx, apply the same updates/upserts, build the R-D14 change rows,
  // and emit ONE bulk PRODUCT_UPDATE (ER-B9: rows with no real change drop; if
  // nothing changed, no event is written).
  await prisma.$transaction(async (tx) => {
    const beforeProducts = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, lowStockThreshold: true },
    });
    const beforeThreshold = new Map(beforeProducts.map((p) => [p.id, p.lowStockThreshold]));

    const beforeLocations = locationPairs.length
      ? await tx.product_locations.findMany({
          where: { OR: locationPairs },
          select: { productId: true, locationId: true, minQuantity: true },
        })
      : [];
    const beforeMinQuantity = new Map(
      beforeLocations.map((r) => [`${r.productId}:${r.locationId}`, r.minQuantity])
    );

    const rows: Array<{ entityId: string; changes: ChangeDiff }> = [];

    for (const update of updates) {
      const rowChanges: ChangeDiff = {};

      if (update.combinedMinimum !== undefined) {
        const from = beforeThreshold.has(update.productId)
          ? beforeThreshold.get(update.productId) ?? null
          : null;
        await tx.product.update({
          where: { id: update.productId },
          data: { lowStockThreshold: update.combinedMinimum },
        });
        if (from !== update.combinedMinimum) {
          rowChanges.lowStockThreshold = { from, to: update.combinedMinimum };
        }
      }

      if (update.perLocation) {
        for (const loc of update.perLocation) {
          const key = `${update.productId}:${loc.locationId}`;
          const from = beforeMinQuantity.has(key) ? beforeMinQuantity.get(key) ?? null : null;
          await tx.product_locations.upsert({
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
          });
          if (from !== loc.minQuantity) {
            rowChanges[`minQuantity[${loc.locationId}]`] = { from, to: loc.minQuantity };
          }
        }
      }

      if (Object.keys(rowChanges).length > 0) {
        rows.push({ entityId: String(update.productId), changes: rowChanges });
      }
    }

    if (rows.length > 0) {
      const details: Record<string, unknown> =
        rows.length > 500
          ? { rows: rows.slice(0, 500), rowCount: rows.length, rowsOmitted: true }
          : { rows };

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "PRODUCT_UPDATE",
        entityType: "PRODUCT",
        entityId: null,
        action: `Updated thresholds for ${rows.length} product(s)`,
        details,
        affectedCount: rows.length,
        batchId: newBatchId(),
      });
    }
  });

  return NextResponse.json({
    success: true,
    updatedCount: updates.length,
  });
});
