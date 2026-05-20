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

// P0-4: requireCompanyMembership mock — default to pass (member). Tests that
// want to simulate cross-company rejection use mockRequireCompanyMembership.
const mockRequireCompanyMembership = jest.fn().mockResolvedValue(undefined)
jest.mock('@/lib/api-utils', () => ({
  requireApproved: jest.fn().mockResolvedValue({
    user: { id: 1, email: 'test@test.com', name: 'Test', isAdmin: false, isApproved: true, defaultLocationId: 1 },
  }),
  requireCompanyMembership: (...args: any[]) => mockRequireCompanyMembership(...args),
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
  jest.clearAllMocks()
  _csrfValid = true
  _auditCalls.length = 0
  _inventoryLogImpl = () => Promise.resolve({ id: 100 })
  mockPushOrderStatus.mockReset().mockResolvedValue({ success: true })
  mockRequireCompanyMembership.mockReset().mockResolvedValue(undefined)
  // P0-4: The pre-transaction order lookup returns "order exists" by default
  // so existing tests pass. Test 4 overrides to simulate a missing order.
  getMockPrisma().externalOrder.findUnique.mockResolvedValue({
    companyId: 'co-test',
  } as any)
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
    externalId: 'ext-default',
    integrationId: 'int-default',
    internalStatus: 'fulfilled',
    fulfilledAt: new Date('2025-06-01'),
    fulfilledBy: 1,
    integration: { id: 'int-default', fulfillmentPushEnabled: false },
    items: [
      {
        id: 'item-1',
        orderId: 'order-1',
        quantity: 5,
        fulfilledQty: 5,
        name: 'Widget A',
        sku: 'WA-001',
        // P1-4: productLink verification requires mapping info
        productLink: { internalProductId: 1 },
      },
      {
        id: 'item-2',
        orderId: 'order-1',
        quantity: 3,
        fulfilledQty: 3,
        name: 'Widget B',
        sku: 'WB-001',
        productLink: { internalProductId: 2 },
      },
    ],
    ...overrides,
  }
}

function setupTransaction() {
  const mockTx = mockDeep<PrismaClient>()
  // Atomic $executeRaw returns affected row count.
  // Default: 1 row affected (success). Tests override per-case.
  mockTx.$executeRaw.mockResolvedValue(1 as any)
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
  // 3. Double-undo: atomic UPDATE WHERE fulfilledQty >= ? returns 0 → skip
  // -----------------------------------------------------------------------
  it('rejects unfulfill when atomic decrement finds insufficient fulfilled quantity', async () => {
    const tx = setupTransaction()
    const order = buildOrder({
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          quantity: 5,
          fulfilledQty: 2, // Only 2 fulfilled, but trying to unfulfill 5
          productLink: { internalProductId: 1 },
        },
      ],
    })

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    // P0-1 fix: the atomic UPDATE returns 0 affected rows when fulfilledQty < quantity.
    // First call is the fulfilledQty decrement, which should return 0 here.
    tx.$executeRaw.mockResolvedValueOnce(0 as any)
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
    expect(data.skipped[0].reason).toContain('insufficient fulfilled quantity')
  })

  // -----------------------------------------------------------------------
  // 4. Order not found: 404 (caught by pre-transaction company check)
  // -----------------------------------------------------------------------
  it('returns 404 when order is not found', async () => {
    const tx = setupTransaction()

    // P0-4: the pre-transaction company check hits findUnique FIRST.
    // Override the default "order exists" mock to simulate a missing order.
    getMockPrisma().externalOrder.findUnique.mockResolvedValueOnce(null)
    tx.externalOrder.findUnique.mockResolvedValue(null)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 1, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'nonexistent' } })
    const data = await response.json()

    expect(response.status).toBe(404)
    expect(data.error).toBe('Order not found')
  })

  // -----------------------------------------------------------------------
  // 4b. P0-4: cross-company access is rejected by membership check
  // -----------------------------------------------------------------------
  it('P0-4: rejects unfulfill when user does not belong to order company', async () => {
    // Pre-check: order exists but user is not a member of its company
    getMockPrisma().externalOrder.findUnique.mockResolvedValueOnce({
      companyId: 'co-other',
    } as any)
    // requireCompanyMembership throws AppError for non-members
    mockRequireCompanyMembership.mockRejectedValueOnce(
      Object.assign(new Error('Resource not found'), { code: 'NOT_FOUND', statusCode: 404 })
    )

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 1, quantity: 1, locationId: 1 },
      ],
    })

    await expect(
      POST(req, { params: { orderId: 'order-1' } })
    ).rejects.toThrow('Resource not found')

    // Transaction must NOT have been started
    expect(getMockPrisma().$transaction).not.toHaveBeenCalled()
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
  // 7. Concurrent safety: atomic raw SQL UPDATE (P0-1 fix)
  // -----------------------------------------------------------------------
  it('uses atomic $executeRaw for fulfilledQty and product_locations (concurrent safety)', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
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

    // Verify atomic UPDATEs were issued. Three $executeRaw calls per item:
    //   1. fulfilledQty decrement with WHERE fulfilledQty >= ?
    //   2. product_locations quantity increment
    //   3. products.quantity legacy mirror (because locationId === 1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3)

    // Fallback upsert-create should NOT fire when the UPDATE affected a row
    expect(tx.product_locations.create).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 7b. P1-4: product verification rejects when productId doesn't match mapping
  // -----------------------------------------------------------------------
  it('P1-4: rejects unfulfill when client-supplied productId does not match item mapping', async () => {
    const tx = setupTransaction()
    const order = buildOrder() // item-1 maps to productId 1, item-2 to 2

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 5 },
      { quantity: 3, fulfilledQty: 3 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    // Caller supplies productId 999 which doesn't match item-1's mapping (productId 1)
    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 999, quantity: 5, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(0)
    expect(data.skipped).toHaveLength(1)
    expect(data.skipped[0].reason).toContain('Product mismatch')

    // Atomic decrement must NOT have been attempted for the rejected item
    expect(tx.$executeRaw).not.toHaveBeenCalled()
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

  // -----------------------------------------------------------------------
  // 13. Bundle reversal: increments each component from snapshot
  // -----------------------------------------------------------------------
  it('reverses a bundle by incrementing each component from snapshot', async () => {
    const tx = setupTransaction()
    const bundleOrder = buildOrder({
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          quantity: 1,
          fulfilledQty: 1,
          isMapped: true,
          name: 'Bundle Product',
          sku: 'BUNDLE-001',
          bundleComponentSnapshot: [
            { internalProductId: 10, internalProductName: 'BPC-157', quantity: 1, sortOrder: 0 },
            { internalProductId: 20, internalProductName: 'TB-500', quantity: 2, sortOrder: 1 },
          ],
          productLink: {
            internalProductId: 99,
            isBundle: true,
            bundleComponents: [],
          },
        },
      ],
    })

    tx.externalOrder.findUnique.mockResolvedValue(bundleOrder as any)
    // $executeRaw: 1 = fulfilledQty decrement succeeds, then 1 per component product_locations update (×2)
    tx.$executeRaw.mockResolvedValue(1 as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 1, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        // productId is required by Zod schema; bundle path ignores it
        { itemId: 'item-1', productId: 99, quantity: 1, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(1)
    expect(data.skipped).toHaveLength(0)

    // createInventoryLog should have been called once per component
    const { createInventoryLog: mockLog } = require('@/lib/inventory')
    expect(mockLog).toHaveBeenCalledTimes(2)

    const logCalls = (mockLog as jest.Mock).mock.calls
    // First component: productId 10, qty 1 (1×1), positive delta
    expect(logCalls[0][0]).toMatchObject({ productId: 10, delta: 1 })
    // Second component: productId 20, qty 2 (2×1), positive delta
    expect(logCalls[1][0]).toMatchObject({ productId: 20, delta: 2 })

    // $executeRaw: 1 for fulfilledQty decrement + 2 for product_locations + 2 for legacy mirror (locationId=1)
    // = 5 total calls
    expect(tx.$executeRaw).toHaveBeenCalledTimes(5)
  })

  // -----------------------------------------------------------------------
  // 13b. Bundle reversal: malformed snapshot skipped (fail-closed, P1)
  // -----------------------------------------------------------------------
  it('skips bundle item with malformed bundleComponentSnapshot instead of restoring NaN', async () => {
    const tx = setupTransaction()
    const bundleOrder = buildOrder({
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          quantity: 1,
          fulfilledQty: 1,
          isMapped: true,
          name: 'Bundle Product',
          sku: 'BUNDLE-001',
          bundleComponentSnapshot: [{ bogus: 'data' }], // malformed
          productLink: {
            internalProductId: null,
            isBundle: true,
            bundleComponents: [],
          },
        },
      ],
    })

    tx.externalOrder.findUnique.mockResolvedValue(bundleOrder as any)
    tx.$executeRaw.mockResolvedValue(1 as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 1, fulfilledQty: 1 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 99, quantity: 1, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(0)
    expect(data.skipped).toHaveLength(1)
    expect(data.skipped[0].reason).toMatch(/malformed/i)

    // No inventory log should have been created — no NaN deduction
    const { createInventoryLog: mockLog } = require('@/lib/inventory')
    expect(mockLog).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 14. Bundle reversal: uses live bundleComponents when snapshot is null
  // -----------------------------------------------------------------------
  it('falls back to live bundleComponents when snapshot is null', async () => {
    const tx = setupTransaction()
    const bundleOrder = buildOrder({
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          quantity: 1,
          fulfilledQty: 1,
          isMapped: true,
          name: 'Bundle Product',
          sku: 'BUNDLE-001',
          bundleComponentSnapshot: null,
          productLink: {
            internalProductId: 99,
            isBundle: true,
            bundleComponents: [
              { internalProductId: 10, quantity: 1, sortOrder: 0 },
              { internalProductId: 20, quantity: 3, sortOrder: 1 },
            ],
          },
        },
      ],
    })

    tx.externalOrder.findUnique.mockResolvedValue(bundleOrder as any)
    tx.$executeRaw.mockResolvedValue(1 as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 1, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [
        { itemId: 'item-1', productId: 99, quantity: 1, locationId: 1 },
      ],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(1)

    const { createInventoryLog: mockLog } = require('@/lib/inventory')
    expect(mockLog).toHaveBeenCalledTimes(2)
    const logCalls = (mockLog as jest.Mock).mock.calls
    expect(logCalls[0][0]).toMatchObject({ productId: 10, delta: 1 })
    expect(logCalls[1][0]).toMatchObject({ productId: 20, delta: 3 })
  })
})
