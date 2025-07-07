import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { Product, product_locations, Location } from '@prisma/client';

export const dynamic = 'force-dynamic';

interface ProductWithLocations {
  id: number;
  name: string;
  baseName: string;
  variant: string | null;
  locations: {
    locationId: number;
    locationName: string;
    quantity: number;
  }[];
  totalQuantity: number;
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

    // Build where clause for search
    const whereClause: any = {};
    if (search) {
      whereClause.OR = [
        { name: { contains: search } },
        { baseName: { contains: search } },
        { variant: { contains: search } },
      ];
    }

    // Get total count for pagination
    const total = await prisma.product.count({ where: whereClause });

    // Get products with their location quantities
    const products = await prisma.product.findMany({
      where: whereClause,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: [
        { baseName: 'asc' },
        { variant: 'asc' },
      ],
      include: {
        product_locations: {
          include: {
            locations: true,
          },
          // Always include all locations, don't filter
        },
      },
    });

    // Transform data to include location breakdown
    const transformedProducts: ProductWithLocations[] = products.map((product: Product & {
      product_locations: (product_locations & {
        locations: Location;
      })[];
    }) => {
      const locations = product.product_locations.map((pl) => ({
        locationId: pl.locationId,
        locationName: pl.locations.name,
        quantity: pl.quantity,
      }));

      const totalQuantity = locations.reduce((sum: number, loc) => sum + loc.quantity, 0);

      return {
        id: product.id,
        name: product.name,
        baseName: product.baseName || '',
        variant: product.variant,
        locations: locations.sort((a, b) => b.quantity - a.quantity), // Sort by quantity desc
        totalQuantity,
      };
    });

    return NextResponse.json({
      products: transformedProducts,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        hasMore: page < Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error('Error fetching inventory variants:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inventory' },
      { status: 500 }
    );
  }
}