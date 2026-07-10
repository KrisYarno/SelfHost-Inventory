import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { ActivityResponse, ActivityItem } from "@/types/reports";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "20");
  const skip = (page - 1) * pageSize;

  // Get recent inventory logs with related data
  const [logs, total] = await Promise.all([
    prisma.inventory_logs.findMany({
      skip,
      take: pageSize,
      orderBy: { changeTime: "desc" },
      include: {
        users: {
          select: {
            id: true,
            username: true,
          },
        },
        products: {
          select: {
            id: true,
            name: true,
          },
        },
        locations: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
    prisma.inventory_logs.count(),
  ]);

  // Transform logs to activity items
  const activities: ActivityItem[] = logs.map((log) => {
    let type: ActivityItem["type"] = "adjustment";
    let description = "";

    // Determine activity type based on logType and delta
    if (log.logType === "TRANSFER") {
      // Transfer activities
      if (log.delta > 0) {
        type = "stock_in";
        description = `Received ${log.delta} units of ${log.products.name} via transfer`;
      } else if (log.delta < 0) {
        type = "stock_out";
        description = `Transferred out ${Math.abs(log.delta)} units of ${log.products.name}`;
      } else {
        type = "adjustment";
        description = `Transfer with no quantity change for ${log.products.name}`;
      }
    } else if (log.logType === "STOCK_IN") {
      // Receiving stock (stock-in route / graduation)
      type = "stock_in";
      description = `Received ${log.delta} units of ${log.products.name}`;
    } else if (log.logType === "SALE") {
      // Customer purchase (fulfillment / manual-order deduction)
      type = "stock_out";
      description = `Sold ${Math.abs(log.delta)} units of ${log.products.name}`;
    } else if (log.logType === "CORRECTION") {
      // Reversal / correction (unfulfill, decline) — signed delta conveys direction
      type = log.delta > 0 ? "stock_in" : log.delta < 0 ? "stock_out" : "adjustment";
      const signed = log.delta > 0 ? `+${log.delta}` : `${log.delta}`;
      description = `Corrected by ${signed} units of ${log.products.name}`;
    } else if (log.logType === "COUNT") {
      // Physical count — a zero delta is "no change", never "Removed 0"
      type = "adjustment";
      description =
        log.delta === 0
          ? `Counted ${log.products.name} — no change`
          : `Counted ${log.products.name}: ${log.delta > 0 ? `+${log.delta}` : `${log.delta}`} units`;
    } else if (log.logType === "ADJUSTMENT") {
      // Adjustment activities - determine type based on delta
      if (log.delta > 0) {
        type = "stock_in";
        description = `Stocked in ${log.delta} units of ${log.products.name}`;
      } else if (log.delta < 0) {
        type = "stock_out";
        description = `Removed ${Math.abs(log.delta)} units of ${log.products.name}`;
      } else {
        type = "adjustment";
        description = `No quantity change for ${log.products.name}`;
      }
    } else {
      // Fallback for genuinely unknown / future logType values only
      type = log.delta > 0 ? "stock_in" : log.delta < 0 ? "stock_out" : "adjustment";
      description = `${log.delta > 0 ? "Added" : "Removed"} ${Math.abs(log.delta)} units of ${log.products.name}`;
    }

    return {
      id: log.id.toString(),
      timestamp: log.changeTime,
      type,
      description,
      // Machine-actor rows (nullable userId) have no owning user. This is an event
      // feed, not per-user attribution, so we label the actor "System"; id 0 is a
      // never-a-real-user sentinel (autoincrement starts at 1) and is unused by the UI.
      user: {
        id: log.users?.id ?? 0,
        username: log.users?.username ?? "System",
      },
      product: {
        id: log.products.id,
        name: log.products.name,
      },
      location: {
        id: log.locations?.id || 1,
        name: log.locations?.name || "Default",
      },
      metadata: {
        quantityChange: log.delta,
        logType: log.logType,
      },
    };
  });

  const response: ActivityResponse = {
    activities,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };

  return NextResponse.json(response);
});
