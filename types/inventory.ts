import { 
  inventory_logs,
  inventory_logs_logType,
  Product,
  Location,
  User
} from '@prisma/client';

// Base inventory log type with relations.
// Relations are deliberately NARROWED to the fields the API actually selects
// (see lib/inventory.ts createInventoryLog and /api/inventory/logs): full
// User would imply passwordHash crosses the wire, which it must never do.
export type InventoryLogWithRelations = inventory_logs & {
  users: Pick<User, 'id' | 'username' | 'email'>;
  products: Pick<Product, 'id' | 'name' | 'baseName' | 'variant'>;
  locations: Pick<Location, 'id' | 'name'> | null;
};

// For compatibility - transactions are handled differently in actual schema
export type InventoryTransactionWithLogs = {
  id: string;
  logs: InventoryLogWithRelations[];
  user: User;
  type: string;
  status: string;
};

// Current inventory level for a product at a location
export type CurrentInventoryLevel = {
  productId: number;
  product: Product;
  locationId: number;
  location: Location;
  quantity: number;
  lastUpdated: Date;
  version?: number;
};

// API Request types
export type InventoryAdjustmentRequest = {
  productId: number;
  locationId: number;
  delta: number;
  logType?: inventory_logs_logType;
  expectedVersion?: number;
};

export type StockInRequest = {
  productId: number;
  locationId: number;
  quantity: number;
  logType?: inventory_logs_logType;
};

export type InventoryTransferRequest = {
  productId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
  expectedFromVersion?: number;
  expectedToVersion?: number;
};

// API Response types
export type InventoryLogResponse = {
  logs: InventoryLogWithRelations[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export type CurrentInventoryResponse = {
  inventory: CurrentInventoryLevel[];
  asOf: Date;
};

export type ProductInventoryHistory = {
  product: Product;
  location: Location;
  currentQuantity: number;
  history: InventoryLogWithRelations[];
};

export type InventoryTransactionResponse = {
  transactions: InventoryTransactionWithLogs[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

// Filter types
export type InventoryLogFilters = {
  productId?: number;
  locationId?: number;
  userId?: number;
  logType?: inventory_logs_logType;
  startDate?: Date;
  endDate?: Date;
};

export type InventoryTransactionFilters = {
  type?: string;
  status?: string;
  userId?: number;
  startDate?: Date;
  endDate?: Date;
};

// Validation types
export type StockValidation = {
  isValid: boolean;
  currentQuantity: number;
  requestedQuantity: number;
  shortfall?: number;
  error?: string;
};

// Inventory snapshot at a point in time
export type InventorySnapshot = {
  timestamp: Date;
  inventory: Array<{
    productId: number;
    locationId: number;
    quantity: number;
  }>;
};

// Minimum breach tracking for alerting + UI
export interface LocationMinBreach {
  productId: number;
  productName: string;
  locationId: number;
  locationName: string;
  currentQuantity: number;
  minQuantity: number;
}

export interface CombinedMinBreach {
  productId: number;
  productName: string;
  totalQuantity: number;
  combinedMinimum: number;
  daysUntilEmpty: number | null;
}

// Batch transfer types for Stock In feature
export interface BatchTransferRequest {
  productId: number;
  toLocationId: number;
  transfers: Array<{
    fromLocationId: number;
    quantity: number;
    expectedVersion?: number;
  }>;
}

export interface BatchTransferResult {
  success: boolean;
  results: Array<{
    fromLocationId: number;
    quantity: number;
    success: boolean;
    error?: string;
  }>;
  totalTransferred: number;
  batchId: string;
}

export interface ProductLocationQuantity {
  locationId: number;
  locationName: string;
  quantity: number;
  version: number;
}

/** Minimal product surface the inventory dialogs actually consume. */
export interface DialogProduct {
  id: number;
  name: string;
}
