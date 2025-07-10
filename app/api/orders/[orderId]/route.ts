import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
      notes: "Customer requested gift wrapping",
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