/**
 * Performance-optimized inventory queries
 * These functions are specifically designed to leverage the new indexes
 * for the mass update feature
 */

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';

/**
 * Get products with quantities using optimized queries
 * Designed for the journal page load
 */
export async function getProductsWithQuantitiesOptimized(
  locationId: number,
  search?: string,
  page: number = 1,
  pageSize: number = 50
) {
  // Build where clause with soft delete filter
  const where: Prisma.ProductWhereInput = {
    deletedAt: null,
  };

  if (search) {
    // Use contains for search (MySQL is case-insensitive by default)
    where.OR = [
      { name: { contains: search } },
      { baseName: { contains: search } },
      { variant: { contains: search } },
    ];
  }

  // Execute queries in parallel for better performance
  const [products, totalCount, productLocations] = await Promise.all([
    // Get products - uses idx_products_bulk_lookup for soft delete filter
    prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    
    // Get total count
    prisma.product.count({ where }),
    
    // Pre-fetch all product locations for the page
    // This prevents N+1 queries
    prisma.product_locations.findMany({
      where: {
        locationId,
        products: where,
      },
      select: {
        productId: true,
        quantity: true,
        version: true,
      },
    }),
  ]);

  // Create a map for O(1) lookups
  const locationMap = new Map(
    productLocations.map(pl => [pl.productId, pl])
  );

  // Combine the data
  const productsWithQuantities = products.map(product => {
    const location = locationMap.get(product.id);
    return {
      ...product,
      currentQuantity: location?.quantity || 0,
      version: location?.version || 0,
    };
  });

  return {
    products: productsWithQuantities,
    total: totalCount,
    page,
    pageSize,
  };
}

/**
 * Batch validate product versions for optimistic locking
 * Uses the covering index for efficient lookups
 */
export async function batchValidateVersions(
  items: Array<{
    productId: number;
    locationId: number;
    expectedVersion: number;
  }>
): Promise<Map<string, { isValid: boolean; currentVersion: number }>> {
  // Build a list of unique product/location pairs
  const pairs = items.map(item => ({
    productId: item.productId,
    locationId: item.locationId,
  }));

  // Fetch all versions in one query - uses idx_product_locations_lookup_covering
  const productLocations = await prisma.product_locations.findMany({
    where: {
      OR: pairs.map(pair => ({
        productId: pair.productId,
        locationId: pair.locationId,
      })),
    },
    select: {
      productId: true,
      locationId: true,
      version: true,
    },
  });

  // Create lookup map
  const versionMap = new Map(
    productLocations.map(pl => [
      `${pl.productId}-${pl.locationId}`,
      pl.version,
    ])
  );

  // Validate versions
  const results = new Map<string, { isValid: boolean; currentVersion: number }>();
  
  for (const item of items) {
    const key = `${item.productId}-${item.locationId}`;
    const currentVersion = versionMap.get(key) || 0;
    
    results.set(key, {
      isValid: currentVersion === item.expectedVersion,
      currentVersion,
    });
  }

  return results;
}

/**
 * Get recent inventory changes with user information
 * Optimized for activity feeds and reports
 */
export async function getRecentInventoryChanges(
  locationId?: number,
  limit: number = 50
) {
  const where: Prisma.inventory_logsWhereInput = {
    // Uses idx_inventory_logs_recent_changes for date filtering
    changeTime: {
      gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
    },
  };

  if (locationId) {
    where.locationId = locationId;
  }

  // Single query with all needed joins
  const logs = await prisma.inventory_logs.findMany({
    where,
    orderBy: { changeTime: 'desc' },
    take: limit,
    include: {
      users: {
        select: {
          id: true,
          username: true,
          email: true,
        },
      },
      products: {
        select: {
          id: true,
          name: true,
          baseName: true,
          variant: true,
        },
      },
      locations: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  return logs;
}

/**
 * Find products with low stock efficiently
 * Uses the idx_product_locations_low_stock index
 */
export async function findLowStockProducts(
  locationId?: number,
  threshold?: number
) {
  const query = prisma.$queryRaw`
    SELECT 
      p.id,
      p.name,
      p.baseName,
      p.variant,
      p.lowStockThreshold,
      pl.quantity,
      pl.locationId,
      l.name as locationName
    FROM products p
    INNER JOIN product_locations pl ON p.id = pl.productId
    INNER JOIN locations l ON pl.locationId = l.id
    WHERE p.deletedAt IS NULL
      AND pl.quantity <= p.lowStockThreshold
      ${locationId ? Prisma.sql`AND pl.locationId = ${locationId}` : Prisma.empty}
      ${threshold ? Prisma.sql`AND pl.quantity <= ${threshold}` : Prisma.empty}
    ORDER BY pl.quantity ASC, p.name ASC
    LIMIT 100
  `;

  return query;
}

/**
 * Analyze index usage for performance monitoring
 */
export async function analyzeIndexUsage() {
  // Get index statistics
  const indexStats = await prisma.$queryRaw`
    SELECT 
      table_name,
      index_name,
      cardinality,
      avg_frequency
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name IN ('products', 'inventory_logs', 'product_locations')
      AND index_name LIKE 'idx_%'
    ORDER BY table_name, index_name
  `;

  // Get table sizes
  const tableSizes = await prisma.$queryRaw`
    SELECT 
      table_name,
      table_rows,
      data_length / 1024 / 1024 as data_size_mb,
      index_length / 1024 / 1024 as index_size_mb
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN ('products', 'inventory_logs', 'product_locations')
  `;

  return {
    indexStats,
    tableSizes,
  };
}