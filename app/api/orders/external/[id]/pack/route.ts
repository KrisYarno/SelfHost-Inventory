import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { validateCSRFToken } from '@/lib/csrf';
import { 
  ExternalOrderStatus,
  PackOrderRequest,
  mockOrders,
  mockOrderItems,
  orderLocks
} from '@/types/external-orders';
import { createInventoryAdjustment, validateStockAvailability } from '@/lib/inventory';
import { inventory_logs_logType } from '@prisma/client';
import prisma from '@/lib/prisma';
import { auditService } from '@/lib/audit';

export const dynamic = 'force-dynamic';

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
    const body: PackOrderRequest = await request.json();

    // Validate request body
    if (!body.locationId || !body.items || !Array.isArray(body.items)) {
      return NextResponse.json(
        { error: 'Missing required fields: locationId and items' },
        { status: 400 }
      );
    }

    if (body.items.length === 0) {
      return NextResponse.json(
        { error: 'No items provided for packing' },
        { status: 400 }
      );
    }

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

    // Check order lock
    const lock = orderLocks.get(orderId);
    if (!lock || lock.userId !== userId || lock.expiresAt < new Date()) {
      return NextResponse.json(
        { error: 'Order must be locked by you before packing' },
        { status: 403 }
      );
    }

    // Validate all items exist in the order and check if all are packed
    const orderItems = mockOrderItems.filter(item => item.orderId === orderId);
    const itemMap = new Map(orderItems.map(item => [item.id, item]));
    const packedItemIds = new Set(body.items.map(item => item.orderItemId));
    
    // Check if all order items are included
    const allItemsPacked = orderItems.every(item => packedItemIds.has(item.id));
    if (!allItemsPacked) {
      return NextResponse.json(
        { error: 'All order items must be packed before completing the order' },
        { status: 400 }
      );
    }
    
    // Validate each packed item
    const mappedItems = [];
    const unmappedItems = [];
    
    for (const packItem of body.items) {
      const orderItem = itemMap.get(packItem.orderItemId);
      if (!orderItem) {
        return NextResponse.json(
          { error: `Order item ${packItem.orderItemId} not found in order` },
          { status: 400 }
        );
      }
      
      if (packItem.quantity !== orderItem.quantity) {
        return NextResponse.json(
          { error: `Quantity mismatch for item ${packItem.orderItemId}. Expected: ${orderItem.quantity}, Got: ${packItem.quantity}` },
          { status: 400 }
        );
      }
      
      // Separate mapped and unmapped items
      if (orderItem.productId) {
        mappedItems.push({ ...packItem, orderItem });
      } else {
        unmappedItems.push({ ...packItem, orderItem });
      }
    }

    // Validate stock availability for mapped items only
    const stockValidations = await Promise.all(
      mappedItems.map(async (item) => {
        const validation = await validateStockAvailability(
          item.orderItem.productId!,
          body.locationId,
          item.quantity
        );
        return { ...validation, item };
      })
    );

    const insufficientStock = stockValidations.filter(v => !v.isValid);
    if (insufficientStock.length > 0) {
      const product = await prisma.product.findUnique({
        where: { id: insufficientStock[0].item.orderItem.productId! },
        select: { name: true }
      });
      
      return NextResponse.json(
        { 
          error: `Insufficient stock for product: ${product?.name || insufficientStock[0].item.orderItem.productName}`,
          details: insufficientStock.map(v => ({
            productId: v.item.orderItem.productId,
            productName: v.item.orderItem.productName,
            requested: v.requestedQuantity,
            available: v.currentQuantity,
            shortfall: v.shortfall
          }))
        },
        { status: 400 }
      );
    }

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      const adjustments = [];
      const warnings = [];
      
      // Create inventory deductions for mapped items only
      for (const item of mappedItems) {
        const adjustment = await createInventoryAdjustment(
          session.user.id,
          item.orderItem.productId!,
          body.locationId,
          -item.quantity, // Negative delta for deduction
          inventory_logs_logType.ADJUSTMENT
        );
        
        adjustments.push(adjustment);
        
        // Get product info for audit log
        const product = await tx.product.findUnique({
          where: { id: item.orderItem.productId! },
          select: { name: true }
        });
        
        if (product) {
          await auditService.logInventoryAdjustment(
            userId,
            item.orderItem.productId!,
            product.name,
            -item.quantity,
            body.locationId,
            { 
              reason: 'External order fulfillment',
              orderId: order.externalOrderId,
              orderItemId: item.orderItemId
            }
          );
        }
      }
      
      // Add warnings for unmapped items
      for (const item of unmappedItems) {
        warnings.push({
          itemId: item.orderItemId,
          productName: item.orderItem.productName,
          quantity: item.quantity,
          message: 'Product not mapped to inventory - no stock deduction performed'
        });
      }
      
      return { adjustments, warnings };
    });

    // Update order status (in mock data)
    order.status = ExternalOrderStatus.PACKED;
    order.packedAt = new Date();
    order.packedBy = userId;
    order.updatedAt = new Date();

    // Clear the order lock
    orderLocks.delete(orderId);

    // Log the packing action
    await auditService.logAction(
      userId,
      'PACK_ORDER',
      'EXTERNAL_ORDER',
      parseInt(orderId),
      `Packed external order ${order.externalOrderId}`,
      {
        locationId: body.locationId,
        itemCount: body.items.length,
        totalQuantity: body.items.reduce((sum, item) => sum + item.quantity, 0)
      }
    );

    return NextResponse.json({
      success: true,
      message: 'Order packed successfully',
      order: {
        id: order.id,
        externalOrderId: order.externalOrderId,
        status: order.status,
        packedAt: order.packedAt,
        packedBy: order.packedBy
      },
      adjustments: result.adjustments.map(r => ({
        logId: r.log.id,
        productId: r.log.productId,
        delta: r.log.delta,
        newVersion: r.newVersion
      })),
      warnings: result.warnings,
      summary: {
        totalItems: body.items.length,
        mappedItems: mappedItems.length,
        unmappedItems: unmappedItems.length,
        inventoryDeducted: mappedItems.length > 0
      }
    });
  } catch (error) {
    console.error('Error packing order:', error);
    
    // Clear lock on error to allow retry
    try {
      const session = await getServerSession(authOptions);
      if (session?.user?.id) {
        const orderId = params.id;
        const lock = orderLocks.get(orderId);
        if (lock && lock.userId === parseInt(session.user.id)) {
          orderLocks.delete(orderId);
        }
      }
    } catch (lockError) {
      console.error('Error clearing lock:', lockError);
    }
    
    return NextResponse.json(
      { error: 'Failed to pack order' },
      { status: 500 }
    );
  }
}