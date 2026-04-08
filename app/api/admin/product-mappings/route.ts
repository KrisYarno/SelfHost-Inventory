import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const searchParams = request.nextUrl.searchParams;
  const integrationId = searchParams.get("integrationId");
  const search = searchParams.get("search");
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "50");
  const skip = (page - 1) * pageSize;

  // Build where clause
  const where: any = {};

  if (integrationId) {
    where.integrationId = integrationId;
  }

  if (search) {
    where.OR = [
      { externalTitle: { contains: search } },
      { externalSku: { contains: search } },
      { internalProduct: { name: { contains: search } } },
    ];
  }

  const [productLinks, total] = await Promise.all([
    prisma.productLink.findMany({
      where,
      include: {
        internalProduct: {
          select: {
            id: true,
            name: true,
            baseName: true,
            variant: true,
          },
        },
        integration: {
          select: {
            id: true,
            name: true,
            platform: true,
            storeUrl: true,
          },
        },
      },
      orderBy: [{ integration: { name: "asc" } }, { createdAt: "desc" }],
      skip,
      take: pageSize,
    }),
    prisma.productLink.count({ where }),
  ]);

  return NextResponse.json({
    mappings: productLinks,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const linkId = searchParams.get("linkId");

  if (!linkId) {
    return NextResponse.json(
      { error: "Link ID is required" },
      { status: 400 }
    );
  }

  const existingLink = await prisma.productLink.findUnique({
    where: { id: linkId },
  });

  if (!existingLink) {
    return NextResponse.json(
      { error: "Product link not found" },
      { status: 404 }
    );
  }

  // Delete the product link. With onDelete: SetNull, the FK on ExternalOrderItem
  // will be nulled automatically by the database. But we also need to set isMapped = false.
  await prisma.$transaction(async (tx) => {
    // Set isMapped = false on affected order items
    await tx.externalOrderItem.updateMany({
      where: { productLinkId: linkId },
      data: { isMapped: false },
    });

    // Delete the product link
    await tx.productLink.delete({
      where: { id: linkId },
    });
  });

  return NextResponse.json({
    message: "Product mapping deleted successfully",
  });
});
