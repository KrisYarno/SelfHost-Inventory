/**
 * Reorder Recommendations API (Simplified)
 *
 * Returns products with their stock status based on user-set minimums (lowStockThreshold).
 * No complex calculations - just simple ratio-based status determination.
 *
 * Status logic:
 * - CRITICAL: stock ≤ 75% of minimum (25% below)
 * - NEED_ORDER: stock ≤ minimum (at or below threshold)
 * - RUNNING_LOW: stock ≤ 150% of minimum (within 50% of minimum)
 * - OKAY: stock > 150% of minimum OR no minimum set
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { Decimal } from "@prisma/client/runtime/library";
import {
  ReorderRecommendation,
  ReorderSummary,
  ReorderRecommendationsResponse,
  StockStatus,
} from "@/types/reports";

export const dynamic = "force-dynamic";

// Type definitions for Prisma query results
interface ProductRecord {
  id: number;
  name: string;
  baseName: string | null;
  variant: string | null;
  numericValue: Decimal | null;
  lowStockThreshold: number | null;
  costPrice: Decimal;
}

interface StockGroupByResult {
  productId: number;
  _sum: { delta: number | null };
}

/**
 * Calculate stock status based on current stock vs minimum threshold
 */
function calculateStatus(currentStock: number, minimum: number): StockStatus {
  if (minimum <= 0) return "OKAY";

  const ratio = currentStock / minimum;
  if (ratio <= 0.75) return "CRITICAL"; // 25% below minimum
  if (ratio <= 1.0) return "NEED_ORDER"; // At or below minimum
  if (ratio <= 1.5) return "RUNNING_LOW"; // Within 50% of minimum
  return "OKAY";
}

/**
 * Get status priority for sorting (lower = more urgent)
 */
function getStatusPriority(status: StockStatus): number {
  switch (status) {
    case "CRITICAL":
      return 1;
    case "NEED_ORDER":
      return 2;
    case "RUNNING_LOW":
      return 3;
    case "OKAY":
      return 4;
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const statusFilter = searchParams.get("statusFilter"); // "critical" | "need_order" | "running_low" | "all"
    const sortBy = searchParams.get("sortBy") || "alphabetical"; // "alphabetical" | "status"
    const limit = Math.min(parseInt(searchParams.get("limit") || "500"), 1000);

    // ============================================
    // Query 1: Get all products with minimums
    // ============================================
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        baseName: true,
        variant: true,
        numericValue: true,
        lowStockThreshold: true,
        costPrice: true,
      },
    });

    const productMap = new Map<number, ProductRecord>(
      products.map((p: ProductRecord) => [p.id, p])
    );

    // ============================================
    // Query 2: Get current stock per product (TOTAL across all locations)
    // ============================================
    const stockData = await prisma.inventory_logs.groupBy({
      by: ["productId"],
      _sum: { delta: true },
    });

    const stockMap = new Map<number, number>(
      stockData.map((item: StockGroupByResult) => [
        item.productId,
        item._sum.delta || 0,
      ])
    );

    // ============================================
    // Calculate status for each product
    // ============================================
    const recommendations: ReorderRecommendation[] = products.map(
      (product: ProductRecord) => {
        const currentStock = stockMap.get(product.id) || 0;
        const minimum = product.lowStockThreshold || 0;
        const costPrice = Number(product.costPrice ?? 0);

        const status = calculateStatus(currentStock, minimum);
        const ratio = minimum > 0 ? currentStock / minimum : Infinity;
        const orderQty =
          minimum > 0 && currentStock < minimum ? minimum - currentStock : 0;

        return {
          productId: product.id,
          productName: product.name,
          baseName: product.baseName,
          variant: product.variant,
          numericValue: product.numericValue ? Number(product.numericValue) : null,
          status,
          currentStock,
          minimum: minimum || null,
          stockToMinimumRatio: ratio,
          costPrice,
          estimatedOrderValue: orderQty * costPrice,
        };
      }
    );

    // ============================================
    // Filter by status if requested
    // ============================================
    let filteredRecommendations = recommendations;
    if (statusFilter && statusFilter !== "all") {
      if (statusFilter === "critical") {
        filteredRecommendations = recommendations.filter(
          (r) => r.status === "CRITICAL"
        );
      } else if (statusFilter === "need_order") {
        // Need Order+ includes CRITICAL and NEED_ORDER
        filteredRecommendations = recommendations.filter(
          (r) => r.status === "CRITICAL" || r.status === "NEED_ORDER"
        );
      } else if (statusFilter === "running_low") {
        // Running Low+ includes CRITICAL, NEED_ORDER, and RUNNING_LOW
        filteredRecommendations = recommendations.filter(
          (r) =>
            r.status === "CRITICAL" ||
            r.status === "NEED_ORDER" ||
            r.status === "RUNNING_LOW"
        );
      }
    }

    // ============================================
    // Sort by alphabetical (default) or status
    // ============================================
    if (sortBy === "status") {
      // Sort by status urgency first, then alphabetically within status
      filteredRecommendations.sort((a, b) => {
        const priorityDiff = getStatusPriority(a.status) - getStatusPriority(b.status);
        if (priorityDiff !== 0) return priorityDiff;
        // Secondary: alphabetical by baseName/productName
        const baseA = (a.baseName || a.productName).toLowerCase();
        const baseB = (b.baseName || b.productName).toLowerCase();
        return baseA.localeCompare(baseB);
      });
    } else {
      // Default: Sort alphabetically by baseName, then numericValue, then variant
      filteredRecommendations.sort((a, b) => {
        // Primary: baseName (fall back to productName for products without baseName)
        const baseA = (a.baseName || a.productName).toLowerCase();
        const baseB = (b.baseName || b.productName).toLowerCase();
        if (baseA !== baseB) return baseA.localeCompare(baseB);

        // Secondary: numericValue (for size ordering like 1.5L, 3L, etc.)
        const numA = a.numericValue ?? Infinity;
        const numB = b.numericValue ?? Infinity;
        if (numA !== numB) return numA - numB;

        // Tertiary: variant string
        const varA = (a.variant || "").toLowerCase();
        const varB = (b.variant || "").toLowerCase();
        if (varA !== varB) return varA.localeCompare(varB);

        // Fallback: full product name
        return a.productName.localeCompare(b.productName);
      });
    }

    // Apply limit
    const limitedRecommendations = filteredRecommendations.slice(0, limit);

    // ============================================
    // Calculate summary
    // ============================================
    const summary: ReorderSummary = {
      criticalCount: recommendations.filter((r) => r.status === "CRITICAL").length,
      needOrderCount: recommendations.filter((r) => r.status === "NEED_ORDER").length,
      runningLowCount: recommendations.filter((r) => r.status === "RUNNING_LOW").length,
      okayCount: recommendations.filter((r) => r.status === "OKAY").length,
      totalOrderValue: recommendations
        .filter((r) => r.status === "CRITICAL" || r.status === "NEED_ORDER")
        .reduce((sum, r) => sum + r.estimatedOrderValue, 0),
    };

    // ============================================
    // Build response
    // ============================================
    const response: ReorderRecommendationsResponse = {
      recommendations: limitedRecommendations,
      summary,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error calculating reorder recommendations:", error);
    return NextResponse.json(
      { error: "Failed to calculate reorder recommendations" },
      { status: 500 }
    );
  }
}
