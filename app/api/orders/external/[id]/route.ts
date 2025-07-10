import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { 
  ExternalOrderWithItems,
  mockOrders,
  mockOrderItems,
  orderLocks
} from '@/types/external-orders';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const orderId = params.id;

    // Find the order
    const order = mockOrders.find(o => o.id === orderId);
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Get order items
    const items = mockOrderItems.filter(item => item.orderId === orderId);

    // For each item, check if the product exists in our system
    const itemsWithMapping = await Promise.all(items.map(async (item) => {
      if (item.productId) {
        // Verify the product still exists
        const product = await prisma.product.findUnique({
          where: { id: item.productId },
          select: { 
            id: true, 
            name: true, 
            baseName: true,
            variant: true,
            unit: true,
            deletedAt: true 
          }
        });
        
        return {
          ...item,
          mappedProduct: product && !product.deletedAt ? product : null,
          isMapped: !!(product && !product.deletedAt)
        };
      }
      
      return {
        ...item,
        mappedProduct: null,
        isMapped: false
      };
    }));

    // Check if order is locked
    const lock = orderLocks.get(orderId);
    const activeLock = lock && lock.expiresAt > new Date() ? lock : undefined;

    const response: ExternalOrderWithItems = {
      ...order,
      items: itemsWithMapping,
      itemCount: items.length,
      ...(activeLock && { lock: activeLock })
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching external order:', error);
    return NextResponse.json(
      { error: 'Failed to fetch external order' },
      { status: 500 }
    );
  }
}