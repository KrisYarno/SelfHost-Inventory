import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const searchParams = request.nextUrl.searchParams
    const search = searchParams.get('search') || ''
    const tab = searchParams.get('tab') || 'unmapped'
    const showConflicts = searchParams.get('conflicts') === 'true'

    // Get all WooCommerce products with their mappings
    const wooProducts = await prisma.wooCommerceProduct.findMany({
      where: {
        ...(search && {
          OR: [
            { name: { contains: search } },
            { sku: { contains: search } }
          ]
        }),
        ...(tab === 'unmapped' && { productId: null })
      },
      include: {
        product: true
      },
      orderBy: { name: 'asc' }
    })

    // If showing conflicts, find products that are mapped to the same internal product
    if (showConflicts) {
      const mappingCounts = await prisma.wooCommerceProduct.groupBy({
        by: ['productId'],
        where: { productId: { not: null } },
        _count: { productId: true },
        having: { productId: { _count: { gt: 1 } } }
      })

      const conflictProductIds = mappingCounts.map(m => m.productId).filter(Boolean)

      const conflictWooProducts = await prisma.wooCommerceProduct.findMany({
        where: {
          productId: { in: conflictProductIds as number[] }
        },
        include: {
          product: true
        }
      })

      return NextResponse.json(conflictWooProducts.map(wp => ({
        id: wp.id,
        name: wp.name,
        sku: wp.sku,
        wooCommerceId: wp.wooCommerceId,
        mappedProductId: wp.productId?.toString(),
        mappedProductName: wp.product?.name
      })))
    }

    // Transform the data
    const products = wooProducts.map(wp => ({
      id: wp.id,
      name: wp.name,
      sku: wp.sku,
      wooCommerceId: wp.wooCommerceId,
      mappedProductId: wp.productId?.toString(),
      mappedProductName: wp.product?.name
    }))

    return NextResponse.json(products)
  } catch (error) {
    console.error('Error fetching unmapped products:', error)
    return NextResponse.json(
      { error: 'Failed to fetch products' },
      { status: 500 }
    )
  }
}