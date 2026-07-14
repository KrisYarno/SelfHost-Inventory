/**
 * @jest-environment node
 *
 * Lane reorder-points — Task 4: the demand-based reorder route contract.
 *
 * Pins that the atomic replacement returns the truthful discriminated shape and that
 * the old $0-cost lie is dead: a null-cost suggested product yields orderValue:null
 * (never $0), and inventoryPositionKnown:false is stated.
 */

jest.mock("@/lib/api-utils", () => ({
  __esModule: true,
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(() => Promise.resolve({ user: { id: 1, isApproved: true } })),
}));

// Drive the route through a stubbed report so the contract test is about the HTTP
// surface, not the computation (which reorder.test.ts covers exhaustively).
jest.mock("@/lib/reports/reorder", () => ({
  __esModule: true,
  getReorderReport: jest.fn(),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/reports/reorder-recommendations/route";
import { getReorderReport } from "@/lib/reports/reorder";

const mockReport = getReorderReport as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test("returns the discriminated ReorderReport with inventoryPositionKnown:false", async () => {
  mockReport.mockResolvedValue({
    rows: [
      {
        status: "suggested",
        productId: 1,
        productName: "NoCost",
        currentStock: 0,
        avgDailyDemand: 1,
        daysCovered: 30,
        leadTimeDays: 14,
        leadTimeSource: "default",
        bufferDays: 7,
        reorderPoint: 21,
        targetLevel: 28,
        grossReplenishmentNeed: 28,
        minOrderQuantity: 1,
        urgency: "OUT",
        costPrice: null,
        orderValue: null,
      },
      { status: "unavailable", productId: 2, productName: "Idle", currentStock: 5, reason: "no_demand_signal" },
    ],
    inventoryPositionKnown: false,
    assumptions: { windowDays: 90, bufferDaysDefault: 7, targetCoverageMultiple: 2, demandDefinition: "..." },
    coverage: { total: 2, suggested: 1, unavailable: 1, costed: 0 },
  });

  const res = await GET(new NextRequest("http://x/api/reports/reorder-recommendations?includeOkay=true"));
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.inventoryPositionKnown).toBe(false);
  const suggested = body.rows.find((r: any) => r.productId === 1);
  // The old $0 lie is dead: unknown cost stays null, order value blank.
  expect(suggested.costPrice).toBeNull();
  expect(suggested.orderValue).toBeNull();
  const unavailable = body.rows.find((r: any) => r.productId === 2);
  expect(unavailable.status).toBe("unavailable");
  expect(unavailable.reason).toBe("no_demand_signal");
  expect(unavailable).not.toHaveProperty("reorderPoint");
  expect(body.coverage).toEqual({ total: 2, suggested: 1, unavailable: 1, costed: 0 });
});

test("passes includeOkay + pagination through to the report", async () => {
  mockReport.mockResolvedValue({
    rows: [],
    inventoryPositionKnown: false,
    assumptions: { windowDays: 90, bufferDaysDefault: 7, targetCoverageMultiple: 2, demandDefinition: "x" },
    coverage: { total: 0, suggested: 0, unavailable: 0, costed: 0 },
  });
  await GET(new NextRequest("http://x/api/reports/reorder-recommendations?includeOkay=true&limit=50&offset=10"));
  expect(mockReport).toHaveBeenCalledWith({ includeOkay: true, limit: 50, offset: 10 });
});
