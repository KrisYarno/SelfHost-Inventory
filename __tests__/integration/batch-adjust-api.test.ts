/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/inventory/batch-adjust/route'
import { getServerSession } from 'next-auth'
import prisma from '@/lib/prisma'

// Mock next-auth
jest.mock('next-auth', () => ({
  getServerSession: jest.fn(),
}))

// Mock audit service

// Change-tracking is exercised end-to-end in
// __tests__/integration/api/change-tracking-inventory.test.ts; here the route's
// in-tx recordChange is stubbed so these stock-mechanics assertions stay focused.
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
// This suite runs on the GLOBAL `@/lib/prisma` mock but HAND-BUILDS the tx
// object each `$transaction` stub hands the route, so the harness's trio never
// reaches the route's transaction. Every hand-built tx therefore gets the trio
// spread in: without it the canonical prelock's two statements would crash on
// an undefined method rather than run.
//
// Two layers, as everywhere else in B1: the OUTER fn always records and then
// delegates to an INNER behaviour fn, which is what a test configures.
// ---------------------------------------------------------------------------
type RawCall = { kind: 'query' | 'execute' | 'executeUnsafe'; sql: string; at: number }

/** Every raw statement the test under way has spent, in call order. */
const rawCalls: RawCall[] = []
/** The INNER behaviour fns, by method name — what a test configures. */
const rawBehavior: Record<string, jest.Mock> = {}
/** The OUTER recording fns — for `invocationCallOrder` against the delegates. */
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
  install('execute', '$executeRaw', () => 0)
  install('executeUnsafe', '$executeRawUnsafe', () => 0)
}

/** The prelock's returning SELECT (lib/inventory/prelock.ts), by its text. */
function isPrelockSelect(sql: string): boolean {
  return sql.includes('FROM product_locations') && sql.includes('(productId, locationId) IN')
}

type PrelockRow = { productId: number; locationId: number; quantity: number; version: number }

/**
 * Install the trio on a hand-built tx and seed what the prelock's returning
 * SELECT hands back. The per-item `product_locations.findFirst` retired with the
 * prelock (pack CB1a-ii.2), so the fixtures that read `{ quantity, version }`
 * off that read are spelled here as the materialized rows the version guard and
 * the stock floor now read.
 */
function withRecordingRaw<T extends object>(tx: T, prelockRows: PrelockRow[]): T {
  installRecordingRaw(tx as unknown as Record<string, unknown>)
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) =>
    isPrelockSelect(sqlTextOf(args[0])) ? prelockRows : []
  )
  return tx
}

describe('/api/inventory/batch-adjust', () => {
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

  describe('POST', () => {
    it('should require authentication', async () => {
      ;(getServerSession as jest.Mock).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({ adjustments: [] }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(401)
      expect(data.error).toBe('Authentication required')
      expect(data.code).toBe('UNAUTHORIZED')
    })

    it('should validate request body', async () => {
      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({ notAdjustments: 'invalid' }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.code).toBe('VALIDATION_ERROR')
      expect(typeof data.error).toBe('string')
    })

    it('should validate adjustment data types', async () => {
      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 'not-a-number', locationId: 1, delta: 10 },
          ],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.code).toBe('VALIDATION_ERROR')
    })

    it('should successfully process valid adjustments', async () => {
      const mockProducts = [
        { id: 1, name: 'Product 1' },
        { id: 2, name: 'Product 2' },
      ]

      const mockInventory = {
        id: 1,
        quantity: 50,
        version: 1,
      }

      const mockLog = {
        id: 1,
        productId: 1,
        locationId: 1,
        userId: 1,
        delta: 10,
        changeTime: new Date(),
        logType: 'ADJUSTMENT',
      }

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(mockInventory),
            update: jest.fn(),
            create: jest.fn(),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 60, version: 2 }),
          },
          product: {
            update: jest.fn(),
          },
          inventory_logs: {
            create: jest.fn().mockResolvedValue(mockLog),
          },
        }
        return callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: mockInventory.quantity, version: mockInventory.version },
            { productId: 2, locationId: 1, quantity: mockInventory.quantity, version: mockInventory.version },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 10 },
            { productId: 2, locationId: 1, delta: -5 },
          ],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.count).toBe(2)
    })

    it('uses atomic increment (no absolute quantity write)', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]
      const mockInventory = { id: 1, quantity: 50, version: 1 }

      let capturedTx: any
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        capturedTx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(mockInventory),
            update: jest.fn(),
            create: jest.fn(),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 60, version: 2 }),
          },
          product: {
            update: jest.fn(),
          },
          inventory_logs: {
            create: jest.fn().mockResolvedValue({ id: 1, delta: 10 }),
          },
        }
        return callback(
          withRecordingRaw(capturedTx, [
            { productId: 1, locationId: 1, quantity: mockInventory.quantity, version: mockInventory.version },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: 10 }],
        }),
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      // The write must be a relative increment, not an absolute quantity computed
      // from a stale read (the lost-update race).
      expect(capturedTx.product_locations.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            quantity: { increment: 10 },
            version: { increment: 1 },
          }),
        })
      )
      // No absolute-quantity update path anymore
      expect(capturedTx.product_locations.update).not.toHaveBeenCalled()
    })

    it('version conflict returns 409 OPTIMISTIC_LOCK_ERROR', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]
      const mockInventory = { id: 1, quantity: 50, version: 3 }

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(mockInventory),
            upsert: jest.fn(),
          },
          product: { update: jest.fn() },
          inventory_logs: { create: jest.fn() },
        }
        return callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: mockInventory.quantity, version: mockInventory.version },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: 10, expectedVersion: 1 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(409)
      expect(data.code).toBe('OPTIMISTIC_LOCK_ERROR')
      expect(data.currentVersion).toBe(3)
      expect(data.expectedVersion).toBe(1)
    })

    it('response logs carry no relations (no users/passwordHash leak)', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]
      const mockInventory = { id: 1, quantity: 50, version: 1 }

      // createInventoryLog includes full relations; the route must strip them
      const mockLogWithRelations = {
        id: 1,
        productId: 1,
        locationId: 1,
        userId: 1,
        delta: 10,
        changeTime: new Date(),
        logType: 'ADJUSTMENT',
        users: { id: 1, email: 'test@example.com', passwordHash: 'super-secret-hash' },
        products: { id: 1, name: 'Product 1' },
        locations: { id: 1, name: 'Main' },
      }

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(mockInventory),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 60, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: {
            create: jest.fn().mockResolvedValue(mockLogWithRelations),
          },
        }
        return callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: mockInventory.quantity, version: mockInventory.version },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: 10 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.logs).toHaveLength(1)
      expect(data.logs[0]).not.toHaveProperty('users')
      expect(data.logs[0]).not.toHaveProperty('products')
      expect(data.logs[0]).not.toHaveProperty('locations')
      expect(JSON.stringify(data)).not.toContain('passwordHash')
      // Scalars are preserved
      expect(data.logs[0].delta).toBe(10)
    })

    it('should handle inventory not found for new products', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]
      let capturedTx: any

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
            upsert: jest.fn().mockResolvedValue({
              id: 1,
              productId: 1,
              locationId: 1,
              quantity: 10,
              version: 1,
            }),
          },
          product: { update: jest.fn() },
          inventory_logs: {
            create: jest.fn().mockResolvedValue({
              id: 1,
              productId: 1,
              locationId: 1,
              userId: 1,
              delta: 10,
              changeTime: new Date(),
              logType: 'ADJUSTMENT',
            }),
          },
        }
        capturedTx = tx
        // Never stocked: the materialize creates the row and the returning
        // SELECT hands back the live column defaults, so the guards read
        // { quantity: 0, version: 0 } instead of skipping on an absent row.
        return callback(withRecordingRaw(tx, []))
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: 10 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      // The per-item read is retired — the prelock's rows ARE the read.
      expect(capturedTx.product_locations.findFirst).not.toHaveBeenCalled()
    })

    // -----------------------------------------------------------------------
    // B1a-ii (pack CB1a-ii.2): the stock floor. These refusals used to reach the
    // wire as a GENERIC 500 — a plain Error is not a class apiHandler maps — so
    // the sentence the spec pins was unreachable. They are 400s now, and the
    // never-stocked case reaches the SAME sentence instead of the dead
    // "No inventory found" branch.
    // -----------------------------------------------------------------------
    it('refuses an over-deduction with 400 INSUFFICIENT_STOCK and the real numbers', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]
      const mockInventory = {
        id: 1,
        quantity: 5,
        version: 1,
      }

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(mockInventory),
            upsert: jest.fn(),
          },
          product: { update: jest.fn() },
          inventory_logs: {
            create: jest.fn(),
          },
        }
        return callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: mockInventory.quantity, version: mockInventory.version },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: -10 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.code).toBe('INSUFFICIENT_STOCK')
      expect(data.error).toBe(
        'Product 1: Insufficient inventory: current 5, trying to remove 10'
      )
    })

    it('refuses a NEVER-STOCKED negative delta with current 0 — the dead branch is gone', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]
      let capturedTx: any

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(null),
            upsert: jest.fn(),
          },
          product: { update: jest.fn() },
          inventory_logs: { create: jest.fn() },
        }
        capturedTx = tx
        return callback(withRecordingRaw(tx, []))
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: -10 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.code).toBe('INSUFFICIENT_STOCK')
      // Not "No inventory found for product 1 at location 1" — that branch was
      // dead the moment the prelock started materializing the row.
      expect(data.error).toBe(
        'Product 1: Insufficient inventory: current 0, trying to remove 10'
      )
      expect(capturedTx.product_locations.findFirst).not.toHaveBeenCalled()
    })

    it('prelocks BEFORE any write: the two statements lead the transaction', async () => {
      const mockProducts = [
        { id: 1, name: 'Product 1' },
        { id: 2, name: 'Product 2' },
      ]
      let capturedTx: any

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn(),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 60, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: {
            create: jest.fn().mockResolvedValue({ id: 1, delta: 10 }),
          },
        }
        capturedTx = tx
        return callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: 50, version: 1 },
            { productId: 2, locationId: 1, quantity: 50, version: 1 },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 2, locationId: 1, delta: 10 },
            { productId: 1, locationId: 1, delta: -5 },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)

      // Statements 1-2 of the transaction, in that order, and nothing before.
      expect(rawCalls).toHaveLength(2)
      expect(rawCalls[0].kind).toBe('execute')
      expect(rawCalls[0].sql).toContain(
        'INSERT INTO product_locations (productId, locationId, quantity, version, updatedAt)'
      )
      expect(rawCalls[1].kind).toBe('query')
      expect(isPrelockSelect(rawCalls[1].sql)).toBe(true)
      expect(rawCalls[1].sql).toContain('FOR UPDATE')
      // Canonical order, not request order: the request named product 2 first.
      expect((rawFns.$executeRaw.mock.calls[0][0] as any).values).toEqual([1, 1, 2, 1])
      // …and both precede every delegate write.
      expect(rawFns.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        capturedTx.inventory_logs.create.mock.invocationCallOrder[0]
      )
    })

    it('a key named TWICE keeps its own-write-visible semantics through the tally', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]
      let capturedTx: any

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn(),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 0, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: {
            create: jest.fn().mockResolvedValue({ id: 1, delta: -5 }),
          },
        }
        capturedTx = tx
        return callback(
          withRecordingRaw(tx, [{ productId: 1, locationId: 1, quantity: 8, version: 1 }])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: -5, expectedVersion: 1 },
            // 8 - 5 = 3 left, and the row is at version 2 by now: the second
            // item sees the first item's effect, exactly as the retired
            // own-write-visible read gave it. Asking for 5 more is refused.
            { productId: 1, locationId: 1, delta: -5, expectedVersion: 2 },
          ],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.code).toBe('INSUFFICIENT_STOCK')
      expect(data.error).toBe(
        'Product 1: Insufficient inventory: current 3, trying to remove 5'
      )
      // One prelock for the deduped key, not one per item.
      expect(rawCalls.filter((c) => c.kind === 'execute')).toHaveLength(1)
      expect((rawFns.$executeRaw.mock.calls[0][0] as any).values).toEqual([1, 1])
      // PIN DELTA (pack REV-22 F1, guards-first): the first item no longer
      // writes before the second is refused. It used to (`create` ×1) and the
      // transaction rolled it back, so the WIRE envelope is unchanged — what
      // changed is that a refusing request holds no ledger-insert `products` FK
      // lock while it refuses, which is the deadlock this fix closes.
      expect(capturedTx.inventory_logs.create).not.toHaveBeenCalled()
    })

    it('should handle optimistic locking conflicts', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]
      const mockInventory = {
        id: 1,
        quantity: 50,
        version: 2, // Different from expected
      }

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(mockInventory),
            upsert: jest.fn(),
          },
          product: { update: jest.fn() },
          inventory_logs: { create: jest.fn() },
        }
        // Let the route's OptimisticLockError propagate untouched
        return callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: mockInventory.quantity, version: mockInventory.version },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: 10, expectedVersion: 1 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(409)
      expect(data.code).toBe('OPTIMISTIC_LOCK_ERROR')
    })

    it('should handle transaction failures', async () => {
      // The product read is seeded (it was `[]` before pack REV-22 F10, which
      // now refuses an unknown id with a 400 BEFORE the transaction opens) —
      // this test is about what an infrastructure failure INSIDE the tx answers.
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 1, name: 'Product 1' }])
      ;(prisma.$transaction as jest.Mock).mockRejectedValue(new Error('Database error'))

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: 10 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Internal server error')
    })

    it('should process multiple adjustments atomically', async () => {
      const mockProducts = [
        { id: 1, name: 'Product 1' },
        { id: 2, name: 'Product 2' },
        { id: 3, name: 'Product 3' },
      ]

      let transactionCalls = 0
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        transactionCalls++
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue({
              id: 1,
              quantity: 100,
              version: 1,
            }),
            update: jest.fn(),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 110, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: {
            create: jest.fn().mockResolvedValue({
              id: 1,
              productId: 1,
              locationId: 1,
              userId: 1,
              delta: 10,
              changeTime: new Date(),
              logType: 'ADJUSTMENT',
            }),
          },
        }
        return callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: 100, version: 1 },
            { productId: 2, locationId: 1, quantity: 100, version: 1 },
            { productId: 3, locationId: 1, quantity: 100, version: 1 },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 10 },
            { productId: 2, locationId: 1, delta: -5 },
            { productId: 3, locationId: 1, delta: 15 },
          ],
        }),
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(transactionCalls).toBe(1) // All adjustments in single transaction
    })

    // -----------------------------------------------------------------------
    // Reconciliation lane R-A (spec REV-7 D1/D2, pack C1b.3): the ATTEMPT ROW.
    //
    // The journal offers no order context of any kind, so its class is the
    // constant none/no-order-context — ONE row per batch, and only when the
    // batch actually took stock out. An all-positive batch still records its
    // bulk-update audit event; recording an attempt for it would put a "we could
    // not attribute this" row in the report for a restock.
    // -----------------------------------------------------------------------

    /** A tx whose ledger rows echo the requested deltas, with distinct ids. */
    function txEchoingDeltas() {
      let nextId = 900
      return {
        product_locations: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, quantity: 100, version: 1 }),
          update: jest.fn(),
          create: jest.fn(),
          upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 100, version: 2 }),
        },
        product: { update: jest.fn() },
        inventory_logs: {
          create: jest.fn().mockImplementation(async ({ data }: any) => ({
            id: nextId++,
            productId: data.productId,
            locationId: data.locationId,
            userId: data.userId,
            delta: data.delta,
            changeTime: new Date(),
            logType: data.logType,
          })),
        },
        orderAttributionAttempt: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      }
    }

    it('a MIXED-SIGN batch records ONE attempt against the FIRST negative row', async () => {
      const tx = txEchoingDeltas()
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
        { id: 1, name: 'Product 1' },
        { id: 2, name: 'Product 2' },
        { id: 3, name: 'Product 3' },
      ])
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: 100, version: 1 },
            { productId: 2, locationId: 1, quantity: 100, version: 1 },
            { productId: 3, locationId: 1, quantity: 100, version: 1 },
          ])
        )
      )

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 10 },
            { productId: 2, locationId: 1, delta: -5 },
            { productId: 3, locationId: 1, delta: -7 },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)

      expect(tx.orderAttributionAttempt.create).toHaveBeenCalledTimes(1)
      expect((tx.orderAttributionAttempt.create.mock.calls[0][0] as any).data).toEqual({
        batchId: 'batch-test',
        // The SECOND log written (id 901) — the first one with delta < 0, not
        // simply the first row of the batch.
        ledgerRowId: 901,
        outcome: 'none',
        evidence: null,
        reason: 'no-order-context',
        orderRecordId: null,
        previousOrderRecordId: null,
        source: 'live-batch-adjust',
        actorUserId: 1,
      })
    })

    it('an ALL-POSITIVE batch records NO attempt, though recordChange still fires', async () => {
      const tx = txEchoingDeltas()
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
        { id: 1, name: 'Product 1' },
        { id: 2, name: 'Product 2' },
      ])
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback(
          withRecordingRaw(tx, [
            { productId: 1, locationId: 1, quantity: 100, version: 1 },
            { productId: 2, locationId: 1, quantity: 100, version: 1 },
            { productId: 3, locationId: 1, quantity: 100, version: 1 },
          ])
        )
      )

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 10 },
            { productId: 2, locationId: 1, delta: 4 },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)

      expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled()
    })

    // -----------------------------------------------------------------------
    // FIX ROUND 1 (pack REV-22).
    //
    // F1 — GUARDS FIRST. Every adjustment is validated against a simulation of
    // the tally before the write loop opens, so a request that will refuse ANY
    // item holds nothing but its prelock when it does. The wire envelope is
    // unchanged (the transaction aborted the earlier writes anyway); the
    // statement ORDER is what moved.
    // F10 — an id no product answers to is a 400, not a foreign-key 500.
    // F3  — the route spends the covered writers' shared transaction budget.
    // -----------------------------------------------------------------------
    it('F1: a LAST-item refusal writes NOTHING — the payable first item included', async () => {
      const mockProducts = [
        { id: 1, name: 'Product 1' },
        { id: 2, name: 'Product 2' },
      ]
      let capturedTx: any

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        capturedTx = {
          product_locations: {
            findFirst: jest.fn(),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 60, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: { create: jest.fn().mockResolvedValue({ id: 1, delta: 10 }) },
        }
        return callback(
          withRecordingRaw(capturedTx, [
            { productId: 1, locationId: 1, quantity: 50, version: 1 },
            { productId: 2, locationId: 1, quantity: 1, version: 1 },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 10 },
            { productId: 2, locationId: 1, delta: -5 },
          ],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.code).toBe('INSUFFICIENT_STOCK')
      expect(data.error).toBe(
        'Product 2: Insufficient inventory: current 1, trying to remove 5'
      )
      // Nothing was written, and the only statements spent are the prelock's.
      expect(capturedTx.inventory_logs.create).not.toHaveBeenCalled()
      expect(capturedTx.product_locations.upsert).not.toHaveBeenCalled()
      expect(rawCalls.map((c) => c.kind)).toEqual(['execute', 'query'])
    })

    it('F1: a LAST-item version conflict writes nothing either', async () => {
      let capturedTx: any
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
        { id: 1, name: 'Product 1' },
        { id: 2, name: 'Product 2' },
      ])
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        capturedTx = {
          product_locations: {
            findFirst: jest.fn(),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 60, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: { create: jest.fn().mockResolvedValue({ id: 1, delta: 10 }) },
        }
        return callback(
          withRecordingRaw(capturedTx, [
            { productId: 1, locationId: 1, quantity: 50, version: 1 },
            { productId: 2, locationId: 1, quantity: 50, version: 4 },
          ])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 10 },
            { productId: 2, locationId: 1, delta: 10, expectedVersion: 1 },
          ],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(409)
      expect(data.code).toBe('OPTIMISTIC_LOCK_ERROR')
      expect(capturedTx.inventory_logs.create).not.toHaveBeenCalled()
    })

    it('F10: an unknown productId is a 404 PRODUCT_NOT_FOUND (the house class), before the transaction', async () => {
      // The pre-read that feeds the audit line already knows: product 42 is not
      // a product. Letting it through materialized a row for it and killed the
      // whole transaction on the ledger row's foreign key — a generic 500.
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 1, name: 'Product 1' }])

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [
            { productId: 1, locationId: 1, delta: 10 },
            { productId: 42, locationId: 1, delta: 5 },
          ],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      // Fix-delta FDb-2: ProductNotFoundError — the code already means 404 +
      // this sentence on stock-in; one code must not carry two statuses.
      expect(response.status).toBe(404)
      expect(data.code).toBe('PRODUCT_NOT_FOUND')
      expect(data.error).toBe('Product with ID 42 not found')
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('F3: the route transaction carries the covered writers\' budget', async () => {
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 1, name: 'Product 1' }])
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn(),
            upsert: jest.fn().mockResolvedValue({ id: 1, quantity: 60, version: 2 }),
          },
          product: { update: jest.fn() },
          inventory_logs: { create: jest.fn().mockResolvedValue({ id: 1, delta: 10 }) },
        }
        return callback(
          withRecordingRaw(tx, [{ productId: 1, locationId: 1, quantity: 50, version: 1 }])
        )
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: 10 }],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      expect((prisma.$transaction as jest.Mock).mock.calls[0][1]).toEqual({
        maxWait: 5000,
        timeout: 30000,
      })
    })
  })
})
