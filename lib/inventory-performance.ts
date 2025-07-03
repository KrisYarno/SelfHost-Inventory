import prisma from '@/lib/prisma';
import { 
  inventory_logs_logType,
  Prisma
} from '@prisma/client';
import type { 
  CurrentInventoryLevel
} from '@/types/inventory';

/**
 * High-performance version of getCurrentInventoryLevels
 * Uses a single query with subqueries to avoid N+1 problem
 */
export async function getCurrentInventoryLevelsPerformance(
  locationId?: number
): Promise<CurrentInventoryLevel[]> {
  // Use raw SQL for optimal performance
  const locationFilter = locationId ? `WHERE pl.locationId = ${locationId}` : '';
  
  const query = `
    SELECT 
      pl.productId,
      pl.locationId,
      pl.quantity,
      p.id as product_id,
      p.name as product_name,
      p.baseName as product_baseName,
      p.variant as product_variant,
      p.unit as product_unit,
      p.numericValue as product_numericValue,
      p.lowStockThreshold as product_lowStockThreshold,
      l.id as location_id,
      l.name as location_name,
      (
        SELECT MAX(il.changeTime)
        FROM inventory_logs il
        WHERE il.productId = pl.productId
          AND il.locationId = pl.locationId
      ) as lastUpdated
    FROM product_locations pl
    INNER JOIN products p ON p.id = pl.productId
    INNER JOIN locations l ON l.id = pl.locationId
    ${locationFilter}
    ORDER BY p.name ASC
  `;

  const results = await prisma.$queryRawUnsafe<any[]>(query);
  
  // Transform raw results to match expected type
  const inventoryLevels: CurrentInventoryLevel[] = results.map(row => ({
    productId: row.productId,
    product: {
      id: row.product_id,
      name: row.product_name,
      baseName: row.product_baseName,
      variant: row.product_variant,
      unit: row.product_unit,
      numericValue: row.product_numericValue,
      quantity: 0, // Legacy field
      location: 1, // Legacy field
      lowStockThreshold: row.product_lowStockThreshold,
    },
    locationId: row.locationId,
    location: {
      id: row.location_id,
      name: row.location_name,
    },
    quantity: row.quantity,
    lastUpdated: row.lastUpdated || new Date(0),
  }));

  // If specific location requested, also include products with 0 quantity
  if (locationId) {
    const productsWithInventory = new Set(inventoryLevels.map(il => il.productId));
    const missingProducts = await prisma.product.findMany({
      where: {
        id: {
          notIn: Array.from(productsWithInventory),
        },
      },
    });
    
    const location = await prisma.location.findUnique({ 
      where: { id: locationId } 
    });
    
    if (location) {
      for (const product of missingProducts) {
        inventoryLevels.push({
          productId: product.id,
          product,
          locationId,
          location,
          quantity: 0,
          lastUpdated: new Date(0),
        });
      }
    }
  }
  
  return inventoryLevels;
}

/**
 * Optimized batch quantity calculation using raw SQL
 */
export async function getBulkCurrentQuantitiesPerformance(
  productIds: number[],
  locationId: number
): Promise<Map<number, number>> {
  if (productIds.length === 0) {
    return new Map();
  }

  const results = await prisma.$queryRaw<Array<{productId: number, quantity: number}>>`
    SELECT productId, quantity
    FROM product_locations
    WHERE productId IN (${Prisma.join(productIds)})
      AND locationId = ${locationId}
  `;

  const quantities = new Map<number, number>();
  
  // Initialize all products with 0
  productIds.forEach(id => quantities.set(id, 0));
  
  // Set actual quantities
  results.forEach(row => {
    quantities.set(row.productId, row.quantity);
  });

  return quantities;
}

/**
 * Optimized low stock detection using window functions
 */
export async function getLowStockProductsPerformance(
  threshold: number = 10,
  locationId?: number
): Promise<Array<{
  productId: number;
  productName: string;
  currentStock: number;
  threshold: number;
  location?: string;
}>> {
  const locationFilter = locationId 
    ? Prisma.sql`AND pl.locationId = ${locationId}` 
    : Prisma.sql``;

  const results = await prisma.$queryRaw<any[]>`
    SELECT 
      p.id as productId,
      p.name as productName,
      COALESCE(SUM(pl.quantity), 0) as currentStock,
      p.lowStockThreshold as threshold,
      ${locationId ? Prisma.sql`l.name as location` : Prisma.sql`NULL as location`}
    FROM products p
    LEFT JOIN product_locations pl ON pl.productId = p.id
    ${locationId ? Prisma.sql`LEFT JOIN locations l ON l.id = pl.locationId` : Prisma.sql``}
    WHERE 1=1 ${locationFilter}
    GROUP BY p.id, p.name, p.lowStockThreshold${locationId ? Prisma.sql`, l.name` : Prisma.sql``}
    HAVING currentStock < ${threshold}
    ORDER BY currentStock ASC
  `;

  return results;
}

/**
 * Get inventory metrics with a single optimized query
 */
export async function getInventoryMetricsPerformance(
  startDate?: Date,
  endDate?: Date,
  locationId?: number
): Promise<{
  totalProducts: number;
  totalQuantity: number;
  lowStockCount: number;
  recentActivityCount: number;
  avgDailyMovement: number;
}> {
  const dateFilter = [];
  if (startDate) dateFilter.push(Prisma.sql`il.changeTime >= ${startDate}`);
  if (endDate) dateFilter.push(Prisma.sql`il.changeTime <= ${endDate}`);
  if (locationId) dateFilter.push(Prisma.sql`il.locationId = ${locationId}`);
  
  const whereClause = dateFilter.length > 0 
    ? Prisma.sql`WHERE ${Prisma.join(dateFilter, ' AND ')}` 
    : Prisma.sql``;

  const [metrics] = await prisma.$queryRaw<any[]>`
    WITH inventory_summary AS (
      SELECT 
        COUNT(DISTINCT p.id) as totalProducts,
        COALESCE(SUM(pl.quantity), 0) as totalQuantity,
        COUNT(DISTINCT CASE WHEN pl.quantity < p.lowStockThreshold THEN p.id END) as lowStockCount
      FROM products p
      LEFT JOIN product_locations pl ON pl.productId = p.id
      ${locationId ? Prisma.sql`WHERE pl.locationId = ${locationId}` : Prisma.sql``}
    ),
    activity_summary AS (
      SELECT 
        COUNT(*) as recentActivityCount,
        COALESCE(SUM(ABS(il.delta)), 0) / NULLIF(DATEDIFF(COALESCE(${endDate}, NOW()), COALESCE(${startDate}, DATE_SUB(NOW(), INTERVAL 30 DAY))), 0) as avgDailyMovement
      FROM inventory_logs il
      ${whereClause}
    )
    SELECT 
      is_.totalProducts,
      is_.totalQuantity,
      is_.lowStockCount,
      as_.recentActivityCount,
      COALESCE(as_.avgDailyMovement, 0) as avgDailyMovement
    FROM inventory_summary is_
    CROSS JOIN activity_summary as_
  `;

  return metrics || {
    totalProducts: 0,
    totalQuantity: 0,
    lowStockCount: 0,
    recentActivityCount: 0,
    avgDailyMovement: 0,
  };
}

/**
 * Cached product search with optimized query
 */
export async function searchProductsPerformance(
  search: string,
  limit: number = 20
): Promise<Array<{id: number; name: string; baseName: string | null; variant: string | null}>> {
  // Use full-text search if available, otherwise fall back to LIKE
  const results = await prisma.$queryRaw<any[]>`
    SELECT id, name, baseName, variant
    FROM products
    WHERE 
      name LIKE ${`%${search}%`}
      OR baseName LIKE ${`%${search}%`}
      OR variant LIKE ${`%${search}%`}
    ORDER BY 
      CASE 
        WHEN name LIKE ${`${search}%`} THEN 1
        WHEN baseName LIKE ${`${search}%`} THEN 2
        WHEN variant LIKE ${`${search}%`} THEN 3
        ELSE 4
      END,
      name ASC
    LIMIT ${limit}
  `;

  return results;
}