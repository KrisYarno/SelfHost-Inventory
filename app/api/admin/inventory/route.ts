import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get("search") || "";

    // Build where clause for search
    const whereClause = search
      ? {
          OR: [
            { name: { contains: search } },
            { baseName: { contains: search } },
            { variant: { contains: search } },
          ],
        }
      : {};

    // Get all products with their location quantities
    const products = await prisma.product.findMany({
      where: whereClause,
      include: {
        product_locations: {
          include: {
            locations: true,
          },
        },
      },
      orderBy: [
        { baseName: 'asc' },
        { numericValue: 'asc' },
        { variant: 'asc' },
      ],
    });

    // Transform data to include location breakdown
    const productsWithInventory = products.map(product => {
      const locations = product.product_locations.map(pl => ({
        id: pl.locationId,
        name: pl.locations.name,
        quantity: pl.quantity,
      }));

      const totalQuantity = locations.reduce((sum, loc) => sum + loc.quantity, 0);

      return {
        id: product.id,
        name: product.name,
        baseName: product.baseName,
        variant: product.variant,
        totalQuantity,
        locations: locations.sort((a, b) => a.name.localeCompare(b.name)),
      };
    });

    return NextResponse.json({
      products: productsWithInventory,
      totalProducts: productsWithInventory.length,
    });
  } catch (error) {
    console.error('Error fetching inventory overview:', error);
    return NextResponse.json(
      { error: "Failed to fetch inventory data" },
      { status: 500 }
    );
  }
}