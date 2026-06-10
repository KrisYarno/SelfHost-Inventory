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

jest.mock('@/lib/audit', () => ({
  auditService: {
    logBulkInventoryUpdate: jest.fn(),
  },
}))

// The route checks CSRF; the real impl reads next/headers cookies, which has no
// request context under jest, so it would fail every request with 403.
jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}))

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
          return await callback(mockTx)
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

      expect(response.status).toBe(500)
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
        return callback(tx)
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
        return callback(tx)
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

      const auditRecords: any[] = []
      const mockAuditService = require('@/lib/audit').auditService
      mockAuditService.logBulkInventoryUpdate.mockImplementation((userId: number, updates: any[]) => {
        auditRecords.push({ userId, updates })
      })

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
        }
        return callback(tx)
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
      expect(auditRecords).toHaveLength(1)
      expect(auditRecords[0].userId).toBe(1)
      expect(auditRecords[0].updates).toHaveLength(2)
      expect(auditRecords[0].updates[0]).toMatchObject({
        productId: 1,
        productName: 'Product Alpha',
        delta: 50
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
        }
        return callback(tx)
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
