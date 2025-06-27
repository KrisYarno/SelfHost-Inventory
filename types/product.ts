import { Product as PrismaProduct, inventory_logs } from "@prisma/client";

// Base product type from Prisma
export type Product = PrismaProduct;

// Product with computed current quantity
export interface ProductWithQuantity extends Product {
  currentQuantity: number;
  lastUpdated?: Date;
  locationQuantities?: Map<number, number>; // Optional: quantities per location
  totalQuantity?: number; // Optional: total across all locations
}

// Product form input types
export interface ProductFormData {
  name: string;
  baseName?: string;
  variant?: string;
  unit?: string;
  numericValue?: number;
  lowStockThreshold?: number;
}

// API response types
export interface ProductsResponse {
  products: ProductWithQuantity[];
  total: number;
  page: number;
  pageSize: number;
}

// Filter options for product list
export interface ProductFilters {
  search?: string;
  sortBy?: "name" | "baseName" | "numericValue";
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

// Create product request
export interface CreateProductRequest {
  name: string;
  baseName?: string;
  variant?: string;
  unit?: string;
  numericValue?: number;
  lowStockThreshold?: number;
}

// Update product request
export interface UpdateProductRequest {
  name?: string;
  baseName?: string;
  variant?: string;
  unit?: string;
  numericValue?: number;
  lowStockThreshold?: number;
}

// Product with inventory logs for detailed view
export interface ProductWithLogs extends ProductWithQuantity {
  inventory_logs: (inventory_logs & {
    users: {
      id: number;
      username: string;
    };
    locations: {
      id: number;
      name: string;
    } | null;
  })[];
}