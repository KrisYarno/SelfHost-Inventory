/**
 * @jest-environment node
 *
 * Unit test for transferId stamping in `createInventoryTransfer`.
 *
 * This repo does NOT use a real test DB. Prisma is mocked with jest-mock-extended
 * (see __tests__/unit/lib/inventory.applyStockDelta.test.ts for the harness this
 * mirrors). createInventoryTransfer runs inside prisma.$transaction, so the
 * singleton's $transaction is wired to invoke its callback with a
 * mockDeep<Prisma.TransactionClient>(); we then assert on the two
 * tx.inventory_logs.create calls the transfer issues.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import { createInventoryTransfer } from '@/lib/inventory';

const mockPrisma = prisma as unknown as DeepMockProxy<typeof prisma>;

let mockTx: DeepMockProxy<Prisma.TransactionClient>;

beforeEach(() => {
  mockTx = mockDeep<Prisma.TransactionClient>();
  mockReset(mockTx);
  mockReset(mockPrisma);

  // $transaction drives the real callback with the mocked tx
  (mockPrisma.$transaction as jest.Mock).mockImplementation(
    async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(mockTx)
  );

  // Source/destination rows exist with plenty of stock; validation passes.
  mockTx.product_locations.findUnique.mockResolvedValue({
    id: 1,
    productId: 7,
    locationId: 2,
    quantity: 100,
    version: 1,
  } as any);
  mockTx.inventory_logs.create.mockResolvedValue({ id: 100 } as any);
  mockTx.product_locations.upsert.mockResolvedValue({ version: 2 } as any);
  mockTx.product.update.mockResolvedValue({} as any);
});

test('createInventoryTransfer stamps the SAME transferId on both log rows', async () => {
  await createInventoryTransfer({
    userId: 1,
    productId: 7,
    fromLocationId: 2,
    toLocationId: 3,
    quantity: 5,
  });

  const creates = mockTx.inventory_logs.create.mock.calls.map(
    (call) => (call[0] as any).data
  );
  expect(creates).toHaveLength(2);
  expect(creates[0].transferId).toBeDefined();
  expect(creates[0].transferId).toMatch(/^[0-9a-f-]{36}$/);
  expect(creates[0].transferId).toBe(creates[1].transferId);
});
