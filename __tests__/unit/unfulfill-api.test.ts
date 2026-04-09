/**
 * @jest-environment node
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended'
import type { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// Mocks — jest.mock factories are hoisted above all declarations, so we
// stash the mock on globalThis where the factory can reach it.
// ---------------------------------------------------------------------------

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended')
  const mock = md();
  (globalThis as any).__mockPrisma = mock
  return { __esModule: true, default: mock }
})

jest.mock('@/lib/api-utils', () => ({
  requireApproved: jest.fn().mockResolvedValue({
    user: { id: 1, email: 'test@test.com', name: 'Test', isAdmin: false, isApproved: true, defaultLocationId: 1 },
  }),
  apiHandler: jest.fn((handler: any) => handler),
}))

// CSRF validation — lazily referenced via closure
let _csrfValid = true
jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(() => Promise.resolve(_csrfValid)),
}))

jest.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockReturnValue({}),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}))

// Mock pushOrderStatusToExternal — best-effort fulfillment push
const mockPushOrderStatus = jest.fn().mockResolvedValue({ success: true })
jest.mock('@/lib/external-orders/shared', () => ({
  pushOrderStatusToExternal: (...args: any[]) => mockPushOrderStatus(...args),
}))

// Audit service mock
const _auditCalls: any[] = []
jest.mock('@/lib/audit', () => ({
  auditService: {
    log: jest.fn((...args: any[]) => {
      _auditCalls.push(args)
      return Promise.resolve()
    }),
  },
}))

// createInventoryLog mock
let _inventoryLogImpl: (...args: any[]) => Promise<any>
jest.mock('@/lib/inventory', () => ({
  createInventoryLog: jest.fn((...args: any[]) => _inventoryLogImpl(...args)),
}))

// Import after mocks
import { POST } from '@/app/api/orders/[orderId]/unfulfill/route'

// Convenience getter — always points at the live mock stored on globalThis
function getMockPrisma(): DeepMockProxy<PrismaClient> {
  return (globalThis as any).__mockPrisma
}

beforeEach(() => {
  mockReset(getMockPrisma())
  _csrfValid = true
  _auditCalls.length = 0
  _inventoryLogImpl = () => Promise.resolve({ id: 100 })
  mockPushOrderStatus.mockReset().mockResolvedValue({ success: true })
  jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(body: any): any {
  return {
    json: () => Promise.resolve(body),
    headers: new Headers({ 'x-csrf-token': 'valid-token' }),
    url: 'http://localhost/api/orders/order-1/unfulfill',
    nextUrl: { pathname: '/api/orders/order-1/unfulfill' },
    ip: '127.0.0.1',
  }
}

function buildOrder(overrides: any = {}) {
  return {
    id: 'order-1',
    internalStatus: 'fulfilled',
    fulfilledAt: new Date('2025-06-01'),
    fulfilledBy: 1,
    items: [
      {
        id: 'item-1',
        orderId: 'order-1',
        quantity: 5,
        fulfilledQty: 5,
        name: 'Widget A',
        sku: 'WA-001',
      },
      {
        id: 'item-2',
        orderId: 'order-1',
        quantity: 3,
        fulfilledQty: 3,
        name: 'Widget B',
        sku: 'WB-001',
      },
    ],
    ...overrides,
  }
}

function setupTransaction() {
  const mockTx = mockDeep<PrismaClient>()
  getMockPrisma().$transaction.mockImplementation(async (cb: any) => {
    return cb(mockTx)
  })
  return mockTx
}

// ===========================================================================
// Tests
// ===========================================================================

describe('POST /api/orders/[orderId]/unfulfill', () => {
  // -----------------------------------------------------------------------
  // 1. Happy path: all items unfulfilled, order -> pending
  // -----------------------------------------------------------------------
  it('unfulfills all items and sets order status to pending', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    tx.product_locations.upsert.mockResolvedValue({} as any)
    tx.product.update.mockResolvedValue({} as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    // After unfulfill, all fulfilledQty = 0
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 0 },
      { quantity: 3, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 5, locationId: 1 },
        { itemId: 'item-2', productId: 2, quantity: 3, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(2)
    expect(data.skipped).toHaveLength(0)
    expect(data.newOrderStatus).toBe('pending')

    // Verify fulfilledAt/fulfilledBy are cleared
    expect(tx.externalOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          internalStatus: 'pending',
          fulfilledAt: null,
          fulfilledBy: null,
        }),
      })
    )

    // Verify audit log was called
    expect(_auditCalls.length).toBeGreaterThan(0)
    expect(_auditCalls[0][0]).toEqual(
      expect.objectContaining({
        actionType: 'EXTERNAL_ORDER_UNFULFILLMENT',
      })
    )
  })

  // -----------------------------------------------------------------------
  // 2. Partial unfulfill: some items, order -> processing
  // -----------------------------------------------------------------------
  it('partially unfulfills and sets order status to processing', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    tx.product_locations.upsert.mockResolvedValue({} as any)
    tx.product.update.mockResolvedValue({} as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    // After partial unfulfill: item-1 has some fulfilled, item-2 unchanged
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 2 },
      { quantity: 3, fulfilledQty: 3 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 3, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(1)
    expect(data.newOrderStatus).toBe('processing')
  })

  // -----------------------------------------------------------------------
  // 3. Double-undo: validation rejects (fulfilledQty < quantity)
  // -----------------------------------------------------------------------
  it('rejects unfulfill when fulfilledQty is less than requested quantity', async () => {
    const tx = setupTransaction()
    const order = buildOrder({
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          quantity: 5,
          fulfilledQty: 2, // Only 2 fulfilled, but trying to unfulfill 5
        },
      ],
    })

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    // After no items actually unfulfilled, fulfilledQty unchanged
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 2 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 5, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(0)
    expect(data.skipped).toHaveLength(1)
    expect(data.skipped[0].reason).toContain('Cannot unfulfill more than was fulfilled')
  })

  // -----------------------------------------------------------------------
  // 4. Order not found: 404
  // -----------------------------------------------------------------------
  it('returns 404 when order is not found', async () => {
    const tx = setupTransaction()

    tx.externalOrder.findUnique.mockResolvedValue(null)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 1, locationId: 1 },
      ],
    })

    // The AppError thrown inside the transaction propagates
    await expect(
      POST(req, { params: { orderId: 'nonexistent' } })
    ).rejects.toThrow('not found')
  })

  // -----------------------------------------------------------------------
  // 5. Cancelled order: reject
  // -----------------------------------------------------------------------
  it('rejects unfulfill on a cancelled order', async () => {
    const tx = setupTransaction()
    const order = buildOrder({ internalStatus: 'cancelled' })

    tx.externalOrder.findUnique.mockResolvedValue(order as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 5, locationId: 1 },
      ],
    })

    await expect(
      POST(req, { params: { orderId: 'order-1' } })
    ).rejects.toThrow('cancelled')
  })

  // -----------------------------------------------------------------------
  // 6. Deleted product: skip with warning
  // -----------------------------------------------------------------------
  it('skips items whose product has been deleted', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    // First product is deleted, second exists
    tx.product.findUnique
      .mockResolvedValueOnce({ id: 1, deletedAt: new Date() } as any)
      .mockResolvedValueOnce({ id: 2, deletedAt: null } as any)
    tx.product_locations.upsert.mockResolvedValue({} as any)
    tx.product.update.mockResolvedValue({} as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 5 },
      { quantity: 3, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 5, locationId: 1 },
        { itemId: 'item-2', productId: 2, quantity: 3, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(1)
    expect(data.skipped).toHaveLength(1)
    expect(data.skipped[0].reason).toContain('deleted')
  })

  // -----------------------------------------------------------------------
  // 7. Concurrent safety: items correct after parallel operations
  // -----------------------------------------------------------------------
  it('uses atomic decrement for fulfilledQty (concurrent safety)', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    tx.product_locations.upsert.mockResolvedValue({} as any)
    tx.product.update.mockResolvedValue({} as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 2 },
      { quantity: 3, fulfilledQty: 3 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 3, locationId: 1 },
      ],
    })

    await POST(req, { params: { orderId: 'order-1' } })

    // Verify atomic decrement (not read-then-set)
    expect(tx.externalOrderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-1' },
        data: {
          fulfilledQty: { decrement: 3 },
        },
      })
    )

    // Verify atomic increment on product_locations
    expect(tx.product_locations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          quantity: { increment: 3 },
          version: { increment: 1 },
        }),
      })
    )
  })

  // -----------------------------------------------------------------------
  // 8. CSRF validation required
  // -----------------------------------------------------------------------
  it('rejects request with invalid CSRF token', async () => {
    _csrfValid = false

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 1, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(response.status).toBe(403)
    expect(data.error).toBe('Invalid CSRF token')

    // Ensure no transaction was started
    expect(getMockPrisma().$transaction).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 9. Transaction rollback on mid-item failure
  // -----------------------------------------------------------------------
  it('rolls back transaction on mid-item failure', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    // First createInventoryLog succeeds, second blows up
    let callCount = 0
    _inventoryLogImpl = () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ id: 100 })
      return Promise.reject(new Error('DB write failed'))
    }
    tx.product_locations.upsert.mockResolvedValue({} as any)
    tx.product.update.mockResolvedValue({} as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 5, locationId: 1 },
        { itemId: 'item-2', productId: 2, quantity: 3, locationId: 1 },
      ],
    })

    // The error should propagate (Prisma rolls back the transaction)
    await expect(
      POST(req, { params: { orderId: 'order-1' } })
    ).rejects.toThrow('DB write failed')

    // Audit log should NOT have been called (it's outside the transaction)
    expect(_auditCalls).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // 10. Fulfillment push: called after successful unfulfill
  // -----------------------------------------------------------------------
  it('calls pushOrderStatusToExternal when fulfillmentPushEnabled is true', async () => {
    const tx = setupTransaction()
    const order = buildOrder({
      externalId: 'ext-order-99',
      integrationId: 'int-push-1',
      integration: { id: 'int-push-1', fulfillmentPushEnabled: true },
    })

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    tx.product_locations.upsert.mockResolvedValue({} as any)
    tx.product.update.mockResolvedValue({} as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    // Post-transaction: prisma.integration.findUnique returns fulfillmentPushEnabled: true
    getMockPrisma().integration.findUnique.mockResolvedValue({
      fulfillmentPushEnabled: true,
    } as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 5, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(mockPushOrderStatus).toHaveBeenCalledWith(
      'int-push-1',
      'ext-order-99',
      'processing'
    )
  })

  // -----------------------------------------------------------------------
  // 11. Fulfillment push failure doesn't block the unfulfill response
  // -----------------------------------------------------------------------
  it('returns success even when fulfillment push fails', async () => {
    const tx = setupTransaction()
    const order = buildOrder({
      externalId: 'ext-order-99',
      integrationId: 'int-push-1',
      integration: { id: 'int-push-1', fulfillmentPushEnabled: true },
    })

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    tx.product_locations.upsert.mockResolvedValue({} as any)
    tx.product.update.mockResolvedValue({} as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    // Post-transaction: fulfillmentPushEnabled = true, but push throws
    getMockPrisma().integration.findUnique.mockResolvedValue({
      fulfillmentPushEnabled: true,
    } as any)
    mockPushOrderStatus.mockRejectedValue(new Error('Network timeout'))

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 5, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    // Unfulfill still succeeds despite push failure
    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(1)
  })

  // -----------------------------------------------------------------------
  // 12. Zod validation rejects invalid body
  // -----------------------------------------------------------------------
  it('throws ZodError when body is missing required items field', async () => {
    const req = buildRequest({
      // missing "items" entirely
      notes: 'oops',
    })

    await expect(
      POST(req, { params: { orderId: 'order-1' } })
    ).rejects.toThrow() // ZodError from UnfulfillRequestSchema.parse

    // No transaction should have been started
    expect(getMockPrisma().$transaction).not.toHaveBeenCalled()
  })

  it('throws ZodError when item has negative quantity', async () => {
    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: -1, locationId: 1 },
      ],
    })

    await expect(
      POST(req, { params: { orderId: 'order-1' } })
    ).rejects.toThrow() // ZodError: quantity must be positive

    expect(getMockPrisma().$transaction).not.toHaveBeenCalled()
  })
})
