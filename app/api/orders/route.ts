import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrdersResponse } from "@/types/orders";

// Mock data for now - replace with actual database queries
const mockOrders = [
  {
    id: "1",
    orderNumber: "ORD-2024-001",
    createdAt: new Date(Date.now() - 1000 * 60 * 5), // 5 minutes ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 5),
    status: 'pending' as const,
    items: [
      {
        id: "1-1",
        productId: 1,
        productName: "Widget A",
        quantity: 5,
        price: 10.99,
        subtotal: 54.95,
      },
      {
        id: "1-2",
        productId: 2,
        productName: "Gadget B",
        quantity: 3,
        price: 24.99,
        subtotal: 74.97,
      },
    ],
    total: 129.92,
  },
  {
    id: "2",
    orderNumber: "ORD-2024-002",
    createdAt: new Date(Date.now() - 1000 * 60 * 15), // 15 minutes ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 15),
    status: 'in_progress' as const,
    items: [
      {
        id: "2-1",
        productId: 3,
        productName: "Tool C",
        quantity: 10,
        price: 5.99,
        subtotal: 59.90,
      },
    ],
    total: 59.90,
    lockedBy: {
      userId: "user-123",
      userName: "John Doe",
      lockedAt: new Date(Date.now() - 1000 * 60 * 2), // 2 minutes ago
    },
  },
  {
    id: "3",
    orderNumber: "ORD-2024-003",
    createdAt: new Date(Date.now() - 1000 * 60 * 30), // 30 minutes ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 30),
    status: 'pending' as const,
    items: [
      {
        id: "3-1",
        productId: 4,
        productName: "Component D",
        quantity: 20,
        price: 2.50,
        subtotal: 50.00,
      },
      {
        id: "3-2",
        productId: 5,
        productName: "Part E",
        quantity: 15,
        price: 3.75,
        subtotal: 56.25,
      },
      {
        id: "3-3",
        productId: 6,
        productName: "Item F",
        quantity: 8,
        price: 8.99,
        subtotal: 71.92,
      },
    ],
    total: 178.17,
  },
];

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const cursor = searchParams.get("cursor");
    const limit = parseInt(searchParams.get("limit") || "10");
    const status = searchParams.get("status");

    // Filter orders based on status if provided
    let filteredOrders = mockOrders;
    if (status && status !== "all") {
      filteredOrders = mockOrders.filter(order => order.status === status);
    }

    // Simple pagination logic (would be replaced with proper DB queries)
    const startIndex = cursor ? parseInt(cursor) : 0;
    const endIndex = startIndex + limit;
    const paginatedOrders = filteredOrders.slice(startIndex, endIndex);
    const hasMore = endIndex < filteredOrders.length;

    const response: OrdersResponse = {
      orders: paginatedOrders,
      hasMore,
      nextCursor: hasMore ? endIndex.toString() : undefined,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error fetching orders:", error);
    return NextResponse.json(
      { error: "Failed to fetch orders" },
      { status: 500 }
    );
  }
}