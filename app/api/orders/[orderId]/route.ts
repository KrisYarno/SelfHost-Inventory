import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { Order } from "@/types/orders";

// Mock order details - replace with actual database query
const getOrderById = (orderId: string): Order | null => {
  const mockOrders: Order[] = [
    {
      id: "1",
      orderNumber: "ORD-2024-001",
      createdAt: new Date(Date.now() - 1000 * 60 * 5),
      updatedAt: new Date(Date.now() - 1000 * 60 * 5),
      status: 'pending',
      items: [
        {
          id: "1-1",
          name: "Widget A",
          quantity: 5,
          currentStock: 100,
          productId: 1,
          isMapped: true,
        },
        {
          id: "1-2",
          name: "Gadget B",
          quantity: 3,
          currentStock: 50,
          productId: 2,
          isMapped: true,
        },
      ],
    },
  ];
  
  return mockOrders.find(order => order.id === orderId) || null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: { orderId: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const order = getOrderById(params.orderId);
    
    if (!order) {
      return NextResponse.json(
        { error: "Order not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(order);
  } catch (error) {
    console.error("Error fetching order:", error);
    return NextResponse.json(
      { error: "Failed to fetch order" },
      { status: 500 }
    );
  }
}