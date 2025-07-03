import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { ActivityResponse, ActivityItem } from "@/types/reports";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const pageSize = parseInt(searchParams.get("pageSize") || "20");
    const skip = (page - 1) * pageSize;

    // Get recent inventory logs with related data
    const [logs, total] = await Promise.all([
      prisma.inventory_logs.findMany({
        skip,
        take: pageSize,
        orderBy: { changeTime: 'desc' },
        include: {
          users: {
            select: {
              id: true,
              username: true
            }
          },
          products: {
            select: {
              id: true,
              name: true
            }
          },
          locations: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }),
      prisma.inventory_logs.count()
    ]);

    // Transform logs to activity items
    const activities: ActivityItem[] = logs.map(log => {
      let type: ActivityItem['type'] = 'adjustment';
      let description = '';

      // Determine activity type based on logType and delta
      if (log.logType === 'TRANSFER') {
        // Transfer activities
        if (log.delta > 0) {
          type = 'stock_in';
          description = `Received ${log.delta} units of ${log.products.name} via transfer`;
        } else if (log.delta < 0) {
          type = 'stock_out';
          description = `Transferred out ${Math.abs(log.delta)} units of ${log.products.name}`;
        } else {
          type = 'adjustment';
          description = `Transfer with no quantity change for ${log.products.name}`;
        }
      } else if (log.logType === 'ADJUSTMENT') {
        // Adjustment activities - determine type based on delta
        if (log.delta > 0) {
          type = 'stock_in';
          description = `Stocked in ${log.delta} units of ${log.products.name}`;
        } else if (log.delta < 0) {
          type = 'stock_out';
          description = `Removed ${Math.abs(log.delta)} units of ${log.products.name}`;
        } else {
          type = 'adjustment';
          description = `No quantity change for ${log.products.name}`;
        }
      } else {
        // Fallback for any unexpected logType values
        type = log.delta > 0 ? 'stock_in' : log.delta < 0 ? 'stock_out' : 'adjustment';
        description = `${log.delta > 0 ? 'Added' : 'Removed'} ${Math.abs(log.delta)} units of ${log.products.name}`;
      }

      return {
        id: log.id.toString(),
        timestamp: log.changeTime,
        type,
        description,
        user: {
          id: log.users.id,
          username: log.users.username
        },
        product: {
          id: log.products.id,
          name: log.products.name
        },
        location: {
          id: log.locations?.id || 1,
          name: log.locations?.name || 'Default'
        },
        metadata: {
          quantityChange: log.delta,
          logType: log.logType
        }
      };
    });

    const response: ActivityResponse = {
      activities,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error fetching activity:", error);
    return NextResponse.json(
      { error: "Failed to fetch activity" },
      { status: 500 }
    );
  }
}