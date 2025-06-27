import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { 
  createInventoryAdjustment,
  validateStockAvailability 
} from '@/lib/inventory';
import { inventory_logs_logType } from '@prisma/client';
import type { InventoryAdjustmentRequest } from '@/types/inventory';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: InventoryAdjustmentRequest = await request.json();
    
    // Validate request
    if (!body.productId || !body.locationId || body.delta === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: productId, locationId, delta' },
        { status: 400 }
      );
    }

    if (body.delta === 0) {
      return NextResponse.json(
        { error: 'Delta cannot be zero' },
        { status: 400 }
      );
    }

    // If removing stock, validate availability
    if (body.delta < 0) {
      const validation = await validateStockAvailability(
        body.productId,
        body.locationId,
        Math.abs(body.delta)
      );

      if (!validation.isValid) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 }
        );
      }
    }

    // Create the adjustment
    const log = await createInventoryAdjustment(
      session.user.id,
      body.productId,
      body.locationId,
      body.delta,
      body.logType || inventory_logs_logType.ADJUSTMENT
    );

    return NextResponse.json({
      success: true,
      log,
    });
  } catch (error) {
    console.error('Error creating inventory adjustment:', error);
    return NextResponse.json(
      { error: 'Failed to create inventory adjustment' },
      { status: 500 }
    );
  }
}