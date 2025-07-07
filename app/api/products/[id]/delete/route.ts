import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    
    // Check if user is admin
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
    }

    // Check if product exists and isn't already deleted
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { 
        id: true, 
        name: true, 
        deletedAt: true,
        product_locations: {
          select: {
            quantity: true,
            locations: {
              select: { name: true }
            }
          }
        }
      }
    });

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    if (product.deletedAt) {
      return NextResponse.json({ error: 'Product is already deleted' }, { status: 400 });
    }

    // Get current inventory across all locations
    const totalInventory = product.product_locations.reduce((sum, loc) => sum + loc.quantity, 0);

    // Soft delete the product
    const deletedProduct = await prisma.product.update({
      where: { id: productId },
      data: {
        deletedAt: new Date(),
        deletedBy: parseInt(session.user.id)
      }
    });

    // Log the deletion in inventory logs for audit trail
    await prisma.inventory_logs.create({
      data: {
        userId: parseInt(session.user.id),
        productId: productId,
        delta: 0,
        changeTime: new Date(),
        logType: 'ADJUSTMENT',
        // Add a note in the future if you add a notes field to inventory_logs
      }
    });

    return NextResponse.json({
      success: true,
      message: `Product "${product.name}" has been deleted`,
      productName: product.name,
      hadInventory: totalInventory > 0,
      inventoryAmount: totalInventory
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    return NextResponse.json(
      { error: 'Failed to delete product' },
      { status: 500 }
    );
  }
}