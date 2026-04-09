/**
 * @jest-environment node
 */

/**
 * Tests for the fulfillment push helper (pushOrderStatusToExternal).
 *
 * Since pushOrderStatusToExternal and getIntegrationClient live in the same
 * module, we mock the underlying dependencies (prisma, getPlatformAdapter,
 * encryption) so getIntegrationClient works naturally.
 */

import type { PlatformAdapter, OrderStatusUpdateResult } from '@/lib/platforms/core/types';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that trigger the module
// ---------------------------------------------------------------------------

// Mock Prisma
jest.mock('@/lib/prisma', () => {
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

// Mock encryption — always return decrypted values
jest.mock('@/lib/encryption', () => ({
  isEncrypted: jest.fn(() => false),
  decryptValue: jest.fn((v: string) => v),
}));

// Mock getPlatformAdapter — returns the adapter we configure in each test
const mockAdapter: Record<string, jest.Mock | string> = {
  platform: 'WOOCOMMERCE',
  extractWebhookHeaders: jest.fn(),
  verifyWebhook: jest.fn(),
  parseOrderWebhook: jest.fn(),
  updateOrderStatus: jest.fn(),
};

jest.mock('@/lib/platforms/core/registry', () => ({
  getPlatformAdapter: jest.fn(() => mockAdapter),
}));

// Mock AppError so it behaves like a real error
jest.mock('@/lib/error-handling', () => ({
  AppError: class AppError extends Error {
    code: string;
    statusCode: number;
    constructor(message: string, code: string, statusCode: number) {
      super(message);
      this.name = 'AppError';
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

// Now import modules
import { pushOrderStatusToExternal } from '@/lib/external-orders/shared';
import mockPrismaDefault from '@/lib/prisma';
import { mockReset } from 'jest-mock-extended';

const mockPrisma = mockPrismaDefault as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    platform: 'WOOCOMMERCE',
    storeUrl: 'https://store.test',
    isActive: true,
    encryptedApiKey: 'ck_test',
    encryptedApiSecret: 'cs_test',
    stockSyncEnabled: false,
    fulfillmentPushEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockReset(mockPrisma);

  // Reset the mock adapter to default behavior
  mockAdapter.updateOrderStatus = jest.fn().mockResolvedValue({ success: true });
  mockAdapter.platform = 'WOOCOMMERCE';

  // Default: prisma finds the integration
  mockPrisma.integration.findUnique.mockResolvedValue(makeIntegration());
});

// ===========================================================================
// Tests
// ===========================================================================

describe('pushOrderStatusToExternal', () => {
  // 1. Push succeeds after full fulfillment -> 'completed'
  it('pushes "completed" status on full fulfillment', async () => {
    (mockAdapter.updateOrderStatus as jest.Mock).mockResolvedValue({ success: true });

    const result = await pushOrderStatusToExternal('int-1', 'ext-order-123', 'completed');

    expect(result.success).toBe(true);
    expect(mockAdapter.updateOrderStatus).toHaveBeenCalledWith(
      'https://store.test',
      { key: 'ck_test', secret: 'cs_test' },
      'ext-order-123',
      'completed'
    );
  });

  // 2. Push succeeds after partial fulfillment -> 'processing' (Amendment 7)
  it('pushes "processing" status on partial fulfillment', async () => {
    (mockAdapter.updateOrderStatus as jest.Mock).mockResolvedValue({ success: true });

    const result = await pushOrderStatusToExternal('int-1', 'ext-order-123', 'processing');

    expect(result.success).toBe(true);
    expect(mockAdapter.updateOrderStatus).toHaveBeenCalledWith(
      'https://store.test',
      { key: 'ck_test', secret: 'cs_test' },
      'ext-order-123',
      'processing'
    );
  });

  // 3. Push fails: fulfillment still succeeds locally, error logged
  it('returns error when push fails (fulfillment is not blocked)', async () => {
    (mockAdapter.updateOrderStatus as jest.Mock).mockResolvedValue({
      success: false,
      error: 'WC store unreachable',
    });

    const result = await pushOrderStatusToExternal('int-1', 'ext-order-123', 'completed');

    expect(result.success).toBe(false);
    expect(result.error).toContain('WC store unreachable');
  });

  // 4. fulfillmentPushEnabled = false: adapter does not support updateOrderStatus
  // The toggle check happens at the caller (fulfill route). Here we test what
  // happens when the adapter has no updateOrderStatus method.
  it('returns error when adapter does not support updateOrderStatus', async () => {
    // Remove updateOrderStatus from adapter
    delete (mockAdapter as any).updateOrderStatus;

    const result = await pushOrderStatusToExternal('int-1', 'ext-order-123', 'completed');

    expect(result.success).toBe(false);
    expect(result.error).toContain('updateOrderStatus');
  });

  // 5. Integration not found: getIntegrationClient throws (Prisma returns null)
  it('returns error when integration is not found', async () => {
    mockPrisma.integration.findUnique.mockResolvedValue(null);

    await expect(
      pushOrderStatusToExternal('nonexistent', 'ext-order-123', 'completed')
    ).rejects.toThrow('Integration not found or inactive');
  });
});
