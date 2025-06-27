import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { createInventoryAdjustment } from '@/lib/inventory';
import { inventory_logs_logType } from '@prisma/client';
import type { StockInRequest } from '@/types/inventory';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: StockInRequest = await request.json();
    
    // Validate request
    if (!body.productId || !body.locationId || !body.quantity) {
      return NextResponse.json(
        { error: 'Missing required fields: productId, locationId, quantity' },
        { status: 400 }
      );
    }

    if (body.quantity <= 0) {
      return NextResponse.json(
        { error: 'Quantity must be greater than zero' },
        { status: 400 }
      );
    }

    // Create the stock-in adjustment
    const result = await createInventoryAdjustment(
      session.user.id,
      body.productId,
      body.locationId,
      body.quantity, // Positive for adding stock
      inventory_logs_logType.ADJUSTMENT
    );

    return NextResponse.json({
      success: true,
      log: result,
    });
  } catch (error) {
    console.error('Error creating stock-in:', error);
    return NextResponse.json(
      { error: 'Failed to create stock-in' },
      { status: 500 }
    );
  }
}