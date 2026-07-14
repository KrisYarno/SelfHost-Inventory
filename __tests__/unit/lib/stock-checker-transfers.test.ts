// Lane 6 (review M2 / D-T5): the low-stock ALERT-EMAIL path (StockChecker) must not
// count internal TRANSFER movement as usage. On prod that was 7,682 units/yr of
// warehouse-to-warehouse moves shortening every runway. The outflow read that drives
// daysUntilEmpty must exclude TRANSFER.
//
// reorder-points Task 2: StockChecker.batchAvgDailyOutflow now routes through the ONE
// shared units-out velocity (lib/reports/demand.ts), which reads outbound rows via
// findMany. This pins that the transfer exclusion survives the migration.

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn() },
    inventory_logs: { findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));

// Keep the email service inert — this test only inspects the query shape.
jest.mock("@/lib/email", () => ({
  __esModule: true,
  emailService: { sendLowStockDigest: jest.fn(), sendMinimumsDigest: jest.fn() },
}));

import prisma from "@/lib/prisma";
import { StockChecker } from "@/lib/stock-checker";

const m = prisma as unknown as {
  product: { findMany: jest.Mock };
  inventory_logs: { findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
};

beforeEach(() => jest.clearAllMocks());

test("checkLowStock's outflow query excludes internal transfers", async () => {
  m.systemSetting.findUnique.mockResolvedValue(null); // default threshold 10
  m.product.findMany.mockResolvedValue([
    {
      id: 1,
      name: "A",
      lowStockThreshold: 20,
      deletedAt: null,
      approvalStatus: "APPROVED",
      product_locations: [{ quantity: 3 }],
    },
  ]);
  m.inventory_logs.findMany.mockResolvedValue([
    { productId: 1, delta: -30, changeTime: new Date(), reasonCode: null },
  ]);

  await new StockChecker().checkLowStock();

  expect(m.inventory_logs.findMany).toHaveBeenCalledTimes(1);
  const where = m.inventory_logs.findMany.mock.calls[0][0].where;
  expect(where.logType).toEqual({ not: "TRANSFER" });
  expect(where.delta).toEqual({ lt: 0 });
});
