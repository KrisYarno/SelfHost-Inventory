import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { ThresholdsUpdateSchema } from "@/lib/validation/admin";
import { recordChange, newBatchId, type ChangeDiff } from "@/lib/change-tracking";
import { getLowStockDefault } from "@/lib/stock-threshold";

export const dynamic = "force-dynamic";

// GET /api/admin/products/thresholds - Get all products with thresholds
export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAdmin();

  // System default surfaced so the matrix can render each product's effective
  // value inline and drive the tri-state control (D-L9).
  const lowStockDefault = await getLowStockDefault();

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
      // RAW nullable value so the tri-state control can distinguish inherit
      // (null) from off (0) from an explicit override (>0). NEVER coalesced here.
      combinedMinimum: product.lowStockThreshold,
      totalStock,
      perLocation,
    };
  });

  return NextResponse.json({
    locations,
    lowStockDefault,
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
  // INSIDE the tx, apply the same updates/upserts, build per-product change rows,
  // and emit ONE PRODUCT_UPDATE PER changed product sharing a single batchId
  // (R-L6 — per-product diffs already exist, so each product's threshold change
  // lands on its own History timeline; ER-B9: rows with no real change drop; if
  // nothing changed, no events are written).
  await prisma.$transaction(async (tx) => {
    const beforeProducts = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, lowStockThreshold: true },
    });
    const beforeThreshold = new Map(beforeProducts.map((p) => [p.id, p.lowStockThreshold]));
    const nameById = new Map(beforeProducts.map((p) => [p.id, p.name]));

    const beforeLocations = locationPairs.length
      ? await tx.product_locations.findMany({
          where: { OR: locationPairs },
          select: { productId: true, locationId: true, minQuantity: true },
        })
      : [];
    const beforeMinQuantity = new Map(
      beforeLocations.map((r) => [`${r.productId}:${r.locationId}`, r.minQuantity])
    );

    const rows: Array<{ productId: number; changes: ChangeDiff }> = [];

    for (const update of updates) {
      const rowChanges: ChangeDiff = {};

      if (update.combinedMinimum !== undefined) {
        // NULL/0/>0 semantics flow straight through: null clears the override
        // (inherit), 0 disables, >0 is explicit. `from` normalizes absent → null.
        const from = beforeThreshold.has(update.productId)
          ? beforeThreshold.get(update.productId) ?? null
          : null;
        const to = update.combinedMinimum ?? null;
        await tx.product.update({
          where: { id: update.productId },
          data: { lowStockThreshold: to },
        });
        if (from !== to) {
          rowChanges.lowStockThreshold = { from, to };
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
        rows.push({ productId: update.productId, changes: rowChanges });
      }
    }

    // Per-product PRODUCT_UPDATE events under ONE shared batchId (R-L6). Each is
    // addressed to its product (entityId = productId) so it renders on that
    // product's History timeline; the batchId groups the bulk save for drill-down.
    if (rows.length > 0) {
      const batchId = newBatchId();
      for (const { productId, changes } of rows) {
        const name = nameById.get(productId);
        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: "PRODUCT_UPDATE",
          entityType: "PRODUCT",
          entityId: productId,
          action: name
            ? `Updated stock thresholds for "${name}"`
            : `Updated stock thresholds`,
          changes,
          details: { productName: name },
          batchId,
        });
      }
    }
  });

  return NextResponse.json({
    success: true,
    updatedCount: updates.length,
  });
});
