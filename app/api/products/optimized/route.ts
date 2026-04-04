import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const search = searchParams.get("search") || "";
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "25");
  const sortByParam = searchParams.get("sortBy");
  const allowedSorts = ["name", "baseName", "numericValue", "baseNameNumeric"] as const;
  const sortBy = allowedSorts.includes(sortByParam as any)
    ? (sortByParam as (typeof allowedSorts)[number])
    : "baseNameNumeric";
  const sortOrder = (searchParams.get("sortOrder") || "asc") as "asc" | "desc";
  const locationId = searchParams.get("locationId");
  const orderBy: Prisma.ProductOrderByWithRelationInput[] = [];

  if (sortBy === "baseNameNumeric") {
    orderBy.push({ baseName: sortOrder }, { numericValue: sortOrder }, { variant: sortOrder });
  } else if (sortBy === "name") {
    orderBy.push({ name: sortOrder });
  } else if (sortBy === "baseName") {
    orderBy.push({ baseName: sortOrder });
  } else if (sortBy === "numericValue") {
    orderBy.push({ numericValue: sortOrder });
  }

  orderBy.push({ name: "asc" });

  const where: Prisma.ProductWhereInput = {
    deletedAt: null,
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { baseName: { contains: search } },
            { variant: { contains: search } },
          ],
        }
      : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        product_locations: locationId
          ? {
              where: { locationId: parseInt(locationId) },
              select: { quantity: true },
            }
          : {
              select: { quantity: true, locationId: true },
            },
      },
      orderBy,
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  const productsWithQuantity = products.map((product) => {
    let currentQuantity = 0;

    if (locationId) {
      currentQuantity = product.product_locations[0]?.quantity || 0;
    } else {
      currentQuantity = product.product_locations.reduce((sum, pl) => sum + pl.quantity, 0);
    }

    return {
      ...product,
      currentQuantity,
      product_locations: undefined,
    };
  });

  return NextResponse.json({
    products: productsWithQuantity,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});
