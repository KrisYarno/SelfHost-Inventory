/**
 * @jest-environment node
 *
 * Lane reorder-points — Task 5: the `reorder_report` assistant tool (D7 parity).
 *
 * Pins:
 *  - the tool returns the ReorderReport rows + assumptions + coverage + inventory
 *    PositionKnown:false, so the model can relay the runtime assumptions;
 *  - excluded (unavailable) products are named in the returned rows;
 *  - pagination via the Lane-6 limit/offset shape (returned/totalRows/nextOffset);
 *  - PARITY: the tool's rows are exactly the report's rows (same numbers as the web
 *    route, which calls the same getReorderReport);
 *  - the tool + its presentation are registered, and low_stock_report is disambiguated.
 */

jest.mock("@/lib/reports/reorder", () => ({
  __esModule: true,
  getReorderReport: jest.fn(),
}));
// The other data-layer imports of tools.ts are unused by this suite but must not hit a
// real prisma; stub the modules tools.ts pulls in at import time.
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/products", () => ({ __esModule: true, getProductsWithQuantities: jest.fn() }));
jest.mock("@/lib/reports/low-stock", () => ({ __esModule: true, getLowStockReport: jest.fn() }));

import { assistantTools, TOOL_SCOPES, testCtx } from "@/lib/assistant/tools";
import { TOOL_PRESENTATION } from "@/lib/assistant/tool-presentation";
import { getReorderReport } from "@/lib/reports/reorder";

const mockReport = getReorderReport as jest.Mock;
const CTX = testCtx();

const REPORT = {
  rows: [
    {
      status: "suggested",
      productId: 1,
      productName: "Widget",
      currentStock: 0,
      avgDailyDemand: 1.5,
      daysCovered: 30,
      leadTimeDays: 14,
      leadTimeSource: "default",
      bufferDays: 7,
      reorderPoint: 32,
      targetLevel: 42,
      grossReplenishmentNeed: 42,
      minOrderQuantity: 1,
      urgency: "OUT",
      costPrice: null,
      orderValue: null,
    },
    { status: "unavailable", productId: 2, productName: "Idle", currentStock: 5, reason: "no_demand_signal" },
  ],
  inventoryPositionKnown: false,
  assumptions: { windowDays: 90, bufferDaysDefault: 7, targetCoverageMultiple: 2, demandDefinition: "…" },
  coverage: { total: 2, suggested: 1, unavailable: 1, costed: 0 },
};

beforeEach(() => jest.clearAllMocks());

describe("reorder_report tool", () => {
  it("returns rows + assumptions + coverage + inventoryPositionKnown:false", async () => {
    mockReport.mockResolvedValue(REPORT);
    const result = await assistantTools.reorder_report.run({}, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as any;
    expect(data.inventoryPositionKnown).toBe(false);
    expect(data.assumptions).toEqual(REPORT.assumptions);
    expect(data.coverage).toEqual(REPORT.coverage);
    // Excluded product is named in the rows.
    expect(data.rows.find((r: any) => r.productId === 2)).toMatchObject({
      status: "unavailable",
      productName: "Idle",
      reason: "no_demand_signal",
    });
    // Parity: the tool relays the report's rows unchanged (same numbers as the web route).
    expect(data.rows).toEqual(REPORT.rows);
  });

  it("paginates with the Lane-6 limit/offset shape", async () => {
    mockReport.mockResolvedValue(REPORT);
    const result = await assistantTools.reorder_report.run({ limit: 1, offset: 0 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as any;
    expect(data.returned).toBe(1);
    expect(data.totalRows).toBe(2);
    expect(data.nextOffset).toBe(1);
  });

  it("passes includeOkay through to the report", async () => {
    mockReport.mockResolvedValue(REPORT);
    await assistantTools.reorder_report.run({ includeOkay: false }, CTX);
    expect(mockReport).toHaveBeenCalledWith({ includeOkay: false });
  });
});

describe("registration + disambiguation", () => {
  it("is registered in TOOL_SCOPES and TOOL_PRESENTATION", () => {
    expect(TOOL_SCOPES.reorder_report).toBe("global");
    expect(TOOL_PRESENTATION.reorder_report).toBeDefined();
  });

  it("low_stock_report is disambiguated from the reorder report", () => {
    const desc = assistantTools.low_stock_report.description;
    expect(desc).toContain("reorder_report");
    expect(desc.toLowerCase()).toContain("threshold");
  });
});
