import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { auditService } from '@/lib/audit'
import type { AuditActionType, EntityType } from '@/lib/audit'
import { z } from 'zod'

// Input validation schema
const auditLogQuerySchema = z.object({
  userId: z.coerce.number().optional(),
  actionType: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.coerce.number().optional(),
  batchId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0)
})

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized - Admin access required' },
        { status: 401 }
      )
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url)
    const queryParams = Object.fromEntries(searchParams.entries())
    
    // Validate query parameters
    const validationResult = auditLogQuerySchema.safeParse(queryParams)
    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: validationResult.error.errors },
        { status: 400 }
      )
    }

    const filters = validationResult.data
    
    // Convert date strings to Date objects and cast types
    const processedFilters = {
      ...filters,
      actionType: filters.actionType as AuditActionType | undefined,
      entityType: filters.entityType as EntityType | undefined,
      startDate: filters.startDate ? new Date(filters.startDate) : undefined,
      endDate: filters.endDate ? new Date(filters.endDate) : undefined
    }

    // Retrieve audit logs
    const result = await auditService.getAuditLogs(processedFilters)

    return NextResponse.json({
      logs: result.logs,
      total: result.total,
      limit: filters.limit,
      offset: filters.offset
    })
  } catch (error) {
    console.error('Error retrieving audit logs:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve audit logs' },
      { status: 500 }
    )
  }
}

// GET specific batch logs
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized - Admin access required' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { batchId } = body

    if (!batchId || typeof batchId !== 'string') {
      return NextResponse.json(
        { error: 'Batch ID is required' },
        { status: 400 }
      )
    }

    const logs = await auditService.getBatchLogs(batchId)

    return NextResponse.json({ logs })
  } catch (error) {
    console.error('Error retrieving batch logs:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve batch logs' },
      { status: 500 }
    )
  }
}