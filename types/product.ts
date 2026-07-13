import { Product as PrismaProduct, inventory_logs, ProductApprovalStatus } from "@prisma/client";

// Base product type from Prisma
export type Product = PrismaProduct;

// Product with computed current quantity
export interface ProductWithQuantity extends Product {
  currentQuantity: number;
  lastUpdated?: Date;
  locationQuantities?: Map<number, number>; // Optional: quantities per location
  totalQuantity?: number; // Optional: total across all locations
  version?: number; // Optional: version for optimistic locking
}

// Product form input types
export interface ProductFormData {
  name: string;
  baseName?: string;
  variant?: string;
  unit?: string;
  numericValue?: number;
  // NULL = inherit the system default (spec R-L13); undefined = field omitted.
  lowStockThreshold?: number | null;
  costPrice?: number;
  retailPrice?: number;
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
  sortBy?: "name" | "baseName" | "numericValue" | "baseNameNumeric";
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  // Lane 4 (codex #4): optional approval-status scope. The assistant's
  // find_product tool passes 'APPROVED' so provisional products never surface to
  // the model. Omitted = no approval filter (existing callers unchanged).
  approvalStatus?: ProductApprovalStatus;
}

// Create product request
export interface CreateProductRequest {
  name: string;
  baseName?: string;
  variant?: string;
  unit?: string;
  numericValue?: number;
  // NULL = inherit the system default (spec R-L13).
  lowStockThreshold?: number | null;
  locationId?: number;
  costPrice?: number;
  retailPrice?: number;
}

// Update product request
export interface UpdateProductRequest {
  name?: string;
  baseName?: string;
  variant?: string;
  unit?: string;
  numericValue?: number;
  // NULL = inherit the system default (spec R-L13).
  lowStockThreshold?: number | null;
  costPrice?: number;
  retailPrice?: number;
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
