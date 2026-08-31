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
  // Spread the real module first so requireCSRF (and friends) exist; the
  // real requireCSRF calls the mocked validateCSRFToken below, so the
  // _csrfValid closure keeps driving CSRF behavior.
  ...jest.requireActual('@/lib/api-utils'),
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

// createInventoryLog mock
let _inventoryLogImpl: (...args: any[]) => Promise<any>
jest.mock('@/lib/inventory', () => ({
  createInventoryLog: jest.fn((...args: any[]) => _inventoryLogImpl(...args)),
}))

// Import after mocks
import { POST } from '@/app/api/orders/[orderId]/unfulfill/route'
import { AppError } from '@/lib/error-handling'

// Convenience getter — always points at the live mock stored on globalThis
function getMockPrisma(): DeepMockProxy<PrismaClient> {
  return (globalThis as any).__mockPrisma
}

beforeEach(() => {
  mockReset(getMockPrisma())
  jest.clearAllMocks()
  rawCalls.length = 0
  _csrfValid = true
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

// ---------------------------------------------------------------------------
// THE RECORDING RAW TRIO (pack CB0.3, the per-suite paragraph).
//
// This suite declares its OWN `@/lib/prisma` factory and builds a fresh tx per
// test, so the global harness's trio never reaches it: the trio is installed on
// each `setupTransaction()` tx instead. Two layers — the OUTER fn always records
// and then delegates to an INNER behaviour fn (`rawBehavior`), which is what a
// test configures, so an override can never silently switch the recording off.
// ---------------------------------------------------------------------------
type RawCall = { kind: 'query' | 'execute' | 'executeUnsafe'; sql: string; at: number }

const rawCalls: RawCall[] = []
const rawBehavior: Record<string, jest.Mock> = {}
const rawFns: Record<string, jest.Mock> = {}
let rawSeq = 0

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === 'object' && typeof (arg as { sql?: unknown }).sql === 'string'
    ? (arg as { sql: string }).sql
    : String(arg)
}

function installRecordingRaw(target: Record<string, unknown>): void {
  const install = (kind: RawCall['kind'], method: string, make: () => unknown) => {
    const behavior = jest.fn((..._args: unknown[]) => Promise.resolve(make()))
    const recording = jest.fn((...args: unknown[]) => {
      rawCalls.push({ kind, sql: sqlTextOf(args[0]), at: rawSeq++ })
      return behavior(...args)
    })
    rawBehavior[method] = behavior
    rawFns[method] = recording
    target[method] = recording
  }
  install('query', '$queryRaw', () => [])
  // The route reads $executeRaw as its atomic UPDATEs' affected-row count.
  // Default: 1 row affected (success). Tests override per-case.
  install('execute', '$executeRaw', () => 1)
  install('executeUnsafe', '$executeRawUnsafe', () => 0)
}

/** The order lock's SELECT (lib/inventory/order-lock.ts), by its text. */
function isOrderLockSelect(sql: string): boolean {
  return sql.includes('FROM external_orders') && sql.includes('FOR UPDATE')
}

/** The prelock's returning SELECT (lib/inventory/prelock.ts), by its text. */
function isPrelockSelect(sql: string): boolean {
  return sql.includes('FROM product_locations') && sql.includes('(productId, locationId) IN')
}

/** The locked order the route asks for: the one in the path. */
const LOCKED_ORDERS = [{ id: 'order-1', orderNumber: '#1001' }]

/**
 * The two locking reads this route now spends, answered by their text. The
 * prelock's rows are what the restorations' keys materialize to; unfulfill reads
 * no value off them (its guard is the atomic fulfilledQty decrement), so the
 * default set only has to cover the keys, never particular quantities.
 */
function lockedReads(
  prelocked: Array<{ productId: number; locationId: number; quantity: number; version: number }>
): void {
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const sql = sqlTextOf(args[0])
    if (isOrderLockSelect(sql)) return LOCKED_ORDERS
    if (isPrelockSelect(sql)) return prelocked
    return []
  })
}

/** Every key these tests restore into, materialized and stocked. */
const PRELOCKED = [
  { productId: 1, locationId: 1, quantity: 100, version: 1 },
  { productId: 2, locationId: 1, quantity: 100, version: 1 },
  { productId: 10, locationId: 1, quantity: 100, version: 1 },
  { productId: 20, locationId: 1, quantity: 100, version: 1 },
]

function setupTransaction() {
  const mockTx = mockDeep<PrismaClient>()
  installRecordingRaw(mockTx as unknown as Record<string, unknown>)
  lockedReads(PRELOCKED)
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
    // stockedOut separation (commit efae981): unfulfill no longer mutates
    // internalStatus (that's WC's domain). newOrderStatus echoes the existing
    // WC status. The meaningful state change is on stockedOut/fulfilledAt/etc,
    // asserted below on the update payload.

    // All items restored → stockedOut cleared and audit fields cleared
    expect(tx.externalOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stockedOut: false,
          stockedOutAt: null,
          stockedOutBy: null,
          fulfilledAt: null,
          fulfilledBy: null,
        }),
      })
    )

    // Task 12 (change-tracking): the change event is now recorded via
    // recordChange INSIDE the tx — assert the ORDER audit row was created on the
    // SAME tx as the restoration (entityType=ORDER, entityId=the order cuid,
    // companyId threaded from the loaded order).
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
    expect((tx.auditLog.create as jest.Mock).mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        actionType: 'EXTERNAL_ORDER_UNFULFILLMENT',
        entityType: 'ORDER',
        entityId: 'order-1',
        companyId: 'co-test',
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
    // stockedOut separation (commit efae981): unfulfill no longer mutates
    // internalStatus. With one item still fulfilled, stockedOut stays true.
    expect(tx.externalOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stockedOut: true,
        }),
      })
    )
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
    rawBehavior.$executeRaw.mockResolvedValueOnce(0 as any)
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

    // Verify atomic UPDATEs were issued. FOUR $executeRaw calls for one item:
    //   1. fulfilledQty decrement with WHERE fulfilledQty >= ? (pass 1)
    //   2. the prelock's materialize INSERT (pack CB1b.3, between the passes)
    //   3. product_locations quantity increment (pass 2)
    //   4. products.quantity legacy mirror (because locationId === 1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4)

    // The create fallback is GONE — the prelock materialized the row, so the
    // increment cannot miss (pack CB1b.3). This pin now says "never", not
    // "not this time".
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

    // apiHandler is a passthrough in this suite, so the AppError thrown by
    // requireCSRF surfaces as a rejection (the real apiHandler maps it to a
    // 403 { error, code: 'CSRF_INVALID' } response).
    const err = await POST(req, { params: { orderId: 'order-1' } }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).statusCode).toBe(403)
    expect((err as AppError).code).toBe('CSRF_INVALID')
    expect((err as AppError).message).toBe('Invalid CSRF token')

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

    // Task 12: the change event is recorded INSIDE the tx, AFTER the item loop.
    // A mid-item failure aborts before it, so no audit row is written and the
    // whole transaction (deductions + would-be audit) rolls back together.
    expect(tx.auditLog.create).not.toHaveBeenCalled()
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
    rawBehavior.$executeRaw.mockResolvedValue(1 as any)
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

    // FIX C (P0 #6): Public API response must NOT leak the bundle sentinel.
    // Bundle entries get {isBundle: true, componentIds: [...]} — productId
    // and inventoryLogId are omitted (they are sentinel -1 values).
    const entry = data.restored[0]
    expect(entry.isBundle).toBe(true)
    expect(entry.componentIds).toEqual([10, 20])
    expect(entry.productId).toBeUndefined()
    expect(entry.inventoryLogId).toBeUndefined()
    // Per-item fields are preserved
    expect(entry.itemId).toBe('item-1')
    expect(entry.quantity).toBe(1)
    expect(entry.locationId).toBe(1)

    // createInventoryLog should have been called once per component
    const { createInventoryLog: mockLog } = require('@/lib/inventory')
    expect(mockLog).toHaveBeenCalledTimes(2)

    const logCalls = (mockLog as jest.Mock).mock.calls
    // First component: productId 10, qty 1 (1×1), positive delta
    expect(logCalls[0][0]).toMatchObject({ productId: 10, delta: 1 })
    // Second component: productId 20, qty 2 (2×1), positive delta
    expect(logCalls[1][0]).toMatchObject({ productId: 20, delta: 2 })

    // $executeRaw: 1 for fulfilledQty decrement + 1 for the prelock's materialize
    // INSERT (both component keys in ONE statement) + 2 for product_locations
    // + 2 for the legacy mirror (locationId=1) = 6 total calls
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6)
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
    rawBehavior.$executeRaw.mockResolvedValue(1 as any)
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
  // 14. Bundle reversal: refuses to restore on snapshot=null + fulfilledQty>0
  // (FIX B P0): symmetric unfulfill — never reads live when fulfill should
  // have frozen the snapshot. Snapshot=null with fulfilledQty>0 is a data
  // integrity bug post-Fix-B; refuse rather than risk phantom restoration.
  // -----------------------------------------------------------------------
  it('FIX B: refuses to restore when snapshot=null and fulfilledQty>0 (data integrity)', async () => {
    const tx = setupTransaction()
    const bundleOrder = buildOrder({
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          quantity: 1,
          fulfilledQty: 1, // > 0 — refuse defensively
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
    rawBehavior.$executeRaw.mockResolvedValue(1 as any)
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
    expect(data.skipped[0].reason).toMatch(/data integrity/i)

    // No inventory restoration must have happened
    const { createInventoryLog: mockLog } = require('@/lib/inventory')
    expect(mockLog).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 14b. Bundle reversal: ignores live components when snapshot exists,
  // even if PATCH has changed the live composition. This is the core
  // anti-phantom-inventory guarantee of Fix B.
  // -----------------------------------------------------------------------
  it('FIX B: reads frozen snapshot for reversal, not live bundleComponents (PATCH symmetry)', async () => {
    const tx = setupTransaction()
    // Snapshot says [10:1, 20:2] but live composition is [50:5] (PATCHed after fulfill).
    // Unfulfill MUST restore 10 and 20 — not 50.
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
            { internalProductId: 10, internalProductName: 'X', quantity: 1, sortOrder: 0 },
            { internalProductId: 20, internalProductName: 'Y', quantity: 2, sortOrder: 1 },
          ],
          productLink: {
            internalProductId: 99,
            isBundle: true,
            bundleComponents: [
              // Composition was PATCHed after fulfill — completely different!
              { internalProductId: 50, quantity: 5, sortOrder: 0 },
            ],
          },
        },
      ],
    })

    tx.externalOrder.findUnique.mockResolvedValue(bundleOrder as any)
    rawBehavior.$executeRaw.mockResolvedValue(1 as any)
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
    expect(mockLog).toHaveBeenCalledTimes(2) // 2 snapshot components, not 1 live
    const productIds = (mockLog as jest.Mock).mock.calls.map((c: any[]) => c[0].productId)
    expect(productIds).toEqual(expect.arrayContaining([10, 20]))
    expect(productIds).not.toContain(50) // live composition must be ignored
  })

  // -----------------------------------------------------------------------
  // Phase C (P-C2): restoration ledger rows are CORRECTION + reasonCode, joined
  // to the unfulfill audit event by the route's shared batchId (single path).
  // -----------------------------------------------------------------------
  it('Phase C: single-product restorations are CORRECTION + reasonCode joined by batchId', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
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

    // The event's batchId is what the ledger rows must join on.
    const auditData = (tx.auditLog.create as jest.Mock).mock.calls[0][0].data
    expect(typeof auditData.batchId).toBe('string')
    expect(auditData.batchId).toBeTruthy()

    const { createInventoryLog: mockLog } = require('@/lib/inventory')
    const logCalls = (mockLog as jest.Mock).mock.calls
    expect(logCalls).toHaveLength(2)
    for (const [logArg] of logCalls) {
      expect(logArg.logType).toBe('CORRECTION')
      expect(logArg.reasonCode).toBe('CORRECTION')
      expect(logArg.batchId).toBe(auditData.batchId)
    }
  })

  // -----------------------------------------------------------------------
  // Phase C (P-C2): bundle-component restorations carry the same CORRECTION +
  // reasonCode + batchId as the single path (both restoration sites).
  // -----------------------------------------------------------------------
  it('Phase C: bundle-component restorations are CORRECTION + reasonCode joined by batchId', async () => {
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
            { internalProductId: 10, internalProductName: 'X', quantity: 1, sortOrder: 0 },
            { internalProductId: 20, internalProductName: 'Y', quantity: 2, sortOrder: 1 },
          ],
          productLink: { internalProductId: 99, isBundle: true, bundleComponents: [] },
        },
      ],
    })

    tx.externalOrder.findUnique.mockResolvedValue(bundleOrder as any)
    rawBehavior.$executeRaw.mockResolvedValue(1 as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 1, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const req = buildRequest({
      items: [{ itemId: 'item-1', productId: 99, quantity: 1, locationId: 1 }],
    })

    const response = await POST(req, { params: { orderId: 'order-1' } })
    const data = await response.json()
    expect(data.success).toBe(true)
    expect(data.restored).toHaveLength(1)

    const auditData = (tx.auditLog.create as jest.Mock).mock.calls[0][0].data
    expect(auditData.batchId).toBeTruthy()

    const { createInventoryLog: mockLog } = require('@/lib/inventory')
    const logCalls = (mockLog as jest.Mock).mock.calls
    expect(logCalls).toHaveLength(2)
    for (const [logArg] of logCalls) {
      expect(logArg.logType).toBe('CORRECTION')
      expect(logArg.reasonCode).toBe('CORRECTION')
      expect(logArg.batchId).toBe(auditData.batchId)
    }
  })
})

// ===========================================================================
// THE LOCK DISCIPLINE (reconciliation Part 2, spec §2.7; pack CB1b.3)
//
// Unfulfill is the route whose lock order was hardest to see: it decrements
// `fulfilledQty` and restores `product_locations` per item, interleaved, so a
// second request could sit between one item's decrement and its restoration.
// The route now takes the order first, does every decrement (pass 1), prelocks
// every surviving key at once, and only then writes stock (pass 2). These pins
// are about that SHAPE — the statements, in order, with the keys the passes
// actually produced.
// ===========================================================================

describe('unfulfill — the order lock, the two passes, and the prelock between them', () => {
  /** The raw statements this request spent, in call order. */
  function kinds() {
    return rawCalls.map((c) => c.kind)
  }

  function singleOrder() {
    return buildOrder({
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          quantity: 5,
          fulfilledQty: 5,
          productLink: { internalProductId: 1 },
        },
      ],
    })
  }

  it('takes the ORDER LOCK as statement 1 — before the order read', async () => {
    const tx = setupTransaction()
    tx.externalOrder.findUnique.mockResolvedValue(singleOrder() as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 5, fulfilledQty: 0 }] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const res = await POST(
      buildRequest({ items: [{ itemId: 'item-1', productId: 1, quantity: 5, locationId: 5 }] }),
      { params: { orderId: 'order-1' } }
    )
    expect(res.status).toBe(200)

    // The FIRST raw statement of the transaction is the lock, and it names the
    // order from the PATH.
    expect(rawCalls[0].kind).toBe('query')
    expect(isOrderLockSelect(rawCalls[0].sql)).toBe(true)
    const lockSql = rawFns.$queryRaw.mock.calls[0][0] as any
    expect(lockSql.values).toEqual(['order-1'])
    // ...and it precedes the transaction's first consistent read.
    expect(rawFns.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      (tx.externalOrder.findUnique as jest.Mock).mock.invocationCallOrder[0]
    )
  })

  it('keeps the route’s 30 second budget on the wrapped transaction', async () => {
    const tx = setupTransaction()
    tx.externalOrder.findUnique.mockResolvedValue(singleOrder() as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 5, fulfilledQty: 0 }] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    await POST(
      buildRequest({ items: [{ itemId: 'item-1', productId: 1, quantity: 5, locationId: 5 }] }),
      { params: { orderId: 'order-1' } }
    )

    expect((getMockPrisma().$transaction as jest.Mock).mock.calls[0][1]).toEqual({ timeout: 30000 })
  })

  it('runs pass 1 (the decrements), THEN the prelock, THEN pass 2 (the stock writes)', async () => {
    const tx = setupTransaction()
    tx.externalOrder.findUnique.mockResolvedValue(buildOrder() as any)
    tx.product.findUnique.mockResolvedValue({ id: 1, deletedAt: null } as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 0 },
      { quantity: 3, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const res = await POST(
      buildRequest({
        items: [
          { itemId: 'item-1', productId: 1, quantity: 5, locationId: 5 },
          { itemId: 'item-2', productId: 2, quantity: 3, locationId: 5 },
        ],
      }),
      { params: { orderId: 'order-1' } }
    )
    expect(res.status).toBe(200)

    // lock · decrement · decrement · prelock INSERT · prelock SELECT · 2 restores
    expect(kinds()).toEqual(['query', 'execute', 'execute', 'execute', 'query', 'execute', 'execute'])
    expect(rawCalls[1].sql).toContain('UPDATE external_order_items')
    expect(rawCalls[2].sql).toContain('UPDATE external_order_items')
    expect(rawCalls[3].sql).toContain('INSERT INTO product_locations')
    expect(isPrelockSelect(rawCalls[4].sql)).toBe(true)
    expect(rawCalls[5].sql).toContain('UPDATE product_locations')
    expect(rawCalls[6].sql).toContain('UPDATE product_locations')

    // ONE prelock for BOTH items' keys, in canonical order.
    const insert = rawFns.$executeRaw.mock.calls.find((c: any[]) =>
      sqlTextOf(c[0]).includes('INSERT INTO product_locations')
    ) as any[]
    expect((insert[0] as any).values).toEqual([1, 5, 2, 5])
  })

  it('prelocks the BUNDLE’s COMPONENT keys, not the bundle line’s own product', async () => {
    const tx = setupTransaction()
    tx.externalOrder.findUnique.mockResolvedValue(
      buildOrder({
        items: [
          {
            id: 'item-1',
            orderId: 'order-1',
            quantity: 1,
            fulfilledQty: 1,
            isMapped: true,
            bundleComponentSnapshot: [
              { internalProductId: 20, internalProductName: 'Y', quantity: 2, sortOrder: 1 },
              { internalProductId: 10, internalProductName: 'X', quantity: 1, sortOrder: 0 },
            ],
            productLink: { internalProductId: 99, isBundle: true, bundleComponents: [] },
          },
        ],
      }) as any
    )
    tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 1, fulfilledQty: 0 }] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const res = await POST(
      buildRequest({ items: [{ itemId: 'item-1', productId: 99, quantity: 1, locationId: 5 }] }),
      { params: { orderId: 'order-1' } }
    )
    expect(res.status).toBe(200)

    const insert = rawFns.$executeRaw.mock.calls.find((c: any[]) =>
      sqlTextOf(c[0]).includes('INSERT INTO product_locations')
    ) as any[]
    // Canonically sorted, components only — 99 is the bundle line, never a key.
    expect((insert[0] as any).values).toEqual([10, 5, 20, 5])
  })

  it('spends NO locking statement past the order lock when every item is skipped', async () => {
    const tx = setupTransaction()
    tx.externalOrder.findUnique.mockResolvedValue(buildOrder() as any)
    tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 5, fulfilledQty: 5 }] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    // A product mismatch: pass 1 skips it, so there is no survivor to prelock.
    const res = await POST(
      buildRequest({ items: [{ itemId: 'item-1', productId: 999, quantity: 5, locationId: 5 }] }),
      { params: { orderId: 'order-1' } }
    )
    expect(res.status).toBe(200)
    expect(kinds()).toEqual(['query'])
  })

  it('refuses a restoration whose survivor keys exceed the prelock cap, with TOO_MANY_KEYS', async () => {
    const tx = setupTransaction()
    // Bundles multiply keys: five items of fifty distinct components each is
    // 250 rows to lock from a request the schema is perfectly happy with.
    const bundleItem = (n: number) => ({
      id: `item-${n}`,
      orderId: 'order-1',
      quantity: 1,
      fulfilledQty: 1,
      isMapped: true,
      bundleComponentSnapshot: Array.from({ length: 50 }, (_, i) => ({
        internalProductId: n * 50 + i + 1,
        internalProductName: `P${n * 50 + i + 1}`,
        quantity: 1,
        sortOrder: i,
      })),
      productLink: { internalProductId: 99, isBundle: true, bundleComponents: [] },
    })
    tx.externalOrder.findUnique.mockResolvedValue(
      buildOrder({ items: [0, 1, 2, 3, 4].map(bundleItem) }) as any
    )

    // apiHandler is a passthrough here; the real one renders this as a 400.
    await expect(
      POST(
        buildRequest({
          items: [0, 1, 2, 3, 4].map((n) => ({
            itemId: `item-${n}`,
            productId: 99,
            quantity: 1,
            locationId: 5,
          })),
        }),
        {
          params: { orderId: 'order-1' },
        }
      )
    ).rejects.toMatchObject({
      message: 'too many restorations in one request — split it',
      code: 'TOO_MANY_KEYS',
      statusCode: 400,
    })

    // The tx aborts before ANY stock write — pass 1's decrements included, since
    // they roll back with it.
    expect(rawCalls.some((c) => c.sql.includes('UPDATE product_locations'))).toBe(false)
    expect(rawCalls.some((c) => c.sql.includes('INSERT INTO product_locations'))).toBe(false)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('409s ORDER_GONE when the order vanished between the membership check and the lock', async () => {
    const tx = setupTransaction()
    // The lock finds nothing; the required id is the one in the path.
    rawBehavior.$queryRaw.mockResolvedValue([] as any)
    tx.externalOrder.findUnique.mockResolvedValue(buildOrder() as any)

    await expect(
      POST(buildRequest({ items: [{ itemId: 'item-1', productId: 1, quantity: 5, locationId: 5 }] }), {
        params: { orderId: 'order-1' },
      })
    ).rejects.toMatchObject({
      code: 'ORDER_GONE',
      statusCode: 409,
    })
    expect(tx.externalOrder.findUnique).not.toHaveBeenCalled()
  })
})
