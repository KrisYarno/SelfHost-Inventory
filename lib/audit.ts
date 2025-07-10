import prisma from '@/lib/prisma'
import { headers } from 'next/headers'
import { v4 as uuidv4 } from 'uuid'

export type AuditActionType = 
  | 'USER_APPROVAL'
  | 'USER_REJECTION'
  | 'USER_DELETION'
  | 'USER_UPDATE'
  | 'USER_BULK_APPROVAL'
  | 'USER_BULK_REJECTION'
  | 'PRODUCT_CREATE'
  | 'PRODUCT_UPDATE'
  | 'PRODUCT_DELETE'
  | 'PRODUCT_BULK_DELETE'
  | 'INVENTORY_ADJUSTMENT'
  | 'INVENTORY_STOCK_IN'
  | 'INVENTORY_DEDUCTION'
  | 'INVENTORY_BULK_UPDATE'
  | 'LOCATION_CREATE'
  | 'LOCATION_UPDATE'
  | 'LOCATION_DELETE'
  | 'SETTINGS_UPDATE'
  | 'EMAIL_SENT'
  | 'DATA_EXPORT'
  | 'SYSTEM_MAINTENANCE'

export type EntityType = 'USER' | 'PRODUCT' | 'INVENTORY' | 'LOCATION' | 'SETTINGS' | 'SYSTEM'

interface AuditLogEntry {
  userId: number
  actionType: AuditActionType
  entityType: EntityType
  entityId?: number
  action: string
  details?: Record<string, any>
  affectedCount?: number
  batchId?: string
}

interface AuditContext {
  ipAddress?: string
  userAgent?: string
}

class AuditService {
  private batchId: string | null = null

  /**
   * Start a batch operation - all subsequent logs will share the same batchId
   */
  startBatch(): string {
    this.batchId = uuidv4()
    return this.batchId
  }

  /**
   * End the current batch operation
   */
  endBatch(): void {
    this.batchId = null
  }

  /**
   * Get context information from request headers
   */
  private async getContext(): Promise<AuditContext> {
    try {
      const headersList = await headers()
      return {
        ipAddress: headersList.get('x-forwarded-for')?.split(',')[0] || 
                   headersList.get('x-real-ip') || 
                   undefined,
        userAgent: headersList.get('user-agent') || undefined
      }
    } catch {
      return {}
    }
  }

  /**
   * Log an audit entry
   */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      const context = await this.getContext()
      
      await prisma.auditLog.create({
        data: {
          userId: entry.userId,
          actionType: entry.actionType,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: entry.action,
          details: entry.details || undefined,
          affectedCount: entry.affectedCount || 1,
          batchId: this.batchId || entry.batchId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent
        }
      })
    } catch (error) {
      // Log to console but don't throw - audit logging should not break the main operation
      console.error('Audit logging failed:', error)
    }
  }

  /**
   * Log a user approval action
   */
  async logUserApproval(userId: number, targetUserId: number, targetEmail: string): Promise<void> {
    await this.log({
      userId,
      actionType: 'USER_APPROVAL',
      entityType: 'USER',
      entityId: targetUserId,
      action: `Approved user ${targetEmail}`,
      details: { targetEmail }
    })
  }

  /**
   * Log a user rejection action
   */
  async logUserRejection(userId: number, targetUserId: number, targetEmail: string): Promise<void> {
    await this.log({
      userId,
      actionType: 'USER_REJECTION',
      entityType: 'USER',
      entityId: targetUserId,
      action: `Rejected user ${targetEmail}`,
      details: { targetEmail }
    })
  }

  /**
   * Log bulk user approval
   */
  async logBulkUserApproval(userId: number, userIds: number[], emails: string[]): Promise<void> {
    const batchId = this.startBatch()
    await this.log({
      userId,
      actionType: 'USER_BULK_APPROVAL',
      entityType: 'USER',
      action: `Bulk approved ${userIds.length} users`,
      details: { userIds, emails },
      affectedCount: userIds.length,
      batchId
    })
    this.endBatch()
  }

  /**
   * Log bulk user rejection
   */
  async logBulkUserRejection(userId: number, userIds: number[], emails: string[]): Promise<void> {
    const batchId = this.startBatch()
    await this.log({
      userId,
      actionType: 'USER_BULK_REJECTION',
      entityType: 'USER',
      action: `Bulk rejected ${userIds.length} users`,
      details: { userIds, emails },
      affectedCount: userIds.length,
      batchId
    })
    this.endBatch()
  }

  /**
   * Log product creation
   */
  async logProductCreate(userId: number, productId: number, productName: string): Promise<void> {
    await this.log({
      userId,
      actionType: 'PRODUCT_CREATE',
      entityType: 'PRODUCT',
      entityId: productId,
      action: `Created product "${productName}"`,
      details: { productName }
    })
  }

  /**
   * Log product update
   */
  async logProductUpdate(userId: number, productId: number, productName: string, changes: Record<string, any>): Promise<void> {
    await this.log({
      userId,
      actionType: 'PRODUCT_UPDATE',
      entityType: 'PRODUCT',
      entityId: productId,
      action: `Updated product "${productName}"`,
      details: { productName, changes }
    })
  }

  /**
   * Log product deletion
   */
  async logProductDelete(userId: number, productId: number, productName: string): Promise<void> {
    await this.log({
      userId,
      actionType: 'PRODUCT_DELETE',
      entityType: 'PRODUCT',
      entityId: productId,
      action: `Deleted product "${productName}"`,
      details: { productName }
    })
  }

  /**
   * Log inventory adjustment
   */
  async logInventoryAdjustment(userId: number, productId: number, productName: string, delta: number, locationId: number): Promise<void> {
    await this.log({
      userId,
      actionType: 'INVENTORY_ADJUSTMENT',
      entityType: 'INVENTORY',
      entityId: productId,
      action: `Adjusted inventory for "${productName}" by ${delta > 0 ? '+' : ''}${delta}`,
      details: { productName, delta, locationId }
    })
  }

  /**
   * Log bulk inventory update
   */
  async logBulkInventoryUpdate(userId: number, updates: Array<{productId: number, productName: string, delta: number}>, locationId: number): Promise<void> {
    const batchId = this.startBatch()
    await this.log({
      userId,
      actionType: 'INVENTORY_BULK_UPDATE',
      entityType: 'INVENTORY',
      action: `Bulk updated inventory for ${updates.length} products`,
      details: { updates, locationId },
      affectedCount: updates.length,
      batchId
    })
    this.endBatch()
  }

  /**
   * Log data export
   */
  async logDataExport(userId: number, exportType: string, filters?: Record<string, any>): Promise<void> {
    await this.log({
      userId,
      actionType: 'DATA_EXPORT',
      entityType: 'SYSTEM',
      action: `Exported ${exportType} data`,
      details: { exportType, filters }
    })
  }

  /**
   * Retrieve audit logs with filtering
   */
  async getAuditLogs(filters: {
    userId?: number
    actionType?: AuditActionType
    entityType?: EntityType
    entityId?: number
    batchId?: string
    startDate?: Date
    endDate?: Date
    limit?: number
    offset?: number
  }) {
    const where: any = {}

    if (filters.userId) where.userId = filters.userId
    if (filters.actionType) where.actionType = filters.actionType
    if (filters.entityType) where.entityType = filters.entityType
    if (filters.entityId) where.entityId = filters.entityId
    if (filters.batchId) where.batchId = filters.batchId

    if (filters.startDate || filters.endDate) {
      where.createdAt = {}
      if (filters.startDate) where.createdAt.gte = filters.startDate
      if (filters.endDate) where.createdAt.lte = filters.endDate
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: filters.limit || 50,
        skip: filters.offset || 0
      }),
      prisma.auditLog.count({ where })
    ])

    return { logs, total }
  }

  /**
   * Get audit logs for a specific batch
   */
  async getBatchLogs(batchId: string) {
    return prisma.auditLog.findMany({
      where: { batchId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    })
  }
}

// Export singleton instance
export const auditService = new AuditService()