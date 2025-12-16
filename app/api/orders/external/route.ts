import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type { ExternalOrdersResponse, PlatformType, InternalOrderStatus } from "@/types/external-orders";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders/external
 * Fetch external orders with filtering and pagination
 *
 * Query params:
 * - companyId: Filter by company
 * - platform: Filter by platform (SHOPIFY, WOOCOMMERCE, ALL)
 * - status: Filter by internal status (pending, processing, fulfilled, cancelled, all)
 * - search: Search by order number
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20)
 * - cursor: Cursor for cursor-based pagination (optional)
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const companyId = searchParams.get("companyId");
    const platform = searchParams.get("platform") as PlatformType | "ALL" | null;
    const status = searchParams.get("status") as InternalOrderStatus | "all" | null;
    const search = searchParams.get("search");
    const page = parseInt(searchParams.get("page") || "1");
    const pageSize = parseInt(searchParams.get("pageSize") || "20");
    const cursor = searchParams.get("cursor");

    // Build where clause
    const where: any = {};

    // Company filter (required in most cases)
    if (companyId) {
      where.companyId = companyId;
    } else {
      // Get user's companies if no specific company is selected
      const userCompanies = await prisma.userCompany.findMany({
        where: { userId: session.user.id },
        select: { companyId: true },
      });

      if (userCompanies.length === 0) {
        // User has no companies, return empty result
        return NextResponse.json({
          orders: [],
          total: 0,
          page: 1,
          pageSize,
          hasMore: false,
        });
      }

      where.companyId = {
        in: userCompanies.map((uc) => uc.companyId),
      };
    }

    // Platform filter
    if (platform && platform !== "ALL") {
      where.integration = {
        platform,
      };
    }

    // Status filter
    if (status && status !== "all") {
      where.internalStatus = status;
    }

    // Search by order number
    if (search) {
      where.orderNumber = {
        contains: search,
      };
    }

    // Get total count for pagination
    const total = await prisma.externalOrder.count({ where });

    // Fetch orders with pagination
    const orders = await prisma.externalOrder.findMany({
      where,
      include: {
        company: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        integration: {
          select: {
            id: true,
            platform: true,
            name: true,
            storeUrl: true,
          },
        },
        items: {
          include: {
            productLink: {
              include: {
                internalProduct: {
                  select: {
                    id: true,
                    name: true,
                    baseName: true,
                    variant: true,
                  },
                },
              },
            },
          },
        },
        fulfilledByUser: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
      },
      orderBy: {
        externalCreatedAt: "desc",
      },
      skip: cursor ? undefined : (page - 1) * pageSize,
      take: pageSize + 1, // Take one extra to determine if there are more
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1, // Skip the cursor
      }),
    });

    // Determine if there are more results
    const hasMore = orders.length > pageSize;
    const resultOrders = hasMore ? orders.slice(0, pageSize) : orders;
    const nextCursor = hasMore ? resultOrders[resultOrders.length - 1].id : undefined;

    // Convert Decimal to number for JSON serialization
    const serializedOrders = resultOrders.map((order) => ({
      ...order,
      total: Number(order.total),
      items: order.items?.map((item) => ({
        ...item,
        price: Number(item.price),
      })),
    }));

    const response: ExternalOrdersResponse = {
      orders: serializedOrders as any,
      total,
      page,
      pageSize,
      hasMore,
      nextCursor,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error fetching external orders:", error);
    return NextResponse.json(
      { error: "Failed to fetch external orders" },
      { status: 500 }
    );
  }
}
