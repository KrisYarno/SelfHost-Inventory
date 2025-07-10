import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { validateCSRFToken } from '@/lib/csrf';
import { 
  OrderLock,
  mockOrders,
  orderLocks
} from '@/types/external-orders';

export const dynamic = 'force-dynamic';

// Lock duration in minutes
const LOCK_DURATION_MINUTES = 15;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const orderId = params.id;
    const userId = parseInt(session.user.id);

    // Check if order exists
    const order = mockOrders.find(o => o.id === orderId);
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Check if order is already packed
    if (order.packedAt) {
      return NextResponse.json(
        { error: 'Order has already been packed' },
        { status: 400 }
      );
    }

    // Check for existing lock
    const existingLock = orderLocks.get(orderId);
    if (existingLock && existingLock.expiresAt > new Date()) {
      // Check if locked by another user
      if (existingLock.userId !== userId) {
        return NextResponse.json(
          { 
            error: 'Order is already locked by another user',
            lockedBy: existingLock.userId,
            expiresAt: existingLock.expiresAt
          },
          { status: 409 }
        );
      }
      
      // If locked by same user, extend the lock
      existingLock.expiresAt = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000);
      return NextResponse.json({
        message: 'Lock extended',
        lock: existingLock
      });
    }

    // Create new lock
    const newLock: OrderLock = {
      orderId,
      userId,
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000)
    };

    orderLocks.set(orderId, newLock);

    return NextResponse.json({
      message: 'Order locked successfully',
      lock: newLock
    });
  } catch (error) {
    console.error('Error locking order:', error);
    return NextResponse.json(
      { error: 'Failed to lock order' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const orderId = params.id;
    const userId = parseInt(session.user.id);

    // Check for existing lock
    const existingLock = orderLocks.get(orderId);
    if (!existingLock) {
      return NextResponse.json(
        { error: 'No lock found for this order' },
        { status: 404 }
      );
    }

    // Check if lock is owned by current user
    if (existingLock.userId !== userId) {
      return NextResponse.json(
        { error: 'You do not own this lock' },
        { status: 403 }
      );
    }

    // Remove the lock
    orderLocks.delete(orderId);

    return NextResponse.json({
      message: 'Lock removed successfully'
    });
  } catch (error) {
    console.error('Error removing order lock:', error);
    return NextResponse.json(
      { error: 'Failed to remove order lock' },
      { status: 500 }
    );
  }
}