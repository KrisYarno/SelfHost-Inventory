// @jest-environment node
/**
 * Change-tracking Task 9 — price-sync recording characterization tests.
 *
 * D10 (per-product recordChange tier): unlike mass-update, a price sync has NO
 * per-row ledger fallback, so a best-effort summary would be the ONLY record of
 * a money-field change. Each CHANGED product therefore records a PRODUCT_UPDATE
 * through the REAL-shaped `recordChange` contract, INSIDE its own per-product
 * `prisma.$transaction`. These pin:
 *   - ER-B9 no-op: an unchanged price does NO update and writes NO event.
 *   - a changed price updates retailPrice AND records on the SAME tx client,
 *     with normalized from/to, one shared batchId across the run, and the
 *     correct actor/trigger (USER+manual when a userId is passed, SYSTEM+cron
 *     otherwise).
 *   - hard-abort is PER PRODUCT: a record failure lands only that product in
 *     failed[] and the loop continues (the batch stays best-effort).
 *
 * `recordChange` is mocked so we can assert the exact (tx, event) it receives
 * and inject a per-product failure; Prisma + the WC price fetch are mocked too.
 */

jest.mock("@/lib/external-orders/shared", () => ({
  getIntegrationClient: jest.fn(async () => ({
    adapter: {},
    storeUrl: "https://shop.example",
    credentials: { key: "k", secret: "s" },
    integration: { platform: "WOOCOMMERCE" },
  })),
}));

jest.mock("@/lib/change-tracking", () => ({
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => "batch-price-1"),
}));

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn() },
    integration: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { syncPricesForIntegration } from "@/lib/external-orders/price-sync";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import prisma from "@/lib/prisma";

const db = prisma as unknown as {
  product: { findMany: jest.Mock };
  integration: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};

/** A product row as loaded by the include-all findMany (all scalars present). */
function makeProduct(id: number, retailPrice: unknown) {
  return {
    id,
    name: `Product ${id}`,
    retailPrice,
    priceSourceLink: {
      id: `link-${id}`,
      externalProductId: `ext-${id}`,
      externalVariantId: null,
      externalTitle: `Ext ${id}`,
    },
  };
}

/** A successful WC product fetch returning the given regular_price. */
function fetchOk(regular_price: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ regular_price }),
    text: async () => "",
  };
}

/** Drive every $transaction with one shared tx mock; return it for assertions. */
function driveTx() {
  const tx = { product: { update: jest.fn(async () => ({})) } };
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));
  return tx;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.integration.findUnique.mockResolvedValue({ platform: "WOOCOMMERCE" });
  // Fresh fetch mock each test — no leaked once-queue.
  (global as any).fetch = jest.fn();
});

test("ER-B9 no-op: an unchanged price does NO update and writes NO event", async () => {
  db.product.findMany.mockResolvedValue([makeProduct(1, 10)] as any);
  (global.fetch as jest.Mock).mockResolvedValueOnce(fetchOk("10")); // same price

  const result = await syncPricesForIntegration("int-1", { userId: 42 });

  expect(db.$transaction).not.toHaveBeenCalled();
  expect(recordChange).not.toHaveBeenCalled();
  expect(result).toEqual({ synced: 0, skipped: 1, failed: [] });
});

test("changed price: updates retailPrice AND records PRODUCT_UPDATE on the SAME tx (USER actor / manual trigger)", async () => {
  db.product.findMany.mockResolvedValue([makeProduct(1, 10)] as any);
  (global.fetch as jest.Mock).mockResolvedValueOnce(fetchOk("15"));
  const tx = driveTx();

  const result = await syncPricesForIntegration("int-1", { userId: 42 });

  // Stock write happened on the tx client with the new numeric price.
  expect(tx.product.update).toHaveBeenCalledTimes(1);
  expect(tx.product.update).toHaveBeenCalledWith({
    where: { id: 1 },
    data: { retailPrice: 15 },
  });

  // Recorded on the SAME tx instance (proves same-transaction join).
  expect(recordChange).toHaveBeenCalledTimes(1);
  const [txArg, event] = (recordChange as jest.Mock).mock.calls[0];
  expect(txArg).toBe(tx);

  expect(event.actor).toEqual({ userId: 42 });
  expect(event.actionType).toBe("PRODUCT_UPDATE");
  expect(event.entityType).toBe("PRODUCT");
  expect(event.entityId).toBe(1);
  // from/to normalized to strings (Decimal-safe).
  expect(event.changes).toEqual({ retailPrice: { from: "10", to: "15" } });
  expect(event.details).toEqual({ trigger: "manual", integrationId: "int-1" });
  expect(event.batchId).toBe("batch-price-1");
  expect(event.action).toContain("WOOCOMMERCE");

  expect(result).toEqual({ synced: 1, skipped: 0, failed: [] });
});

test("no actor -> SYSTEM actor / cron trigger", async () => {
  db.product.findMany.mockResolvedValue([makeProduct(7, 20)] as any);
  (global.fetch as jest.Mock).mockResolvedValueOnce(fetchOk("25"));
  driveTx();

  await syncPricesForIntegration("int-1");

  expect(recordChange).toHaveBeenCalledTimes(1);
  const event = (recordChange as jest.Mock).mock.calls[0][1];
  expect(event.actor).toEqual({ kind: "SYSTEM" });
  expect(event.details.trigger).toBe("cron");
});

test("one shared batchId groups every changed product in the run", async () => {
  db.product.findMany.mockResolvedValue([
    makeProduct(1, 10),
    makeProduct(2, 20),
  ] as any);
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(fetchOk("11"))
    .mockResolvedValueOnce(fetchOk("21"));
  driveTx();

  const result = await syncPricesForIntegration("int-1", { userId: 42 });

  expect(newBatchId).toHaveBeenCalledTimes(1);
  expect(recordChange).toHaveBeenCalledTimes(2);
  const b0 = (recordChange as jest.Mock).mock.calls[0][1].batchId;
  const b1 = (recordChange as jest.Mock).mock.calls[1][1].batchId;
  expect(b0).toBe("batch-price-1");
  expect(b1).toBe("batch-price-1");
  expect(result.synced).toBe(2);
});

test("a record failure fails ONLY that product; the loop continues (per-product hard-abort)", async () => {
  db.product.findMany.mockResolvedValue([
    makeProduct(1, 10),
    makeProduct(2, 20),
  ] as any);
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(fetchOk("15")) // product 1 changed
    .mockResolvedValueOnce(fetchOk("25")); // product 2 changed
  driveTx();

  // First product's record throws (aborts its own tx); second succeeds.
  (recordChange as jest.Mock).mockRejectedValueOnce(new Error("audit write failed"));

  const result = await syncPricesForIntegration("int-1", { userId: 42 });

  expect(recordChange).toHaveBeenCalledTimes(2);
  expect(result.synced).toBe(1); // product 2
  expect(result.failed).toEqual([
    { productId: 1, productName: "Product 1", error: "audit write failed" },
  ]);
});
