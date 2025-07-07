import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get("search") || "";
    const page = parseInt(searchParams.get("page") || "1");
    const pageSize = parseInt(searchParams.get("pageSize") || "25");
    const sortBy = searchParams.get("sortBy") || "name";
    const sortOrder = searchParams.get("sortOrder") || "asc";
    const locationId = searchParams.get("locationId");

    // Build where clause - exclude soft deleted products
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

    // Execute queries in parallel
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
                select: {
                  quantity: true,
                  locationId: true,
                },
              },
        },
        orderBy: {
          [sortBy]: sortOrder,
        },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    // Transform products to include quantity
    const productsWithQuantity = products.map(product => {
      let currentQuantity = 0;
      
      if (locationId) {
        // Single location quantity
        currentQuantity = product.product_locations[0]?.quantity || 0;
      } else {
        // Total across all locations
        currentQuantity = product.product_locations.reduce(
          (sum, pl) => sum + pl.quantity,
          0
        );
      }

      return {
        ...product,
        currentQuantity,
        // Remove the raw product_locations from response
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
  } catch (error) {
    console.error("Error fetching products:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 }
    );
  }
}