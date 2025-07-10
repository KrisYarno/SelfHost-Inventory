import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = params

    // Find the WooCommerce product
    const wooProduct = await prisma.wooCommerceProduct.findUnique({
      where: { id },
      include: { product: true }
    })

    if (!wooProduct) {
      return NextResponse.json(
        { error: 'Product mapping not found' },
        { status: 404 }
      )
    }

    if (!wooProduct.productId) {
      return NextResponse.json(
        { error: 'Product is not mapped' },
        { status: 400 }
      )
    }

    // Remove the mapping
    const updatedWooProduct = await prisma.wooCommerceProduct.update({
      where: { id },
      data: { productId: null }
    })

    // Log the unmapping action
    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'PRODUCT_UNMAPPED',
        entityType: 'PRODUCT',
        entityId: id,
        metadata: {
          wooProductName: wooProduct.name,
          wooProductSku: wooProduct.sku,
          previousInternalProductName: wooProduct.product?.name,
          previousInternalProductId: wooProduct.productId
        }
      }
    })

    return NextResponse.json({
      success: true,
      message: 'Product mapping removed successfully'
    })
  } catch (error) {
    console.error('Error removing product mapping:', error)
    return NextResponse.json(
      { error: 'Failed to remove mapping' },
      { status: 500 }
    )
  }
}