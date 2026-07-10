import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { AppError } from "@/lib/error-handling";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const locationId = parseInt(params.id);

  if (isNaN(locationId)) {
    return NextResponse.json({ error: "Invalid location ID" }, { status: 400 });
  }

  // Don't allow deletion of the main location (ID: 1)
  if (locationId === 1) {
    return NextResponse.json({ error: "Cannot delete the main location" }, { status: 400 });
  }

  // Check if location exists
  const location = await prisma.location.findUnique({
    where: { id: locationId },
  });

  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // D7 + R-D16: count EVERY referencing table. Zero-quantity product_locations
      // rows are removable (config debris); everything else blocks with a 409 that
      // names each blocker so the admin knows exactly what to move or reassign.
      const [plRows, ledger, notif, snapshots, staging, usersDefault] = await Promise.all([
        tx.product_locations.findMany({ where: { locationId }, select: { quantity: true } }),
        tx.inventory_logs.count({ where: { locationId } }),
        tx.notificationHistory.count({ where: { locationId } }),
        tx.productStockSnapshot.count({ where: { locationId } }),
        tx.stagingItem.count({ where: { locationId } }),
        tx.user.count({ where: { defaultLocationId: locationId, deletedAt: null } }),
      ]);
      const stockedRows = plRows.filter((r) => r.quantity !== 0).length;
      const blockers: string[] = [];
      if (ledger > 0) blockers.push(`${ledger} inventory ledger entries`);
      if (stockedRows > 0) blockers.push(`${stockedRows} stocked product-location rows (transfer stock out first)`);
      if (notif > 0) blockers.push(`${notif} notification-history entries`);
      if (snapshots > 0) blockers.push(`${snapshots} stock snapshots`);
      if (staging > 0) blockers.push(`${staging} staging items`);
      if (usersDefault > 0) blockers.push(`${usersDefault} users with this as their default location (reassign first)`);
      if (blockers.length > 0) {
        throw new AppError(
          `Location "${location.name}" has history and cannot be deleted: ${blockers.join("; ")}.`,
          "LOCATION_HAS_HISTORY",
          409
        );
      }
      const removedZeroQty = await tx.product_locations.deleteMany({ where: { locationId } }); // all remaining rows are qty 0
      await tx.location.delete({ where: { id: locationId } });
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "LOCATION_DELETE",
        entityType: "LOCATION",
        entityId: locationId,
        action: `Deleted location "${location.name}"`,
        details: { snapshot: location, removedZeroQtyRows: removedZeroQty.count },
      });
    });
  } catch (err) {
    // ER-B2: a reference created between the counts and the delete makes
    // location.delete throw Prisma P2003 — map it to the same 409 shape so no
    // raw 500 escapes this handler. All other errors (incl. the blocker
    // AppError above) propagate for apiHandler to map.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      throw new AppError(
        `Location "${location.name}" gained new references while deleting — re-check and retry.`,
        "LOCATION_HAS_HISTORY",
        409
      );
    }
    throw err;
  }

  return NextResponse.json({
    message: "Location deleted successfully",
    deletedId: locationId,
  });
});
