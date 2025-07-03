import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { getCurrentInventoryLevelsFast } from '@/lib/inventory-fast';
import prisma from '@/lib/prisma';
import type { CurrentInventoryLevel } from '@/types/inventory';

export const dynamic = 'force-dynamic';

interface GroupedInventory {
  baseName: string;
  items: CurrentInventoryLevel[];
  totalQuantity: number;
  variantCount: number;
  locationCount: number;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const locationId = searchParams.get('locationId');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '12');
    const search = searchParams.get('search') || '';

    // Get all inventory levels (we'll paginate after grouping)
    const allInventory = await getCurrentInventoryLevelsFast(
      locationId ? parseInt(locationId) : undefined
    );
    
    // If no location is specified, we need to get inventory from all locations
    if (!locationId) {
      // Group by product to get all locations for each product
      const productLocations = await prisma.product_locations.findMany({
        include: {
          products: true,
          locations: true,
        },
      });
      
      // Convert to CurrentInventoryLevel format
      const allInventoryWithLocations: CurrentInventoryLevel[] = productLocations.map(pl => ({
        productId: pl.productId,
        product: pl.products,
        locationId: pl.locationId,
        location: pl.locations,
        quantity: pl.quantity,
        lastUpdated: new Date(0),
      }));
      
      // Use this for grouping instead
      allInventory.length = 0;
      allInventory.push(...allInventoryWithLocations);
    }

    // Group inventory by baseName
    const groups = new Map<string, CurrentInventoryLevel[]>();
    
    allInventory.forEach((item) => {
      const key = item.product.baseName || item.product.name;
      
      // Apply search filter if provided
      if (search && !key.toLowerCase().includes(search.toLowerCase())) {
        return;
      }
      
      const existing = groups.get(key) || [];
      groups.set(key, [...existing, item]);
    });

    // Convert to array and calculate aggregated data
    const groupedInventory: GroupedInventory[] = Array.from(groups.entries()).map(([baseName, items]) => {
      const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
      const variants = new Set(items.map(item => item.product.variant).filter(Boolean));
      
      return {
        baseName,
        items,
        totalQuantity,
        variantCount: variants.size,
        locationCount: new Set(items.map(item => item.locationId)).size,
      };
    });

    // Sort groups by baseName
    groupedInventory.sort((a, b) => a.baseName.localeCompare(b.baseName));

    // Paginate the grouped results
    const total = groupedInventory.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const paginatedGroups = groupedInventory.slice(start, end);

    return NextResponse.json({
      groups: paginatedGroups,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
      asOf: new Date(),
    });
  } catch (error) {
    console.error('Error fetching grouped inventory:', error);
    return NextResponse.json(
      { error: 'Failed to fetch grouped inventory' },
      { status: 500 }
    );
  }
}