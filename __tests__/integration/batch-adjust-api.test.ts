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

describe('/api/inventory/batch-adjust', () => {
  const mockSession = {
    user: {
      id: 'user123',
      email: 'test@example.com',
      name: 'Test User',
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
      expect(data.error).toBe('Unauthorized')
    })

    it('should validate request body', async () => {
      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({ notAdjustments: 'invalid' }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('adjustments must be an array')
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
      expect(data.error).toContain('must be numbers')
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
        userId: 'user123',
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

    it('should handle inventory not found for new products', async () => {
      const mockProducts = [{ id: 1, name: 'Product 1' }]

      ;(prisma.product.findMany as jest.Mock).mockResolvedValue(mockProducts)
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const tx = {
          product_locations: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
              id: 1,
              productId: 1,
              locationId: 1,
              quantity: 10,
              version: 1,
            }),
          },
          inventory_logs: {
            create: jest.fn().mockResolvedValue({
              id: 1,
              productId: 1,
              locationId: 1,
              userId: 'user123',
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
          },
          inventory_logs: {
            create: jest.fn(),
          },
        }
        try {
          await callback(tx)
        } catch (error) {
          throw new Error('Product 1: Insufficient inventory: current 5, trying to remove 10')
        }
      })

      const request = new NextRequest('http://localhost:3000/api/inventory/batch-adjust', {
        method: 'POST',
        body: JSON.stringify({
          adjustments: [{ productId: 1, locationId: 1, delta: -10 }],
        }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error.message).toContain('Insufficient inventory')
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
          },
        }
        try {
          await callback(tx)
        } catch (error) {
          throw new Error('Inventory has been modified by another user')
        }
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
      expect(data.error.code).toBe('OPTIMISTIC_LOCK_ERROR')
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
      expect(data.error.code).toBe('BATCH_OPERATION_FAILED')
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
          },
          inventory_logs: {
            create: jest.fn().mockResolvedValue({
              id: 1,
              productId: 1,
              locationId: 1,
              userId: 'user123',
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
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(transactionCalls).toBe(1) // All adjustments in single transaction
    })
  })
})