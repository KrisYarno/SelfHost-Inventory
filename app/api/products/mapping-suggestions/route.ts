import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'

// Simple string similarity function
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim()
  const s2 = str2.toLowerCase().trim()
  
  // Exact match
  if (s1 === s2) return 1.0
  
  // Check if one contains the other
  if (s1.includes(s2) || s2.includes(s1)) return 0.8
  
  // Calculate Levenshtein distance-based similarity
  const maxLen = Math.max(s1.length, s2.length)
  if (maxLen === 0) return 1.0
  
  const distance = levenshteinDistance(s1, s2)
  return 1 - (distance / maxLen)
}

function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length
  const n = str2.length
  
  if (m === 0) return n
  if (n === 0) return m
  
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0))
  
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,    // deletion
          dp[i][j - 1] + 1,    // insertion
          dp[i - 1][j - 1] + 1 // substitution
        )
      }
    }
  }
  
  return dp[m][n]
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || !session.user.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { productIds } = body

    if (!productIds || !Array.isArray(productIds)) {
      return NextResponse.json(
        { error: 'Invalid product IDs' },
        { status: 400 }
      )
    }

    // Get WooCommerce products
    const wooProducts = await prisma.wooCommerceProduct.findMany({
      where: { id: { in: productIds } }
    })

    // Get all internal products
    const internalProducts = await prisma.product.findMany({
      where: { isActive: true }
    })

    // Generate suggestions based on name and SKU similarity
    const suggestions = wooProducts.map(wooProduct => {
      let bestMatch = { productId: 0, confidence: 0 }
      
      for (const internalProduct of internalProducts) {
        // Calculate name similarity
        const nameSimilarity = calculateSimilarity(wooProduct.name, internalProduct.name)
        
        // Calculate SKU similarity if both have SKUs
        let skuSimilarity = 0
        if (wooProduct.sku && internalProduct.sku) {
          skuSimilarity = calculateSimilarity(wooProduct.sku, internalProduct.sku)
        }
        
        // Weight the similarities (name is more important than SKU)
        const totalSimilarity = wooProduct.sku && internalProduct.sku
          ? (nameSimilarity * 0.7 + skuSimilarity * 0.3)
          : nameSimilarity
        
        if (totalSimilarity > bestMatch.confidence) {
          bestMatch = {
            productId: internalProduct.id,
            confidence: totalSimilarity
          }
        }
      }
      
      // Only suggest if confidence is above threshold
      if (bestMatch.confidence >= 0.5) {
        return {
          wooProductId: wooProduct.id,
          suggestedProductId: bestMatch.productId.toString(),
          confidence: bestMatch.confidence
        }
      }
      
      return null
    }).filter(Boolean)

    return NextResponse.json(suggestions)
  } catch (error) {
    console.error('Error generating mapping suggestions:', error)
    return NextResponse.json(
      { error: 'Failed to generate suggestions' },
      { status: 500 }
    )
  }
}