export interface OrderItem {
  id: string
  name: string
  quantity: number
  currentStock: number
  productId?: number
  isMapped?: boolean
  bundleItems?: {
    id: string
    name: string
    quantity: number
  }[]
}

export interface Order {
  id: string
  orderNumber: string
  items: OrderItem[]
  status: 'pending' | 'packing' | 'completed' | 'cancelled'
  createdAt: Date
  updatedAt: Date
}

// API Response Types
export interface OrdersResponse {
  orders: Order[]
  hasMore: boolean
  nextCursor?: string
}

export interface OrderLockRequest {
  orderId: string
  userId: string
}

export interface OrderLockResponse {
  success: boolean
  lockedBy?: {
    userId: string
    userName: string
    lockedAt: Date
  }
  error?: string
}