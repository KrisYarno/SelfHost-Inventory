import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { wooProductId, internalProductId } = body

    if (!wooProductId || !internalProductId) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // Convert internalProductId to number
    const productId = parseInt(internalProductId, 10)
    if (isNaN(productId)) {
      return NextResponse.json(
        { error: 'Invalid product ID' },
        { status: 400 }
      )
    }

    // Verify both products exist
    const [wooProduct, internalProduct] = await Promise.all([
      prisma.wooCommerceProduct.findUnique({ where: { id: wooProductId } }),
      prisma.product.findUnique({ where: { id: productId } })
    ])

    if (!wooProduct) {
      return NextResponse.json(
        { error: 'WooCommerce product not found' },
        { status: 404 }
      )
    }

    if (!internalProduct) {
      return NextResponse.json(
        { error: 'Internal product not found' },
        { status: 404 }
      )
    }

    // Create the mapping
    const updatedWooProduct = await prisma.wooCommerceProduct.update({
      where: { id: wooProductId },
      data: { productId: productId },
      include: { product: true }
    })

    // Log the mapping action
    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'PRODUCT_MAPPED',
        entityType: 'PRODUCT',
        entityId: wooProductId,
        metadata: {
          wooProductName: wooProduct.name,
          wooProductSku: wooProduct.sku,
          internalProductName: internalProduct.name,
          internalProductId: productId
        }
      }
    })

    return NextResponse.json({
      id: updatedWooProduct.id,
      wooProductId: updatedWooProduct.id,
      internalProductId: updatedWooProduct.productId,
      wooProductName: updatedWooProduct.name,
      internalProductName: updatedWooProduct.product?.name
    })
  } catch (error) {
    console.error('Error creating product mapping:', error)
    return NextResponse.json(
      { error: 'Failed to create mapping' },
      { status: 500 }
    )
  }
}