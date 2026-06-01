import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const searchParams = request.nextUrl.searchParams;
  const search = searchParams.get("search") || "";
  const userFilter = searchParams.get("user");
  const locationFilter = searchParams.get("location");
  const typeFilter = searchParams.get("type");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  // Build where clause (same as logs endpoint)
  const whereClause: any = {};

  if (search) {
    whereClause.products = {
      name: { contains: search },
    };
  }

  if (userFilter && userFilter !== "all") {
    whereClause.userId = parseInt(userFilter);
  }

  if (locationFilter && locationFilter !== "all") {
    // Pillar 1: filter by locationId. Backwards-compatible with name URLs.
    const asId = parseInt(locationFilter, 10);
    if (Number.isFinite(asId) && String(asId) === locationFilter) {
      whereClause.locationId = asId;
    } else {
      whereClause.locations = { name: locationFilter };
    }
  }

  if (typeFilter && typeFilter !== "all") {
    whereClause.logType = typeFilter;
  }

  if (dateFrom || dateTo) {
    whereClause.changeTime = {};
    if (dateFrom) whereClause.changeTime.gte = new Date(dateFrom);
    if (dateTo) {
      const endDate = new Date(dateTo);
      endDate.setHours(23, 59, 59, 999);
      whereClause.changeTime.lte = endDate;
    }
  }

  // Get all matching logs (no pagination for export)
  const logs = await prisma.inventory_logs.findMany({
    where: whereClause,
    include: {
      users: true,
      products: true,
      locations: true,
    },
    orderBy: { changeTime: "desc" },
  });

  // Build CSV content
  const headers = ["Timestamp", "Product Name", "User", "Location", "Type", "Change (Delta)"];
  const rows = [headers];

  logs.forEach((log) => {
    rows.push([
      log.changeTime.toISOString(),
      log.products.name,
      log.users.username,
      log.locations?.name || "Unknown",
      log.logType,
      log.delta.toString(),
    ]);
  });

  // Convert to CSV string
  const csvContent = rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");

  // Return as downloadable file
  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="inventory-logs-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
});
