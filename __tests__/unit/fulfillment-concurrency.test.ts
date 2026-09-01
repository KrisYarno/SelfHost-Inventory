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

// ---------------------------------------------------------------------------
// THE RECORDING RAW TRIO (pack CB0.3, the per-suite paragraph).
//
// B1a-ii put the canonical prelock in front of the item loop, so this path now
// spends `$executeRaw` on the materialize and `$queryRaw` on the returning
// locking read as well as on the atomic UPDATE these pins are about. The trio
// is installed on the FRESH mockTx each test builds (the OC-4 placement rule),
// and the behaviours below DISPATCH ON THE STATEMENT: a test that says "the
// UPDATE affected 0 rows" must keep saying exactly that, rather than having its
// answer eaten by the prelock's statement.
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
  install('execute', '$executeRaw', () => 1)
  install('executeUnsafe', '$executeRawUnsafe', () => 0)
}

/** The prelock's returning SELECT (lib/inventory/prelock.ts), by its text. */
function isPrelockSelect(sql: string): boolean {
  return sql.includes('FROM product_locations') && sql.includes('(productId, locationId) IN')
}

/**
 * What the item's atomic `UPDATE product_locations` reports, per call — the
 * last count repeats. Every other execute (the prelock's materialize, the loc-1
 * mirror) reports 1.
 */
function updateAffectedRows(...counts: number[]): void {
  let seen = 0
  rawBehavior.$executeRaw.mockImplementation(async (...args: unknown[]) => {
    if (/UPDATE product_locations/.test(sqlTextOf(args[0]))) {
      const at = Math.min(seen, counts.length - 1)
      seen += 1
      return counts[at]
    }
    return 1
  })
}

/**
 * What the refusal diagnostic's locking re-read finds — `null` for a row that
 * holds nothing. (It replaces the `product_locations.findUnique` these tests
 * used to seed; the prelock's own SELECT is not what the message reads.)
 */
function currentQuantity(quantity: number | null): void {
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) =>
    isPrelockSelect(sqlTextOf(args[0])) || quantity === null ? [] : [{ quantity }]
  )
}

/**
 * The candidate-existence read the simple-path prelock now runs (pack REV-22
 * F2): every asked id answers as a real product unless a test says otherwise.
 * A candidate the read does NOT return contributes no prelock key and its item
 * fails item-locally on the loop's own `findUnique`.
 */
function productsExist(tx: DeepMockProxy<PrismaClient>): void {
  ;(tx.product.findMany as unknown as jest.Mock).mockImplementation(
    async (args: any) => ((args?.where?.id?.in ?? []) as number[]).map((id) => ({ id }))
  )
}

function setupTransaction() {
  const mockTx = mockDeep<PrismaClient>()
  installRecordingRaw(mockTx as unknown as Record<string, unknown>)
  // Default: atomic UPDATE affects 1 row (success)
  updateAffectedRows(1)
  currentQuantity(null)
  productsExist(mockTx)
  getMockPrisma().$transaction.mockImplementation(async (cb: any, _opts?: any) => {
    return cb(mockTx)
  })
  return mockTx
}

beforeEach(() => {
  mockReset(getMockPrisma())
  _inventoryLogImpl = () => Promise.resolve({ id: 100 })
  jest.clearAllMocks()
  rawCalls.length = 0
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

    // The two deduction statements this pin is about:
    //   1. product_locations decrement with WHERE quantity >= ?
    //   2. products.quantity legacy mirror (locationId === 1)
    const executes = rawCalls.filter((c) => c.kind === 'execute')
    const decrements = executes.filter((c) => /UPDATE product_locations/.test(c.sql))
    expect(decrements).toHaveLength(1)
    expect(decrements[0].sql).toContain('quantity >=')
    expect(executes.filter((c) => /UPDATE products\b/.test(c.sql))).toHaveLength(1)
    // B1a-ii: plus the canonical prelock's materialize ahead of them, which is
    // the only statement this count gained.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3)
    expect(rawCalls[0].sql).toContain('INSERT INTO product_locations')

    // The old read-then-upsert pattern must NOT be used
    expect(tx.product_locations.upsert).not.toHaveBeenCalled()
  })

  it('P0-1: skips item as insufficient_stock when atomic UPDATE affects 0 rows', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ name: 'Widget A' } as any)
    // The product_locations UPDATE returns 0 → stock WHERE clause rejected
    updateAffectedRows(0)
    currentQuantity(2)
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
    // UPDATE affects 0 rows because the row holds nothing (post-materialize it
    // exists at { 0, 0 }, which the WHERE quantity >= guard rejects all the same)
    updateAffectedRows(0)
    currentQuantity(null)
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

  // Phase C (P-C2): a single-product fulfillment deduction is a SALE; the route's
  // event batchId threads through fulfillExternalOrder onto the ledger row.
  it('Phase C: deducts a single product as SALE stamped with the threaded batchId', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    tx.product.findUnique.mockResolvedValue({ name: 'Widget A' } as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 5 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    // signature: (orderId, locationId, items, userId, _notes?, record?, batchId?)
    await fulfillExternalOrder(
      'order-1',
      1,
      [{ itemId: 'item-1', quantity: 5 }],
      42,
      undefined,
      undefined,
      'batch-c-single'
    )

    const { createInventoryLog } = require('@/lib/inventory')
    const calls = (createInventoryLog as jest.Mock).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0].logType).toBe('SALE')
    expect(calls[0][0].batchId).toBe('batch-c-single')
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

    // First item: UPDATE succeeds (1). Second item: UPDATE fails (0) —
    // insufficient stock. (The mirror and the prelock report 1 either way.)
    updateAffectedRows(1, 0)
    currentQuantity(1)
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
