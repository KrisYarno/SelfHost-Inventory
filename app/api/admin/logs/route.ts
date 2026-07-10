import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { inventory_logs_logType } from "@prisma/client";
import { z } from "zod";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const searchParams = request.nextUrl.searchParams;
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "20");
  const search = searchParams.get("search") || "";
  const userFilter = searchParams.get("user");
  const locationFilter = searchParams.get("location");
  const typeFilter = searchParams.get("type");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  // Build where clause
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
    // Pillar 1: filter by locationId so renames don't hide historical rows.
    // Backwards-compatible: bookmarked URLs with ?location=Name still work via
    // the else-branch name lookup.
    const asId = parseInt(locationFilter, 10);
    if (Number.isFinite(asId) && String(asId) === locationFilter) {
      whereClause.locationId = asId;
    } else {
      whereClause.locations = { name: locationFilter };
    }
  }

  if (typeFilter && typeFilter !== "all") {
    // Validate against the enum so garbage input is a clean 400 (via apiHandler's
    // ZodError map), never a raw Prisma passthrough that 500s.
    whereClause.logType = z.nativeEnum(inventory_logs_logType).parse(typeFilter);
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

  // Get total count
  const total = await prisma.inventory_logs.count({ where: whereClause });

  // Get paginated logs
  const logs = await prisma.inventory_logs.findMany({
    where: whereClause,
    include: {
      users: true,
      products: true,
      locations: true,
    },
    orderBy: { changeTime: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  // Transform data
  const transformedLogs = logs.map((log) => ({
    id: log.id,
    timestamp: log.changeTime.toISOString(),
    productName: log.products.name,
    // Machine-actor rows (nullable userId) have no owning user — render "System".
    userName: log.users?.username ?? "System",
    locationName: log.locations?.name || "Unknown",
    delta: log.delta,
    logType: log.logType,
    // Phase C ledger semantics exposed to the read path.
    batchId: log.batchId,
    reasonCode: log.reasonCode,
    unitCostCents: log.unitCostCents,
  }));

  return NextResponse.json({
    logs: transformedLogs,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});
