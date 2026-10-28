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
// surface, not the computation (which reorder.test.ts covers exhaustively). The A2 block
// at the bottom re-points the stub at the REAL module (prisma mocked) instead.
jest.mock("@/lib/reports/reorder", () => ({
  __esModule: true,
  getReorderReport: jest.fn(),
}));
jest.mock("@/lib/prisma", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import { NextRequest } from "next/server";
import { mockReset } from "jest-mock-extended";
import { GET } from "@/app/api/reports/reorder-recommendations/route";
import { getReorderReport } from "@/lib/reports/reorder";
import prisma from "@/lib/prisma";

const mockReport = getReorderReport as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockReset(db);
});

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

// ---------------------------------------------------------------------------
// A2 pack C5 — the DECLARED web change, pinned through the REAL module (prisma mocked):
// the route returns the report verbatim, so its body gains `reorderPointSource` on every
// suggested row and the plain-words coverage note. Nothing of the assistant tool's
// envelope (C4's order signal, the definitions, the costed label) reaches it.
// ---------------------------------------------------------------------------

describe("A2 C5: the web body through the real reorder module", () => {
  const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);

  beforeEach(() => {
    mockReport.mockImplementation(jest.requireActual("@/lib/reports/reorder").getReorderReport);
    db.globalReorderSettings.findUnique.mockResolvedValue(null); // the built-in defaults
    db.product.findMany.mockResolvedValue([
      // Computed point: 3 sales of 10 over the window, no config.
      { id: 1, name: "Computed", costPrice: null, product_locations: [{ quantity: 0 }], reorderConfig: null },
      // Hand-set point: an override on the product's config.
      {
        id: 2,
        name: "Pinned",
        costPrice: "2.50",
        product_locations: [{ quantity: 5 }],
        reorderConfig: { leadTimeDays: null, customSafetyStockDays: null, minOrderQuantity: null, reorderPointOverride: 40 },
      },
      // No outbound at all: unavailable, no numbers.
      { id: 3, name: "Idle", costPrice: "1.00", product_locations: [{ quantity: 0 }], reorderConfig: null },
    ]);
    db.inventory_logs.findMany.mockResolvedValue(
      [1, 2].flatMap((productId) =>
        [20, 10, 2].map((daysAgo) => ({
          productId,
          delta: -10,
          changeTime: recent(daysAgo),
          logType: "SALE",
          reasonCode: null,
        })),
      ),
    );
  });

  it("suggested rows carry reorderPointSource (both values) and the body carries the new note", async () => {
    const res = await GET(new NextRequest("http://x/api/reports/reorder-recommendations?includeOkay=true"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.rows.map((r: any) => [r.productId, r]));
    expect(byId[1]).toMatchObject({ status: "suggested", reorderPointSource: "computed" });
    expect(byId[2]).toMatchObject({ status: "suggested", reorderPoint: 40, reorderPointSource: "override" });
    expect(byId[3]).toEqual({
      status: "unavailable",
      productId: 3,
      productName: "Idle",
      currentStock: 0,
      reason: "no_demand_signal",
    });
    expect(body.coverageNote).toBe(
      "healthy = none of the urgency tiers applies (stock above 1.2 × the reorder point and not " +
        "below lead-time demand) — counted, and a row ONLY when explicitly requested " +
        "(productIds) or includeHealthy is set, then with urgency OK.",
    );
  });

  it("the body's key set is the report's own — no tool-layer key reaches the web", async () => {
    const res = await GET(new NextRequest("http://x/api/reports/reorder-recommendations?includeOkay=true"));
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["rows", "inventoryPositionKnown", "assumptions", "coverage", "coverageNote"]);
    expect(Object.keys(body.coverage)).toEqual([
      "total",
      "suggested",
      "unavailable",
      "healthy",
      "approachingOmitted",
      "costed",
    ]);
    for (const row of body.rows) {
      expect(row).not.toHaveProperty("orderSignal");
      expect(row).not.toHaveProperty("outOfStockWithOrders");
    }
  });
});
