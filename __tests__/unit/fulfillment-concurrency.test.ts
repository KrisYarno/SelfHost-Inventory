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
 * What the PRELOCK's returning SELECT hands back — the rows the pass-2a tally
 * compares against (pack CB1.5a-i.2). B1.5 retired the refusal diagnostic's
 * locking re-read: the tally IS the locked truth, so the number an operator
 * reads comes from here.
 */
function prelockedStock(quantities: Record<number, number> = {}, ample = 100): void {
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const query = args[0] as { values?: unknown[] }
    if (!isPrelockSelect(sqlTextOf(query))) return []
    const values = (query?.values ?? []) as number[]
    const rows: Array<{ productId: number; locationId: number; quantity: number; version: number }> = []
    for (let i = 0; i < values.length; i += 2) {
      const productId = values[i]
      rows.push({
        productId,
        locationId: values[i + 1],
        quantity: quantities[productId] ?? ample,
        version: 1,
      })
    }
    return rows
  })
}

/**
 * The ONE batched `products` read (pack CB1.5a-i.2): it proves every survivor id
 * AND supplies the name the result entry and the refusal text carry — the
 * per-item `product.findUnique` retired with it.
 */
function productsExist(tx: DeepMockProxy<PrismaClient>): void {
  const NAMES: Record<number, string> = { 10: 'Widget A', 20: 'Widget B' }
  ;(tx.product.findMany as unknown as jest.Mock).mockImplementation(async (args: any) =>
    ((args?.where?.id?.in ?? []) as number[]).map((id) => ({
      id,
      name: NAMES[id] ?? `Product ${id}`,
    }))
  )
}

function setupTransaction() {
  const mockTx = mockDeep<PrismaClient>()
  installRecordingRaw(mockTx as unknown as Record<string, unknown>)
  // Default: atomic UPDATE affects 1 row (success)
  updateAffectedRows(1)
  prelockedStock()
  productsExist(mockTx)
  // OC-4: the location the prelock's INSERT names in `fk_pl_location`.
  ;(mockTx.location.findUnique as unknown as jest.Mock).mockImplementation(async (args: any) => ({
    id: args?.where?.id,
  }))
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
    //   1. product_locations decrement with WHERE quantity >= ? — B1.5: the
    //      clause stays as the BACKSTOP (the guard is the pass-2a tally), and a
    //      0-row answer under a passing tally is an invariant violation.
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

  it('B1.5: the TALLY refuses insufficient stock — no UPDATE is issued at all', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    // The prelock's returning SELECT is what the guard reads (pack CB1.5a-i.2):
    // the row holds 2, the item asks for 5.
    prelockedStock({ 10: 2 })
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
    expect(result.skipped[0].details).toBe(
      'Insufficient stock for Widget A. Available: 2, Requested: 5'
    )

    // The refusal spends NO product_locations statement past the prelock, and
    // fulfilledQty is not incremented.
    expect(rawCalls.filter((c) => /UPDATE product_locations/.test(c.sql))).toHaveLength(0)
    expect(tx.externalOrderItem.update).not.toHaveBeenCalled()
  })

  it('B1.5: a 0-row UPDATE under a PASSING tally aborts the whole request', async () => {
    const tx = setupTransaction()
    const order = buildOrder()

    tx.externalOrder.findUnique.mockResolvedValue(order as any)
    // Ample prelocked stock — the tally passes — but the engine reports 0 rows.
    updateAffectedRows(0)
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 5, fulfilledQty: 0 },
    ] as any)
    tx.externalOrder.update.mockResolvedValue({} as any)

    await expect(
      fulfillExternalOrder('order-1', 1, [{ itemId: 'item-1', quantity: 5 }], 42)
    ).rejects.toThrow('fulfil invariant: locked row 10:1 moved under the tally')

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
    // The row holds nothing: post-materialize it exists at { 0, 0 }, which the
    // pass-2a tally refuses before any UPDATE is issued.
    prelockedStock({ 10: 0 })
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

    // First item: ample stock, so it writes. Second item: the prelocked row
    // holds 1 against a request for 3, so the TALLY refuses it — B1.5 moved the
    // decision off the UPDATE's affected-row count.
    prelockedStock({ 10: 100, 20: 1 })
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
    expect(result.skipped[0].details).toBe(
      'Insufficient stock for Widget B. Available: 1, Requested: 3'
    )
  })
})
