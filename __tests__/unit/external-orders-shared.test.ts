/**
 * @jest-environment node
 */

import { mockDeep, mockReset } from 'jest-mock-extended'
import type { PrismaClient } from '@prisma/client'
import type { NormalizedOrder } from '@/lib/platforms/core/types'
import {
  deriveInternalStatus,
  decryptOrNull,
  hostFromStoreUrl,
  upsertOrderWithItems,
} from '@/lib/external-orders/shared'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/lib/encryption', () => ({
  isEncrypted: jest.fn((value: string) => {
    const parts = value.split('.')
    if (parts.length !== 3) return false
    const base64Regex = /^[A-Za-z0-9+/]+=*$/
    return parts.every((p: string) => p.length > 0 && base64Regex.test(p))
  }),
  decryptValue: jest.fn((value: string) => `decrypted:${value}`),
}))

jest.mock('@/lib/external-orders/meta', () => ({
  deriveExternalOrderMeta: jest.fn(() => ({
    platformStatusRaw: { status: 'processing' },
    externalStatusHash: 'hash123',
    externalOrderUrl: 'https://store.test/admin/orders/ext-1',
    externalUpdatedAt: new Date('2025-01-15T00:00:00Z'),
    lastSeenAt: new Date('2025-06-01T00:00:00Z'),
  })),
}))

// Deep-mock the Prisma client
const mockPrisma = mockDeep<PrismaClient>()

beforeEach(() => {
  mockReset(mockPrisma)
  jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Helper: build a minimal NormalizedOrder
// ---------------------------------------------------------------------------

function buildNormalizedOrder(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    externalId: 'ext-1',
    externalOrderNumber: '#1001',
    platform: 'WOOCOMMERCE',
    nativeStatus: 'processing',
    financialStatus: null,
    fulfillmentStatus: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    customer: { email: 'test@example.com', name: 'Test User' },
    lineItems: [],
    currency: 'USD',
    total: 99.99,
    rawPayload: {},
    ...overrides,
  }
}

// ===========================================================================
// deriveInternalStatus
// ===========================================================================

describe('deriveInternalStatus', () => {
  it('WooCommerce: "completed" maps to "fulfilled"', () => {
    const result = deriveInternalStatus('WOOCOMMERCE', {
      nativeStatus: 'completed',
      financialStatus: null,
      fulfillmentStatus: null,
    })
    expect(result).toBe('fulfilled')
  })

  it('WooCommerce: "processing" maps to "processing"', () => {
    const result = deriveInternalStatus('WOOCOMMERCE', {
      nativeStatus: 'processing',
      financialStatus: null,
      fulfillmentStatus: null,
    })
    expect(result).toBe('processing')
  })

  it('WooCommerce: "cancelled" maps to "cancelled"', () => {
    const result = deriveInternalStatus('WOOCOMMERCE', {
      nativeStatus: 'cancelled',
      financialStatus: null,
      fulfillmentStatus: null,
    })
    expect(result).toBe('cancelled')
  })

  it('WooCommerce: "failed" maps to "cancelled"', () => {
    const result = deriveInternalStatus('WOOCOMMERCE', {
      nativeStatus: 'failed',
      financialStatus: null,
      fulfillmentStatus: null,
    })
    expect(result).toBe('cancelled')
  })

  it('WooCommerce: unknown status "on-hold" falls back to "pending"', () => {
    const result = deriveInternalStatus('WOOCOMMERCE', {
      nativeStatus: 'on-hold',
      financialStatus: null,
      fulfillmentStatus: null,
    })
    expect(result).toBe('pending')
  })

  // Phase 7d Issue 4: trash should map to cancelled, not the pending fallback
  it('WooCommerce: "trash" maps to "cancelled" (Issue 4)', () => {
    const result = deriveInternalStatus('WOOCOMMERCE', {
      nativeStatus: 'trash',
      financialStatus: null,
      fulfillmentStatus: null,
    })
    expect(result).toBe('cancelled')
  })

  it('WooCommerce: "trashed" maps to "cancelled" (Issue 4)', () => {
    const result = deriveInternalStatus('WOOCOMMERCE', {
      nativeStatus: 'trashed',
      financialStatus: null,
      fulfillmentStatus: null,
    })
    expect(result).toBe('cancelled')
  })

  it('Shopify: fulfillmentStatus "fulfilled" maps to "fulfilled"', () => {
    const result = deriveInternalStatus('SHOPIFY', {
      nativeStatus: 'open',
      financialStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
    })
    expect(result).toBe('fulfilled')
  })

  it('Shopify: cancelled_at in rawPayload maps to "cancelled"', () => {
    const result = deriveInternalStatus('SHOPIFY', {
      nativeStatus: 'open',
      financialStatus: 'paid',
      fulfillmentStatus: null,
      rawPayload: { cancelled_at: '2025-03-01T00:00:00Z' },
    })
    expect(result).toBe('cancelled')
  })

  it('Shopify: financialStatus "paid" with no fulfillmentStatus maps to "processing"', () => {
    const result = deriveInternalStatus('SHOPIFY', {
      nativeStatus: 'open',
      financialStatus: 'paid',
      fulfillmentStatus: null,
    })
    expect(result).toBe('processing')
  })

  it('Shopify: financialStatus "partially_paid" maps to "processing"', () => {
    const result = deriveInternalStatus('SHOPIFY', {
      nativeStatus: 'open',
      financialStatus: 'partially_paid',
      fulfillmentStatus: null,
    })
    expect(result).toBe('processing')
  })

  it('Shopify: unknown status (no cancelled, no fulfilled, no paid) falls back to "pending"', () => {
    const result = deriveInternalStatus('SHOPIFY', {
      nativeStatus: 'open',
      financialStatus: 'pending',
      fulfillmentStatus: null,
    })
    expect(result).toBe('pending')
  })

  it('WooCommerce: "refunded" maps to "cancelled"', () => {
    const result = deriveInternalStatus('WOOCOMMERCE', {
      nativeStatus: 'refunded',
      financialStatus: null,
      fulfillmentStatus: null,
    })
    expect(result).toBe('cancelled')
  })
})

// ===========================================================================
// decryptOrNull
// ===========================================================================

describe('decryptOrNull', () => {
  it('returns null for null input', () => {
    expect(decryptOrNull(null)).toBeNull()
  })

  it('returns plaintext value as-is when not encrypted', () => {
    expect(decryptOrNull('sk_live_abc123')).toBe('sk_live_abc123')
  })

  it('decrypts encrypted value via decryptValue', () => {
    // Three dot-separated base64 segments triggers isEncrypted -> true
    const encrypted = 'AAAA.BBBB.CCCC'
    const result = decryptOrNull(encrypted)
    expect(result).toBe(`decrypted:${encrypted}`)
  })
})

// ===========================================================================
// hostFromStoreUrl
// ===========================================================================

describe('hostFromStoreUrl', () => {
  it('extracts hostname from a full URL', () => {
    expect(hostFromStoreUrl('https://mystore.com/path')).toBe('mystore.com')
  })

  it('falls back to string parsing for URL without protocol', () => {
    expect(hostFromStoreUrl('mystore.com')).toBe('mystore.com')
  })

  it('returns empty string for empty input', () => {
    expect(hostFromStoreUrl('')).toBe('')
  })
})

// ===========================================================================
// upsertOrderWithItems
// ===========================================================================

describe('upsertOrderWithItems', () => {
  // Helper: wire up the mock so $transaction calls the callback with a mock tx
  function setupTransaction() {
    const mockTx = mockDeep<PrismaClient>()

    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      return cb(mockTx)
    })

    return mockTx
  }

  const baseParams = {
    integrationId: 'int-1',
    companyId: 'comp-1',
    storeUrl: 'https://store.test',
  }

  // -----------------------------------------------------------------------
  // 14. Creates new order when none exists (statusMode: 'compute')
  // -----------------------------------------------------------------------
  it('creates new order when none exists (statusMode: compute)', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder()

    tx.externalOrder.upsert.mockResolvedValue({
      id: 'order-1',
    } as any)

    const result = await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(tx.externalOrder.upsert).toHaveBeenCalledTimes(1)
    expect(result.orderId).toBe('order-1')
    expect(result.itemsProcessed).toBe(0)
    expect(result.itemsMapped).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 15. Updates existing order (statusMode: 'compute')
  // -----------------------------------------------------------------------
  it('updates existing order via upsert (statusMode: compute)', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder()

    tx.externalOrder.upsert.mockResolvedValue({
      id: 'existing-order-1',
    } as any)

    const result = await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    // The upsert call includes both create and update payloads
    const call = tx.externalOrder.upsert.mock.calls[0][0] as any
    expect(call.where.integrationId_externalId).toEqual({
      integrationId: 'int-1',
      externalId: 'ext-1',
    })
    expect(call.create).toBeDefined()
    expect(call.update).toBeDefined()
    expect(result.orderId).toBe('existing-order-1')
  })

  // -----------------------------------------------------------------------
  // 16. statusMode: 'preserve' keeps provided internalStatus
  // -----------------------------------------------------------------------
  it('statusMode preserve uses the provided internalStatus', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder()

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-1' } as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'preserve', internalStatus: 'fulfilled' },
    })

    const call = tx.externalOrder.upsert.mock.calls[0][0] as any
    expect(call.create.internalStatus).toBe('fulfilled')
    expect(call.update.internalStatus).toBe('fulfilled')
  })

  // -----------------------------------------------------------------------
  // 17. statusMode: 'compute' calls deriveInternalStatus
  // -----------------------------------------------------------------------
  it('statusMode compute derives internalStatus from nativeStatus', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({ nativeStatus: 'completed' })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-1' } as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    // deriveInternalStatus('WOOCOMMERCE', {nativeStatus:'completed'}) => 'fulfilled'
    const call = tx.externalOrder.upsert.mock.calls[0][0] as any
    expect(call.create.internalStatus).toBe('fulfilled')
    expect(call.update.internalStatus).toBe('fulfilled')
  })

  // -----------------------------------------------------------------------
  // 18. Auto-maps item when ProductLink exists (isMapped=true)
  // -----------------------------------------------------------------------
  it('auto-maps item when ProductLink exists', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-1',
          externalProductId: 'prod-1',
          externalVariantId: null,
          name: 'Widget',
          variantName: null,
          sku: 'WDG-001',
          quantity: 2,
          unitPrice: 10,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-1' } as any)
    tx.productLink.findFirst.mockResolvedValue({ id: 'plink-1' } as any)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    const result = await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(result.itemsMapped).toBe(1)
    const itemCall = tx.externalOrderItem.upsert.mock.calls[0][0] as any
    expect(itemCall.create.isMapped).toBe(true)
    expect(itemCall.create.productLinkId).toBe('plink-1')
  })

  // -----------------------------------------------------------------------
  // 19. Does not auto-map when no ProductLink exists (isMapped=false)
  // -----------------------------------------------------------------------
  it('does not auto-map when no ProductLink exists', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-1',
          externalProductId: 'prod-1',
          externalVariantId: null,
          name: 'Widget',
          variantName: null,
          sku: 'WDG-001',
          quantity: 2,
          unitPrice: 10,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-1' } as any)
    tx.productLink.findFirst.mockResolvedValue(null)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    const result = await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(result.itemsMapped).toBe(0)
    const itemCall = tx.externalOrderItem.upsert.mock.calls[0][0] as any
    expect(itemCall.create.isMapped).toBe(false)
    expect(itemCall.create.productLinkId).toBeNull()
  })

  // -----------------------------------------------------------------------
  // 20. Uses Prisma upsert for items with non-null externalItemId
  // -----------------------------------------------------------------------
  it('uses Prisma upsert for items with non-null externalItemId', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-42',
          externalProductId: 'prod-1',
          externalVariantId: null,
          name: 'Widget',
          variantName: null,
          sku: 'WDG-001',
          quantity: 1,
          unitPrice: 5,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-1' } as any)
    tx.productLink.findFirst.mockResolvedValue(null)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(tx.externalOrderItem.upsert).toHaveBeenCalledTimes(1)
    const call = tx.externalOrderItem.upsert.mock.calls[0][0] as any
    expect(call.where.orderId_externalItemId).toEqual({
      orderId: 'order-1',
      externalItemId: 'item-42',
    })
  })

  // -----------------------------------------------------------------------
  // 21. Uses findFirst+create for items with null externalItemId
  // -----------------------------------------------------------------------
  it('uses findFirst + create for items with null externalItemId', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: '', // falsy, treated as null branch
          externalProductId: 'prod-1',
          externalVariantId: null,
          name: 'Widget',
          variantName: null,
          sku: 'WDG-001',
          quantity: 1,
          unitPrice: 5,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-1' } as any)
    tx.productLink.findFirst.mockResolvedValue(null)
    tx.externalOrderItem.findFirst.mockResolvedValue(null) // no existing item
    tx.externalOrderItem.create.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    // Should NOT have called upsert on ExternalOrderItem
    expect(tx.externalOrderItem.upsert).not.toHaveBeenCalled()
    // Should have called findFirst then create
    expect(tx.externalOrderItem.findFirst).toHaveBeenCalledTimes(1)
    expect(tx.externalOrderItem.create).toHaveBeenCalledTimes(1)
  })

  // -----------------------------------------------------------------------
  // 22. Cleans up stale items (items in DB but not in normalized order)
  // -----------------------------------------------------------------------
  it('cleans up stale items no longer in the order', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-1',
          externalProductId: 'prod-1',
          externalVariantId: null,
          name: 'Widget',
          variantName: null,
          sku: 'WDG-001',
          quantity: 1,
          unitPrice: 5,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-1' } as any)
    tx.productLink.findFirst.mockResolvedValue(null)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)
    tx.externalOrderItem.deleteMany.mockResolvedValue({ count: 2 } as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(tx.externalOrderItem.deleteMany).toHaveBeenCalledTimes(1)
    const deleteCall = tx.externalOrderItem.deleteMany.mock.calls[0][0] as any
    expect(deleteCall.where.orderId).toBe('order-1')
    // Should keep item-1, delete anything else with a non-null externalItemId
    expect(deleteCall.where.AND).toEqual([
      { externalItemId: { not: null } },
      { externalItemId: { notIn: ['item-1'] } },
    ])
  })

  // -----------------------------------------------------------------------
  // 23. Returns correct counts (orderId, itemsProcessed, itemsMapped)
  // -----------------------------------------------------------------------
  it('returns correct orderId, itemsProcessed, and itemsMapped counts', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-1',
          externalProductId: 'prod-1',
          externalVariantId: null,
          name: 'Widget A',
          variantName: null,
          sku: 'A-001',
          quantity: 1,
          unitPrice: 10,
        },
        {
          externalId: 'item-2',
          externalProductId: 'prod-2',
          externalVariantId: null,
          name: 'Widget B',
          variantName: null,
          sku: 'B-001',
          quantity: 3,
          unitPrice: 20,
        },
        {
          externalId: 'item-3',
          externalProductId: 'prod-3',
          externalVariantId: null,
          name: 'Widget C',
          variantName: null,
          sku: 'C-001',
          quantity: 1,
          unitPrice: 5,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-99' } as any)
    // First and third items have ProductLink; second does not
    tx.productLink.findFirst
      .mockResolvedValueOnce({ id: 'plink-1' } as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'plink-3' } as any)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)
    tx.externalOrderItem.deleteMany.mockResolvedValue({ count: 0 } as any)

    const result = await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(result.orderId).toBe('order-99')
    expect(result.itemsProcessed).toBe(3)
    expect(result.itemsMapped).toBe(2)
  })

  // -----------------------------------------------------------------------
  // 24. Transaction rollback on error (mock tx to throw mid-operation)
  // -----------------------------------------------------------------------
  it('propagates error so transaction rolls back', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-1',
          externalProductId: 'prod-1',
          externalVariantId: null,
          name: 'Widget',
          variantName: null,
          sku: 'A-001',
          quantity: 1,
          unitPrice: 10,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-1' } as any)
    tx.productLink.findFirst.mockResolvedValue(null)
    tx.externalOrderItem.upsert.mockRejectedValue(new Error('DB write failed'))

    await expect(
      upsertOrderWithItems(mockPrisma, {
        ...baseParams,
        normalized,
        status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
      })
    ).rejects.toThrow('DB write failed')
  })

  // -----------------------------------------------------------------------
  // 25. Handles empty lineItems array gracefully
  // -----------------------------------------------------------------------
  it('handles empty lineItems array gracefully', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({ lineItems: [] })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-empty' } as any)

    const result = await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(result.orderId).toBe('order-empty')
    expect(result.itemsProcessed).toBe(0)
    expect(result.itemsMapped).toBe(0)
    // No item-level DB calls should have been made
    expect(tx.externalOrderItem.upsert).not.toHaveBeenCalled()
    expect(tx.externalOrderItem.findFirst).not.toHaveBeenCalled()
    expect(tx.externalOrderItem.create).not.toHaveBeenCalled()
    // P0-3: Stale-item cleanup runs unconditionally. When seenExternalItemIds
    // is empty, it deletes all items with a non-null externalItemId for this
    // order (no notIn clause).
    expect(tx.externalOrderItem.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.externalOrderItem.deleteMany).toHaveBeenCalledWith({
      where: {
        orderId: 'order-empty',
        externalItemId: { not: null },
      },
    })
  })

  // -----------------------------------------------------------------------
  // 26. P0-3: Stale cleanup runs when every line item lacks externalItemId
  // -----------------------------------------------------------------------
  it('P0-3: cleans up stale items when all incoming line items lack externalItemId', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: '', // empty → treated as null branch in upsertOrderWithItems
          externalProductId: 'prod-1',
          externalVariantId: null,
          name: 'Item A',
          variantName: null,
          sku: 'SKU-A',
          quantity: 2,
          unitPrice: 10,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-stale' } as any)
    tx.productLink.findFirst.mockResolvedValue(null)
    tx.externalOrderItem.findFirst.mockResolvedValue(null)
    tx.externalOrderItem.create.mockResolvedValue({ id: 'item-new' } as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    // Stale cleanup fires even though seenExternalItemIds is empty
    expect(tx.externalOrderItem.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.externalOrderItem.deleteMany).toHaveBeenCalledWith({
      where: {
        orderId: 'order-stale',
        externalItemId: { not: null },
      },
    })
  })

  // -----------------------------------------------------------------------
  // D7.a: populates bundleComponentSnapshot on first intake when bundle
  // -----------------------------------------------------------------------
  it('D7: populates bundleComponentSnapshot in create when productLink is a bundle', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-bundle-1',
          externalProductId: 'prod-bundle',
          externalVariantId: null,
          name: 'Bundle Kit',
          variantName: null,
          sku: 'BNDL-001',
          quantity: 1,
          unitPrice: 50,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-b1' } as any)
    tx.productLink.findFirst.mockResolvedValue({
      id: 'plink-bundle',
      isBundle: true,
    } as any)
    tx.bundleComponent.findMany.mockResolvedValue([
      {
        internalProductId: 101,
        internalProduct: { name: 'Widget A' },
        quantity: 2,
        sortOrder: 0,
      },
      {
        internalProductId: 102,
        internalProduct: { name: 'Widget B' },
        quantity: 1,
        sortOrder: 1,
      },
    ] as any)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(tx.bundleComponent.findMany).toHaveBeenCalledTimes(1)
    expect(tx.bundleComponent.findMany).toHaveBeenCalledWith({
      where: { productLinkId: 'plink-bundle' },
      include: { internalProduct: { select: { name: true } } },
      orderBy: { sortOrder: 'asc' },
    })

    const upsertCall = tx.externalOrderItem.upsert.mock.calls[0][0] as any
    expect(upsertCall.create.bundleComponentSnapshot).toEqual([
      { internalProductId: 101, internalProductName: 'Widget A', quantity: 2, sortOrder: 0 },
      { internalProductId: 102, internalProductName: 'Widget B', quantity: 1, sortOrder: 1 },
    ])
  })

  // -----------------------------------------------------------------------
  // D7.b: does NOT overwrite snapshot on re-sync (update path must be clean)
  // -----------------------------------------------------------------------
  it('D7: does NOT include bundleComponentSnapshot in the update set on re-sync', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-bundle-1',
          externalProductId: 'prod-bundle',
          externalVariantId: null,
          name: 'Bundle Kit',
          variantName: null,
          sku: 'BNDL-001',
          quantity: 1,
          unitPrice: 50,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-b1' } as any)
    tx.productLink.findFirst.mockResolvedValue({
      id: 'plink-bundle',
      isBundle: true,
    } as any)
    tx.bundleComponent.findMany.mockResolvedValue([
      {
        internalProductId: 101,
        internalProduct: { name: 'Widget A' },
        quantity: 2,
        sortOrder: 0,
      },
    ] as any)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    const upsertCall = tx.externalOrderItem.upsert.mock.calls[0][0] as any
    // The update set must NOT contain bundleComponentSnapshot
    expect(upsertCall.update).not.toHaveProperty('bundleComponentSnapshot')
  })

  // -----------------------------------------------------------------------
  // D7.c: null snapshot when productLink is not a bundle
  // -----------------------------------------------------------------------
  it('D7: snapshot is null when productLink exists but is not a bundle', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-plain-1',
          externalProductId: 'prod-plain',
          externalVariantId: null,
          name: 'Plain Widget',
          variantName: null,
          sku: 'PLN-001',
          quantity: 3,
          unitPrice: 15,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-plain' } as any)
    tx.productLink.findFirst.mockResolvedValue({
      id: 'plink-plain',
      isBundle: false,
    } as any)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    // bundleComponent.findMany must NOT be called for non-bundle links
    expect(tx.bundleComponent.findMany).not.toHaveBeenCalled()

    const upsertCall = tx.externalOrderItem.upsert.mock.calls[0][0] as any
    // For non-bundle links, the field is omitted from the create payload
    // entirely (undefined). Prisma defaults the nullable Json column to SQL NULL.
    // Either undefined-omitted or explicit null is semantically equivalent at the
    // DB level; we use undefined to satisfy Prisma's typed-input contract.
    expect(upsertCall.create.bundleComponentSnapshot).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // D7.d: null-externalId path also sets snapshot on create, skips on update
  // -----------------------------------------------------------------------
  it('D7: null-externalId create path sets snapshot; update path does not', async () => {
    const tx = setupTransaction()

    // --- First call: new item (findFirst returns null → goes to create)
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: '', // null branch
          externalProductId: 'prod-bundle',
          externalVariantId: null,
          name: 'Bundle Kit',
          variantName: null,
          sku: 'BNDL-001',
          quantity: 1,
          unitPrice: 50,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-nb' } as any)
    tx.productLink.findFirst.mockResolvedValue({
      id: 'plink-bundle',
      isBundle: true,
    } as any)
    tx.bundleComponent.findMany.mockResolvedValue([
      {
        internalProductId: 201,
        internalProduct: { name: 'Part X' },
        quantity: 1,
        sortOrder: 0,
      },
    ] as any)
    tx.externalOrderItem.findFirst.mockResolvedValue(null) // no existing item
    tx.externalOrderItem.create.mockResolvedValue({ id: 'item-nb-new' } as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    const createCall = tx.externalOrderItem.create.mock.calls[0][0] as any
    expect(createCall.data.bundleComponentSnapshot).toEqual([
      { internalProductId: 201, internalProductName: 'Part X', quantity: 1, sortOrder: 0 },
    ])

    // --- Second call: existing item (findFirst returns existing → goes to update)
    mockReset(tx)
    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-nb' } as any)
    tx.productLink.findFirst.mockResolvedValue({
      id: 'plink-bundle',
      isBundle: true,
    } as any)
    tx.bundleComponent.findMany.mockResolvedValue([
      {
        internalProductId: 201,
        internalProduct: { name: 'Part X' },
        quantity: 1,
        sortOrder: 0,
      },
    ] as any)
    tx.externalOrderItem.findFirst.mockResolvedValue({ id: 'item-nb-existing' } as any)
    tx.externalOrderItem.update.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    const updateCall = tx.externalOrderItem.update.mock.calls[0][0] as any
    expect(updateCall.data).not.toHaveProperty('bundleComponentSnapshot')
  })

  // -----------------------------------------------------------------------
  // Auto-update externalTitle on order intake when WC renames a product
  // -----------------------------------------------------------------------
  it('auto-updates ProductLink.externalTitle when WC sends a new name', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-renamed-1',
          externalProductId: 'prod-renamed',
          externalVariantId: null,
          name: 'Coffee Beans (Updated)',
          variantName: null,
          sku: 'CB-001',
          quantity: 2,
          unitPrice: 12,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-renamed' } as any)
    tx.productLink.findFirst.mockResolvedValue({
      id: 'plink-renamed',
      isBundle: false,
      externalTitle: 'Coffee Beans',
    } as any)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(tx.productLink.update).toHaveBeenCalledWith({
      where: { id: 'plink-renamed' },
      data: { externalTitle: 'Coffee Beans (Updated)' },
    })
  })

  it('does NOT update externalTitle when WC name matches the current title', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-same-1',
          externalProductId: 'prod-same',
          externalVariantId: null,
          name: 'Coffee Beans',
          variantName: null,
          sku: 'CB-002',
          quantity: 1,
          unitPrice: 10,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-same' } as any)
    tx.productLink.findFirst.mockResolvedValue({
      id: 'plink-same',
      isBundle: false,
      externalTitle: 'Coffee Beans',
    } as any)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(tx.productLink.update).not.toHaveBeenCalled()
  })

  it('combines name + variantName when both present', async () => {
    const tx = setupTransaction()
    const normalized = buildNormalizedOrder({
      lineItems: [
        {
          externalId: 'item-variant-1',
          externalProductId: 'prod-variant',
          externalVariantId: 'var-1lb',
          name: 'Coffee Beans',
          variantName: '1 lb',
          sku: 'CB-1LB',
          quantity: 1,
          unitPrice: 18,
        },
      ],
    })

    tx.externalOrder.upsert.mockResolvedValue({ id: 'order-variant' } as any)
    tx.productLink.findFirst.mockResolvedValue({
      id: 'plink-variant',
      isBundle: false,
      externalTitle: 'Coffee Beans',
    } as any)
    tx.externalOrderItem.upsert.mockResolvedValue({} as any)

    await upsertOrderWithItems(mockPrisma, {
      ...baseParams,
      normalized,
      status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
    })

    expect(tx.productLink.update).toHaveBeenCalledWith({
      where: { id: 'plink-variant' },
      data: { externalTitle: 'Coffee Beans — 1 lb' },
    })
  })
})
