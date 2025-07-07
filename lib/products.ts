import { Product, Prisma } from "@prisma/client";
import { ProductWithQuantity, ProductFilters } from "@/types/product";
import prisma from "@/lib/prisma";

/**
 * Calculate current quantity for a product at a specific location
 * from the product_locations table
 */
export async function getCurrentQuantity(
  productId: number,
  locationId: number
): Promise<number> {
  const productLocation = await prisma.product_locations.findUnique({
    where: {
      productId_locationId: {
        productId,
        locationId,
      },
    },
    select: {
      quantity: true,
    },
  });

  return productLocation?.quantity || 0;
}

/**
 * Calculate current quantities for multiple products at a location
 * More efficient than calling getCurrentQuantity for each product
 */
export async function getBulkCurrentQuantities(
  productIds: number[],
  locationId: number
): Promise<Map<number, number>> {
  // Get quantities from product_locations table
  const productLocations = await prisma.product_locations.findMany({
    where: {
      productId: { in: productIds },
      locationId,
    },
    select: {
      productId: true,
      quantity: true,
    },
  });

  const quantities = new Map<number, number>();
  
  // Initialize all products with 0
  productIds.forEach(id => quantities.set(id, 0));
  
  // Set the quantities from product_locations
  productLocations.forEach(pl => {
    quantities.set(pl.productId, pl.quantity);
  });

  return quantities;
}

/**
 * Calculate total quantities for multiple products across all locations
 * Sums up quantities from all locations using the product_locations table
 */
export async function getBulkTotalQuantities(
  productIds: number[]
): Promise<Map<number, number>> {
  // Get quantities from product_locations table
  const productLocations = await prisma.product_locations.findMany({
    where: {
      productId: { in: productIds },
    },
    select: {
      productId: true,
      quantity: true,
    },
  });

  const quantities = new Map<number, number>();
  
  // Initialize all products with 0
  productIds.forEach(id => quantities.set(id, 0));
  
  // Sum up the quantities from all locations
  productLocations.forEach(pl => {
    const current = quantities.get(pl.productId) || 0;
    quantities.set(pl.productId, current + pl.quantity);
  });

  return quantities;
}

/**
 * Format product name by combining baseName and variant
 */
export function formatProductName(product: Pick<Product, "baseName" | "variant">): string {
  const baseName = product.baseName || '';
  const variant = product.variant || '';
  return `${baseName} ${variant}`.trim();
}

/**
 * Get products with current quantities
 * @param filters - Product filters
 * @param locationId - Optional location ID for location-specific quantities
 * @param getTotal - If true, returns total quantities across all locations
 */
export async function getProductsWithQuantities(
  filters: ProductFilters,
  locationId?: number,
  getTotal: boolean = false
): Promise<{ products: ProductWithQuantity[]; total: number }> {
  const {
    search,
    sortBy = "name",
    sortOrder = "asc",
    page = 1,
    pageSize = 50,
  } = filters;

  // Build where clause - exclude soft deleted products
  const where: Prisma.ProductWhereInput = {
    deletedAt: null, // Only get non-deleted products
  };
  
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { baseName: { contains: search } },
      { variant: { contains: search } },
    ];
  }

  // Get total count
  const total = await prisma.product.count({ where });

  // Get products
  const products = await prisma.product.findMany({
    where,
    orderBy: [
      sortBy === "name" ? { name: sortOrder } : {},
      sortBy === "baseName" ? { baseName: sortOrder } : {},
      sortBy === "numericValue" ? { numericValue: sortOrder } : {},
      // Secondary sort by name for consistency
      { name: "asc" },
    ],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  // Get current quantities for all products
  const productIds = products.map(p => p.id);
  
  let productsWithQuantities: ProductWithQuantity[];
  
  if (getTotal || !locationId) {
    // Get total quantities across all locations
    const quantities = await getBulkTotalQuantities(productIds);
    productsWithQuantities = products.map(product => ({
      ...product,
      currentQuantity: quantities.get(product.id) || 0,
    }));
  } else {
    // Get location-specific quantities
    const quantities = await getBulkCurrentQuantities(productIds, locationId);
    productsWithQuantities = products.map(product => ({
      ...product,
      currentQuantity: quantities.get(product.id) || 0,
    }));
  }

  return { products: productsWithQuantities, total };
}

/**
 * Validate product uniqueness (baseName + variant must be unique)
 */
export async function isProductUnique(
  baseName: string,
  variant: string,
  excludeId?: number
): Promise<boolean> {
  const existing = await prisma.product.findFirst({
    where: {
      baseName,
      variant,
      id: excludeId ? { not: excludeId } : undefined,
    },
  });

  return !existing;
}

/**
 * Get the next available numeric value
 */
export async function getNextNumericValue(): Promise<number> {
  const product = await prisma.product.findFirst({
    orderBy: { numericValue: "desc" },
    select: { numericValue: true },
  });

  return product?.numericValue ? Number(product.numericValue) + 1 : 1;
}