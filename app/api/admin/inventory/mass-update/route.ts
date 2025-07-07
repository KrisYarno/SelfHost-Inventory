import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = 'force-dynamic';

// GET - Fetch all products with current inventory levels
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get("search") || "";
    const category = searchParams.get("category") || "all";

    // Build where clause - exclude soft deleted products
    const whereClause: any = {
      deletedAt: null,
    };
    if (search) {
      whereClause.OR = [
        { name: { contains: search } },
        { baseName: { contains: search } },
        { variant: { contains: search } },
      ];
    }
    if (category !== "all") {
      whereClause.baseName = category === "Uncategorized" ? null : category;
    }

    // Get all products with their current quantities at each location
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
        { variant: 'asc' },
      ],
    });

    // Get all locations
    const locations = await prisma.location.findMany({
      orderBy: { name: 'asc' },
    });

    // Transform data for the UI
    const transformedProducts = products.map(product => {
      // Create a map of current quantities by location
      const locationQuantities = new Map(
        product.product_locations.map(pl => [pl.locationId, pl.quantity])
      );

      // Create location entries for each product
      const productLocations = locations.map(location => ({
        locationId: location.id,
        locationName: location.name,
        currentQuantity: locationQuantities.get(location.id) || 0,
        newQuantity: null,
        delta: 0,
        hasChanged: false,
      }));

      return {
        productId: product.id,
        productName: product.name,
        baseName: product.baseName || 'Uncategorized',
        variant: product.variant,
        locations: productLocations,
      };
    });

    return NextResponse.json({
      products: transformedProducts,
      locations: locations.map(loc => ({ id: loc.id, name: loc.name })),
      totalProducts: transformedProducts.length,
      totalChanges: 0,
    });
  } catch (error) {
    console.error('Error fetching mass update data:', error);
    return NextResponse.json(
      { error: "Failed to fetch inventory data" },
      { status: 500 }
    );
  }
}

// POST - Save mass inventory updates
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { changes, note } = body;

    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      return NextResponse.json(
        { error: "No changes provided" },
        { status: 400 }
      );
    }

    // Process all changes in a single transaction
    const result = await prisma.$transaction(async (tx) => {
      const logs = [];

      for (const change of changes) {
        const { productId, locationId, newQuantity, delta } = change;

        // Skip if no actual change
        if (delta === 0) continue;

        // Create inventory log entry
        const log = await tx.inventory_logs.create({
          data: {
            userId: parseInt(session.user.id),
            productId,
            locationId,
            delta,
            changeTime: new Date(),
            logType: 'ADJUSTMENT',
          },
        });

        // Update or create product_locations entry with absolute quantity
        await tx.product_locations.upsert({
          where: {
            productId_locationId: {
              productId,
              locationId,
            },
          },
          update: {
            quantity: newQuantity,
          },
          create: {
            productId,
            locationId,
            quantity: newQuantity,
          },
        });

        logs.push(log);
      }

      return {
        logsCreated: logs.length,
        note,
      };
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Error saving mass update:', error);
    return NextResponse.json(
      { error: "Failed to save inventory updates" },
      { status: 500 }
    );
  }
}