import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
        name: { contains: search }
      };
    }

    if (userFilter && userFilter !== "all") {
      whereClause.users = {
        username: userFilter
      };
    }

    if (locationFilter && locationFilter !== "all") {
      whereClause.locations = {
        name: locationFilter
      };
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
      orderBy: { changeTime: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // Transform data
    const transformedLogs = logs.map(log => ({
      id: log.id,
      timestamp: log.changeTime.toISOString(),
      productName: log.products.name,
      userName: log.users.username,
      locationName: log.locations?.name || 'Unknown',
      delta: log.delta,
      logType: log.logType,
    }));

    return NextResponse.json({
      logs: transformedLogs,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return NextResponse.json(
      { error: "Failed to fetch logs" },
      { status: 500 }
    );
  }
}