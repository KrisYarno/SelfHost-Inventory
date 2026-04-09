import { NextRequest, NextResponse } from "next/server";
import { requireApproved, requireCompanyMembership, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import type { ExternalOrdersResponse, PlatformType, InternalOrderStatus } from "@/types/external-orders";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

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

  if (companyId) {
    // P0-4 extension: verify user belongs to the requested company. Previously
    // any approved user could pass an arbitrary companyId and see cross-company
    // orders. Admins bypass via requireCompanyMembership.
    await requireCompanyMembership(user.id, companyId, user.isAdmin);
    where.companyId = companyId;
  } else {
    const userCompanies = await prisma.userCompany.findMany({
      where: { userId: user.id },
      select: { companyId: true },
    });

    if (userCompanies.length === 0) {
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

  if (platform && platform !== "ALL") {
    where.integration = { platform };
  }

  if (status && status !== "all") {
    where.internalStatus = status;
  }

  if (search) {
    where.orderNumber = { contains: search };
  }

  const total = await prisma.externalOrder.count({ where });

  const orders = await prisma.externalOrder.findMany({
    where,
    include: {
      company: {
        select: { id: true, name: true, slug: true },
      },
      integration: {
        select: { id: true, platform: true, name: true, storeUrl: true },
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
    orderBy: { externalCreatedAt: "desc" },
    skip: cursor ? undefined : (page - 1) * pageSize,
    take: pageSize + 1,
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1,
    }),
  });

  const hasMore = orders.length > pageSize;
  const resultOrders = hasMore ? orders.slice(0, pageSize) : orders;
  const nextCursor = hasMore ? resultOrders[resultOrders.length - 1].id : undefined;

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
});
