import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAdmin();

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

  // Convert to CSV format
  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      row
        .map((cell) => {
          // Escape cells containing commas or quotes
          if (cell.includes(",") || cell.includes('"')) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
        })
        .join(",")
    ),
  ].join("\n");

  // Return CSV file
  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="inventory-count-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
});
