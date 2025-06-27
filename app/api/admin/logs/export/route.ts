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

    // Get all matching logs (no pagination for export)
    const logs = await prisma.inventory_logs.findMany({
      where: whereClause,
      include: {
        users: true,
        products: true,
        locations: true,
      },
      orderBy: { changeTime: 'desc' },
    });

    // Build CSV content
    const headers = ['Timestamp', 'Product Name', 'User', 'Location', 'Type', 'Change (Delta)'];
    const rows = [headers];

    logs.forEach(log => {
      rows.push([
        log.changeTime.toISOString(),
        log.products.name,
        log.users.username,
        log.locations?.name || 'Unknown',
        log.logType,
        log.delta.toString(),
      ]);
    });

    // Convert to CSV string
    const csvContent = rows
      .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
      .join('\n');

    // Return as downloadable file
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="inventory-logs-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  } catch (error) {
    console.error('Error exporting logs:', error);
    return NextResponse.json(
      { error: "Failed to export logs" },
      { status: 500 }
    );
  }
}