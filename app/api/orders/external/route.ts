import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { validateCSRFToken } from '@/lib/csrf';
import { 
  ExternalOrderStatus, 
  ExternalOrderListItem,
  mockOrders,
  mockOrderItems,
  orderLocks
} from '@/types/external-orders';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const locationId = searchParams.get('locationId');

    // Filter orders that are in PROCESSING status and not packed
    let orders = mockOrders.filter(order => 
      order.status === ExternalOrderStatus.PROCESSING && !order.packedAt
    );

    // If locationId is provided, apply location-based filtering
    // (In real implementation, this would filter based on order location/warehouse)
    if (locationId) {
      // For now, we'll just validate that locationId is a number
      const locId = parseInt(locationId);
      if (isNaN(locId)) {
        return NextResponse.json(
          { error: 'Invalid locationId parameter' },
          { status: 400 }
        );
      }
      // In real implementation, filter orders by location
    }

    // Map orders to include item counts
    const ordersWithCounts: ExternalOrderListItem[] = orders.map(order => {
      const orderItems = mockOrderItems.filter(item => item.orderId === order.id);
      const unmappedItems = orderItems.filter(item => !item.productId);
      
      // Check if order is locked
      const lock = orderLocks.get(order.id);
      const isLocked = lock && lock.expiresAt > new Date();
      
      return {
        ...order,
        itemCount: orderItems.length,
        unmappedItemCount: unmappedItems.length,
        ...(isLocked && { lockedBy: lock.userId, lockedUntil: lock.expiresAt })
      };
    });

    // Sort by order date (newest first)
    ordersWithCounts.sort((a, b) => b.orderDate.getTime() - a.orderDate.getTime());

    return NextResponse.json({
      orders: ordersWithCounts,
      total: ordersWithCounts.length,
    });
  } catch (error) {
    console.error('Error fetching external orders:', error);
    return NextResponse.json(
      { error: 'Failed to fetch external orders' },
      { status: 500 }
    );
  }
}