import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (
  _request: NextRequest,
  { params }: { params: { orderId: string } }
) => {
  const { user } = await requireApproved();

  const order = await prisma.externalOrder.findUnique({
    where: { id: params.orderId },
    include: {
      company: {
        select: { id: true, name: true, slug: true },
      },
      integration: {
        select: { id: true, platform: true, name: true, storeUrl: true, fulfillmentPushEnabled: true },
      },
      items: {
        include: {
          productLink: {
            include: {
              internalProduct: {
                select: { id: true, name: true, baseName: true, variant: true },
              },
            },
          },
        },
      },
      fulfilledByUser: {
        select: { id: true, username: true, email: true },
      },
    },
  });

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  // Amendment 9: Verify user has access to this order's company
  if (!user.isAdmin) {
    const membership = await prisma.userCompany.findFirst({
      where: { userId: user.id, companyId: order.companyId },
    });
    if (!membership) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
  }

  // Serialize Decimal fields to numbers (matching the list endpoint)
  const serialized = {
    ...order,
    total: Number(order.total),
    items: order.items?.map((item: any) => ({
      ...item,
      price: Number(item.price),
    })),
  };

  return NextResponse.json(serialized);
});
