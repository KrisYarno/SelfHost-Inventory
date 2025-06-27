import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// GET /api/admin/products/thresholds - Get all products with thresholds
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get all products with their current stock levels
    const products = await prisma.product.findMany({
      select: {
        id: true,
        name: true,
        lowStockThreshold: true,
        product_locations: {
          select: {
            quantity: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    // Calculate current stock for each product
    const productsWithStock = products.map(product => {
      const currentStock = product.product_locations.reduce(
        (sum, location) => sum + location.quantity,
        0
      );
      
      return {
        id: product.id,
        name: product.name,
        lowStockThreshold: product.lowStockThreshold,
        currentStock,
      };
    });

    return NextResponse.json(productsWithStock);
  } catch (error) {
    console.error('Error fetching product thresholds:', error);
    return NextResponse.json(
      { error: 'Failed to fetch thresholds' },
      { status: 500 }
    );
  }
}

// PATCH /api/admin/products/thresholds - Bulk update thresholds
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { updates } = body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json(
        { error: 'No updates provided' },
        { status: 400 }
      );
    }

    // Validate updates
    for (const update of updates) {
      if (!update.id || typeof update.lowStockThreshold !== 'number') {
        return NextResponse.json(
          { error: 'Invalid update format' },
          { status: 400 }
        );
      }
      if (update.lowStockThreshold < 0) {
        return NextResponse.json(
          { error: 'Threshold cannot be negative' },
          { status: 400 }
        );
      }
    }

    // Perform bulk update using transactions
    const updatePromises = updates.map(update =>
      prisma.product.update({
        where: { id: update.id },
        data: { lowStockThreshold: update.lowStockThreshold },
      })
    );

    await prisma.$transaction(updatePromises);

    return NextResponse.json({
      success: true,
      updatedCount: updates.length,
    });
  } catch (error) {
    console.error('Error updating thresholds:', error);
    return NextResponse.json(
      { error: 'Failed to update thresholds' },
      { status: 500 }
    );
  }
}