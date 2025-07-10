// External order status
export enum ExternalOrderStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PACKED = 'PACKED',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED'
}

// External order model (temporary until added to Prisma schema)
export interface ExternalOrder {
  id: string;
  externalOrderId: string;
  customerName: string;
  customerEmail?: string;
  shippingAddress?: string;
  status: ExternalOrderStatus;
  orderDate: Date;
  packedAt?: Date;
  packedBy?: number;
  createdAt: Date;
  updatedAt: Date;
}

// External order item model
export interface ExternalOrderItem {
  id: string;
  orderId: string;
  externalProductId: string;
  productId?: number; // Internal product ID if mapped
  quantity: number;
  unitPrice?: number;
  productName: string;
  sku?: string;
}

// Order lock model
export interface OrderLock {
  orderId: string;
  userId: number;
  lockedAt: Date;
  expiresAt: Date;
}

// API Response types
export interface ExternalOrderWithItems extends ExternalOrder {
  items: ExternalOrderItem[];
  itemCount: number;
  lock?: OrderLock;
}

export interface ExternalOrderListItem extends ExternalOrder {
  itemCount: number;
  unmappedItemCount: number;
}

// API Request types
export interface PackOrderRequest {
  locationId: number;
  items: {
    orderItemId: string;
    productId: number;
    quantity: number;
  }[];
}

// Mock data functions (temporary until database tables are created)
export const mockOrders: ExternalOrder[] = [
  {
    id: '1',
    externalOrderId: 'ORD-001',
    customerName: 'John Doe',
    customerEmail: 'john@example.com',
    shippingAddress: '123 Main St, City, State 12345',
    status: ExternalOrderStatus.PROCESSING,
    orderDate: new Date('2025-01-08'),
    createdAt: new Date('2025-01-08'),
    updatedAt: new Date('2025-01-08'),
  },
  {
    id: '2',
    externalOrderId: 'ORD-002',
    customerName: 'Jane Smith',
    customerEmail: 'jane@example.com',
    shippingAddress: '456 Oak Ave, Town, State 67890',
    status: ExternalOrderStatus.PROCESSING,
    orderDate: new Date('2025-01-09'),
    createdAt: new Date('2025-01-09'),
    updatedAt: new Date('2025-01-09'),
  },
];

export const mockOrderItems: ExternalOrderItem[] = [
  {
    id: '1',
    orderId: '1',
    externalProductId: 'EXT-001',
    productId: 1,
    quantity: 2,
    unitPrice: 29.99,
    productName: 'Sample Product 1',
    sku: 'SKU001',
  },
  {
    id: '2',
    orderId: '1',
    externalProductId: 'EXT-002',
    productId: 2,
    quantity: 1,
    unitPrice: 49.99,
    productName: 'Sample Product 2',
    sku: 'SKU002',
  },
  {
    id: '3',
    orderId: '2',
    externalProductId: 'EXT-003',
    productId: undefined, // Unmapped product
    quantity: 3,
    unitPrice: 19.99,
    productName: 'Unmapped Product',
    sku: 'SKU003',
  },
];

// In-memory store for order locks (temporary)
export const orderLocks = new Map<string, OrderLock>();