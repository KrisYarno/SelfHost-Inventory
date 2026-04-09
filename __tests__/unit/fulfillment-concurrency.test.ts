/**
 * @jest-environment node
 *
 * Tests the atomic stock-deduction path in `fulfillExternalOrder`.
 *
 * P0-1 fix: the fulfillment path uses a raw SQL `UPDATE product_locations
 * SET quantity = quantity - ? ... WHERE quantity >= ?` instead of a
 * read-validate-then-upsert pattern. This test asserts that the atomic
 * path is used and that the fallback-to-skip behavior fires when
 * the WHERE clause rejects the UPDATE (i.e. insufficient stock).
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended'
import type { PrismaClient } from '@prisma/client'

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended')
  const mock = md();
  (globalThis as any).__mockPrismaFulfill = mock
  return { __esModule: true, default: mock }
})

let _inventoryLogImpl: (...args: any[]) => Promise<any>
jest.mock('@/lib/inventory', () => ({
  createInventoryLog: jest.fn((...args: any[]) => _inventoryLogImpl(...args)),
}))

// Import after mocks
import { fulfillExternalOrder } from '@/lib/fulfillment'

function getMockPrisma(): DeepMockProxy<PrismaClient> {
  return (globalThis as any).__mockPrismaFulfill
}

function buildOrder(overrides: any = {}) {
  return {
    id: 'order-1',
    externalId: 'ext-1',
    integrationId: 'int-1',
    internalStatus: 'pending',
    fulfilledAt: null,
    fulfilledBy: null,
    integration: {
      id: 'int-1',
      platform: 'WOOCOMMERCE',
      fulfillmentPushEnabled: false,
    },
    items: [
      {
        id: 'item-1',
        orderId: 'order-1',
        quantity: 5,
        fulfilledQty: 0,
        name: 'Widget A',
        sku: 'WA-001',
        isMapped: true,
        productLink: {
          internalProduct: { id: 10, name: 'Widget A' },
        },
      },
    ],
    ...overrides,
  }
}

function setupTransaction() {
  const mockTx = mockDeep<PrismaClient>()
  // Default: atomic UPDATE affects 1 row (success)
  mockTx.$executeRaw.mockResolvedValue(1 as any)
  getMockPrisma().$transaction.mockImplementation(async (cb: any, _opts?: any) => {
    return cb(mockTx)
  })
  return mockTx
}

beforeEach(() => {
  mockReset(getMockPrisma())
  _inventoryLogImpl = () => Promise.resolve({ id: 100 })
  jest.clearAllMocks()
})

describe('fulfillExternalOrder atomic stock deduction', () => {
  it('P0-1: uses atomic $executeRaw UPDATE with WHERE quantity >= ? guard', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ name: 'Widget A' } as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 5 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const result = await fulfillExternalOrder(
      'order-1',
      1, // locationId
      [{ itemId: 'item-1', quantity: 5 }],
      42 // userId
    )

    expect(result.fulfilled).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
    expect(result.failed).toHaveLength(0)

    // Two $executeRaw calls expected:
    //   1. product_locations decrement with WHERE quantity >= ?
    //   2. products.quantity legacy mirror (locationId === 1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)

    // The old read-then-upsert pattern must NOT be used
    expect(tx.product_locations.upsert).not.toHaveBeenCalled()
  })

  it('P0-1: skips item as insufficient_stock when atomic UPDATE affects 0 rows', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ name: 'Widget A' } as any)
    // First call (product_locations UPDATE) returns 0 → stock WHERE clause rejected
    tx.$executeRaw.mockResolvedValueOnce(0 as any)
    tx.product_locations.findUnique.mockResolvedValue({ quantity: 2 } as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const result = await fulfillExternalOrder(
      'order-1',
      1,
      [{ itemId: 'item-1', quantity: 5 }],
      42
    )

    expect(result.fulfilled).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toBe('insufficient_stock')
    expect(result.skipped[0].details).toContain('Available: 2')
    expect(result.skipped[0].details).toContain('Requested: 5')

    // fulfilledQty must NOT be incremented when stock is insufficient
    expect(tx.externalOrderItem.update).not.toHaveBeenCalled()
  })

  it('P1-5: create branch for missing product_locations row is never reached', async () => {
    // This test documents that the upsert create-with-negative-quantity
    // branch (removed by the P1-5 fix) cannot be reached: a missing row
    // causes the atomic UPDATE to return 0, which skips the item as
    // insufficient stock rather than creating a negative row.
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ name: 'Widget A' } as any)
    // UPDATE affects 0 rows because the product_locations row doesn't exist
    tx.$executeRaw.mockResolvedValueOnce(0 as any)
    tx.product_locations.findUnique.mockResolvedValue(null) // no row
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const result = await fulfillExternalOrder(
      'order-1',
      99, // non-existent location
      [{ itemId: 'item-1', quantity: 5 }],
      42
    )

    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].details).toContain('Available: 0')

    // The old bug: upsert.create would have been called with quantity: -5.
    // With the fix, no create/upsert happens on the stock table.
    expect(tx.product_locations.create).not.toHaveBeenCalled()
    expect(tx.product_locations.upsert).not.toHaveBeenCalled()
  })

  it('P0-1: mixed batch — one item succeeds, another fails stock check', async () => {
    const tx = setupTransaction()
    const order = {
      ...buildOrder(),
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          quantity: 5,
          fulfilledQty: 0,
          name: 'Widget A',
          sku: 'WA-001',
          isMapped: true,
          productLink: { internalProduct: { id: 10, name: 'Widget A' } },
        },
        {
          id: 'item-2',
          orderId: 'order-1',
          quantity: 3,
          fulfilledQty: 0,
          name: 'Widget B',
          sku: 'WB-001',
          isMapped: true,
          productLink: { internalProduct: { id: 20, name: 'Widget B' } },
        },
      ],
    }

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique
      .mockResolvedValueOnce({ name: 'Widget A' } as any)
      .mockResolvedValueOnce({ name: 'Widget B' } as any)

    // First item: UPDATE succeeds (1), legacy UPDATE succeeds (1)
    // Second item: UPDATE fails (0) — insufficient stock
    tx.$executeRaw
      .mockResolvedValueOnce(1 as any) // item-1 product_locations
      .mockResolvedValueOnce(1 as any) // item-1 products legacy mirror
      .mockResolvedValueOnce(0 as any) // item-2 product_locations — rejected

    tx.product_locations.findUnique.mockResolvedValue({ quantity: 1 } as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 5 },
      { quantity: 3, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    const result = await fulfillExternalOrder(
      'order-1',
      1,
      [
        { itemId: 'item-1', quantity: 5 },
        { itemId: 'item-2', quantity: 3 },
      ],
      42
    )

    expect(result.fulfilled).toHaveLength(1)
    expect(result.fulfilled[0].itemId).toBe('item-1')
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].itemId).toBe('item-2')
    expect(result.skipped[0].reason).toBe('insufficient_stock')
  })
})
