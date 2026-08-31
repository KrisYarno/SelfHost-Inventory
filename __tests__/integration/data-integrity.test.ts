/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/inventory/batch-adjust/route'
import { getServerSession } from 'next-auth'
import prisma from '@/lib/prisma'

jest.mock('next-auth', () => ({
  getServerSession: jest.fn(),
}))


// The route now records its change in-transaction; audit behavior is covered by
// __tests__/integration/api/change-tracking-inventory.test.ts. Stub it here so
// these data-integrity assertions stay focused on the stock write path.
jest.mock('@/lib/change-tracking', () => ({
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'batch-test'),
}))

// The route checks CSRF; the real impl reads next/headers cookies, which has no
// request context under jest, so it would fail every request with 403.
jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}))

// ---------------------------------------------------------------------------
// THE RECORDING RAW TRIO (pack CB0.3, the per-suite paragraph).
//
// This suite hand-builds the tx object it hands the route, so the global
// harness's trio never reaches the route's transaction. B1a-ii opened that
// transaction with the canonical prelock, so every hand-built tx gets the trio
// spread in — and the rows the prelock's returning SELECT hands back are what
// the version guard and the stock floor read, in place of the retired per-item
// `product_locations.findFirst`.
// ---------------------------------------------------------------------------
type RawCall = { kind: 'query' | 'execute' | 'executeUnsafe'; sql: string; at: number }

const rawCalls: RawCall[] = []
const rawBehavior: Record<string, jest.Mock> = {}
let rawSeq = 0

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === 'object' && typeof (arg as { sql?: unknown }).sql === 'string'
    ? (arg as { sql: string }).sql
    : String(arg)
}

function isPrelockSelect(sql: string): boolean {
  return sql.includes('FROM product_locations') && sql.includes('(productId, locationId) IN')
}

type PrelockRow = { productId: number; locationId: number; quantity: number; version: number }

/** Install the trio on a hand-built tx and seed what the prelock returns. */
function withRecordingRaw<T extends object>(tx: T, prelockRows: PrelockRow[]): T {
  const target = tx as unknown as Record<string, unknown>
  const install = (kind: RawCall['kind'], method: string, make: () => unknown) => {
    const behavior = jest.fn((..._args: unknown[]) => Promise.resolve(make()))
    const recording = jest.fn((...args: unknown[]) => {
      rawCalls.push({ kind, sql: sqlTextOf(args[0]), at: rawSeq++ })
      return behavior(...args)
    })
    rawBehavior[method] = behavior
    target[method] = recording
  }
  install('query', '$queryRaw', () => [])
  install('execute', '$executeRaw', () => 0)
  install('executeUnsafe', '$executeRawUnsafe', () => 0)
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) =>
    isPrelockSelect(sqlTextOf(args[0])) ? prelockRows : []
  )
  return tx
}

/** Every key at one location, stocked the same — the bulk fixtures' shape. */
function stockedAt(
  locationId: number,
  productIds: number[],
  quantity: number,
  version: number
): PrelockRow[] {
  return productIds.map((productId) => ({ productId, locationId, quantity, version }))
}

describe('Data Integrity Tests', () => {
  // Must satisfy requireApproved(): email present + isApproved true + numeric id
  const mockSession = {
    user: {
      id: 1,
      email: 'test@example.com',
      name: 'Test User',
      isAdmin: false,
      isApproved: true,
      defaultLocationId: 1,
    },
  }

  beforeEach(() => {
    jest.clearAllMocks()
    rawCalls.length = 0
    ;(getServerSession as jest.Mock).mockResolvedValue(mockSession)
  })

  describe('Transaction Atomicity', () => {
    it('should rollback all changes if any adjustment fails', async () => {
      const mockProducts = [
        { id: 1, name: 'Product 1' },
        { id: 2, name: 'Product 2' },
        { id: 3, name: 'Product 3' },
      ]

      let writeCalls = 0
      const mockTx = {
        product_locations: {
          findFirst: jest.fn()
            .mockResolvedValueOnce({ id: 1, quantity: 100, version: 1 }) // Product 1
            .mockResolvedValueOnce({ id: 2, quantity: 50, version: 1 })  // Product 2
            .mockResolvedValueOnce({ id: 3, quantity: 5, version: 1 }),  // Product 3 - will fail
          upsert: jest.fn().mockImplementation(() => {
            writeCalls++
            return Promise.resolve({ id: 1, quantity: 1, version: 2 })
          }),
        },
        product: {
          update: jest.fn(),
        },
        inventory_logs: {
          create: jest.fn().mockResolvedValue({ id: 1, delta: 0 }),
        },
      }

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        try {
          return await callback(
            withRecordingRaw(mockTx, [
              { productId: 1, locationId: 1, quantity: 100, version: 1 },
              { productId: 2, locationId: 1, quantity: 50, version: 1 },
              // Product 3 cannot pay the -10: the floor refuses and the whole
              // transaction goes with it.
              { productId: 3, locationId: 1, quantity: 5, version: 1 },
            ])
          )
        } catch (error) {
          // Transaction rolls back: no writes persist
          writeCalls = 0
          throw error
        }
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 50 },
            { productId: 2, locationId: 1, delta: -25 },
            { productId: 3, locationId: 1, delta: -10 }, // This will fail (insufficient stock)
          ],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      // B1a-ii: the floor refusal is a typed 400 now — it used to reach the wire
      // as a generic 500, which told the operator nothing. What this pin is
      // about is unchanged: the whole batch rolls back.
      expect(response.status).toBe(400)
      expect(data.code).toBe('INSUFFICIENT_STOCK')
      expect(writeCalls).toBe(0) // No updates should persist
    })

    it('should maintain data consistency across related records', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]

      let inventoryUpdated = false
      let logCreated = false

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue({ id: 1, quantity: 100, version: 1 }),
            upsert: jest.fn().mockImplementation(() => {
              inventoryUpdated = true
              return Promise.resolve({ id: 1, quantity: 150, version: 2 })
            }),
          },
          product: {
            update: jest.fn(),
          },
          inventory_logs: {
            create: jest.fn().mockImplementation(() => {
              logCreated = true
              return Promise.resolve({ id: 1, delta: 50 })
            }),
          },
        }
        return callback(
          withRecordingRaw(tx, [{ productId: 1, locationId: 1, quantity: 100, version: 1 }])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: 50 }],
        }),
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(inventoryUpdated).toBe(true)
      expect(logCreated).toBe(true)
    })
  })

  describe('Concurrent Modification Protection', () => {
    it('should handle race conditions between validation and execution', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]

      // Another transaction bumped the version between the client's read
      // (expectedVersion: 1) and this transaction's read (version: 2)
      const mockFindFirst = jest.fn()
        .mockResolvedValueOnce({ id: 1, quantity: 90, version: 2 })

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: mockFindFirst,
            upsert: jest.fn(),
          },
          product: { update: jest.fn() },
          inventory_logs: { create: jest.fn() },
        }
        // Let the route's OptimisticLockError propagate untouched
        return callback(
          withRecordingRaw(tx, [{ productId: 1, locationId: 1, quantity: 90, version: 2 }])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: -50, expectedVersion: 1 }],
        }),
      })

      const response = await POST(request)

      expect(response.status).toBe(409)
      const data = await response.json()
      expect(data.code).toBe('OPTIMISTIC_LOCK_ERROR')
    })
  })

  describe('Audit Trail Integrity', () => {
    it('should create complete audit records for all changes', async () => {
      const mockProducts = [
        { id: 1, name: 'Product Alpha' },
        { id: 2, name: 'Product Beta' },
      ]

      const { recordChange } = require('@/lib/change-tracking')
      ;(recordChange as jest.Mock).mockClear()

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const logs: any[] = []
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue({ id: 1, quantity: 100, version: 1 }),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 150, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: {
            create: jest.fn().mockImplementation((data: any) => {
              const log = { id: logs.length + 1, ...data.data }
              logs.push(log)
              return Promise.resolve(log)
            }),
          },
          // Reconciliation lane R-A: a batch with a negative delta now records
          // one attribution attempt on the same tx (pinned exactly in
          // batch-adjust-api.test.ts); the stand-in just has to exist.
          orderAttributionAttempt: { create: jest.fn().mockResolvedValue({ id: 1 }) },
        }
        return callback(withRecordingRaw(tx, stockedAt(1, [1, 2], 100, 1)))
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 50 },
            { productId: 2, locationId: 1, delta: -25 },
          ],
        }),
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      // The single bulk-update change is recorded in-transaction via recordChange.
      expect(recordChange).toHaveBeenCalledTimes(1)
      const event = (recordChange as jest.Mock).mock.calls[0][1]
      expect(event.actor.userId).toBe(1)
      expect(event.actionType).toBe('INVENTORY_BULK_UPDATE')
      expect(event.details.updates).toHaveLength(2)
      expect(event.details.updates[0]).toMatchObject({
        productId: 1,
        productName: 'Product Alpha',
        delta: 50,
      })
    })
  })

  describe('Boundary Conditions', () => {
    it('should handle very large batch operations', async () => {
      const largeProductSet = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        name: `Product ${i + 1}`
      }))

      const largeAdjustmentSet = largeProductSet.map((p, i) => ({
        productId: p.id,
        locationId: 1,
        // Deterministic, never zero (schema rejects delta === 0)
        delta: (i % 2 === 0 ? 1 : -1) * ((i % 10) + 1),
      }))

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(largeProductSet)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue({ id: 1, quantity: 1000, version: 1 }),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 1000, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: {
            create: jest.fn().mockImplementation((data: any) =>
              Promise.resolve({ id: 1, ...data.data })
            ),
          },
          // Reconciliation lane R-A: see above.
          orderAttributionAttempt: { create: jest.fn().mockResolvedValue({ id: 1 }) },
        }
        return callback(
          withRecordingRaw(
            tx,
            stockedAt(1, largeProductSet.map((p) => p.id), 1000, 1)
          )
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({ adjustments: largeAdjustmentSet }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.count).toBe(100)
    })

  })

  describe('Error Recovery', () => {
    it('should not leak internal error details in the response', async () => {
      const mockProducts = [
        { id: 1, name: 'Widget A' },
        { id: 2, name: 'Gadget B' },
        { id: 3, name: 'Tool C' },
      ]

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async () => {
        throw new Error('Product 2: Insufficient inventory: current 10, trying to remove 15')
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 50 },
            { productId: 2, locationId: 1, delta: -15 }, // This one fails
            { productId: 3, locationId: 1, delta: 20 },
          ],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      // apiHandler maps unrecognized errors to a flat generic 500 body
      expect(response.status).toBe(500)
      expect(data.error).toBe('Internal server error')
    })
  })
})
