import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getCurrentQuantity } from '@/lib/inventory';
import type { ProductInventoryHistory } from '@/types/inventory';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
    }

    const searchParams = request.nextUrl.searchParams;
    const locationId = searchParams.get('locationId');
    const limit = Math.min(1000, parseInt(searchParams.get('limit') || '100'));

    // Get product (excluding soft deleted)
    const product = await prisma.product.findFirst({
      where: { 
        id: productId,
        deletedAt: null,
      },
    });

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // Get location (default to first location if not specified)
    let location;
    if (locationId) {
      location = await prisma.location.findUnique({
        where: { id: parseInt(locationId) },
      });
    } else {
      location = await prisma.location.findFirst({
        orderBy: { id: 'asc' },
      });
    }

    if (!location) {
      return NextResponse.json({ error: 'Location not found' }, { status: 404 });
    }

    // Get current quantity
    const currentQuantity = await getCurrentQuantity(product.id, location.id);

    // Get history
    const history = await prisma.inventory_logs.findMany({
      where: {
        productId: product.id,
        locationId: location.id,
      },
      include: {
        users: true,
        products: true,
        locations: true,
      },
      orderBy: {
        changeTime: 'desc',
      },
      take: limit,
    });

    const response: ProductInventoryHistory = {
      product,
      location,
      currentQuantity,
      history,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching product inventory history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch product inventory history' },
      { status: 500 }
    );
  }
}