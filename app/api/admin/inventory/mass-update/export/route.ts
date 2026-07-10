import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { rowsToCSV } from "@/lib/csv";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAdmin();

  // Get all products with their current inventory levels
  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
    },
    include: {
      product_locations: {
        include: {
          locations: true,
        },
      },
    },
    orderBy: [{ baseName: "asc" }, { variant: "asc" }],
  });

  // Get all locations
  const locations = await prisma.location.findMany({
    orderBy: { name: "asc" },
  });

  // Record the export BEFORE streaming the CSV (D6). GET routes are invisible to
  // the coverage gate; this record + its test are the enforcement.
  await prisma.$transaction(async (tx) => {
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "DATA_EXPORT",
      entityType: "SYSTEM",
      entityId: null,
      action: "Exported mass-update count sheet CSV",
      details: { export: "count-sheet", rowCount: products.length },
    });
  });

  // Build CSV header
  const headers = ["Product ID", "Product Name", "Base Name", "Variant"];
  locations.forEach((location) => {
    headers.push(`${location.name} - Current`);
    headers.push(`${location.name} - New Count`);
  });

  // Build CSV rows
  const rows: string[][] = [];

  products.forEach((product) => {
    const row = [
      product.id.toString(),
      product.name,
      product.baseName || "",
      product.variant || "",
    ];

    // Add location quantities
    locations.forEach((location) => {
      const productLocation = product.product_locations.find(
        (pl) => pl.locationId === location.id
      );
      row.push((productLocation?.quantity || 0).toString());
      row.push(""); // Empty cell for new count
    });

    rows.push(row);
  });

  // Convert to CSV format. Data rows go through the shared RFC 4180 escaper,
  // which (unlike the previous inline escaper) also quotes cells containing
  // newlines — the fix for malformed CSV when a product name contains a line
  // break. Header construction is unchanged.
  const csvContent = [headers.join(","), rowsToCSV(rows)].join("\n");

  // Return CSV file
  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="inventory-count-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
});
