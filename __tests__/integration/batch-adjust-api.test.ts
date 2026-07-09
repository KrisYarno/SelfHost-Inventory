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
jest.mock('@/lib/audit', () => ({
  auditService: {
    logBulkInventoryUpdate: jest.fn(),
  },
}))

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
        return callback(tx)
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
        return callback(capturedTx)
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
        return callback(tx)
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
        return callback(tx)
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
        return callback(tx)
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
    })

    it('should prevent negative inventory', async () => {
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
        return callback(tx)
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: -10 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      // apiHandler maps unrecognized errors to a flat 500 body
      expect(response.status).toBe(500)
      expect(data.error).toBe('Internal server error')
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
        return callback(tx)
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
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue([])
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
        return callback(tx)
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
  })
})
