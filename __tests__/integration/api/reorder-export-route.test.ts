/**
 * @jest-environment node
 *
 * Lane reorder-points — Task 4: the reorder CSV export (codex #14).
 *
 * Pins:
 *  - a DATA_EXPORT change event is recorded before streaming;
 *  - formula-injection is neutralized (a product name starting with '=' is quoted with
 *    a leading ');
 *  - a null-cost suggested row and an unavailable row export as BLANK cells, never $0;
 *  - excluded (unavailable) products are included in the CSV.
 */

jest.mock("@/lib/api-utils", () => ({
  __esModule: true,
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(() => Promise.resolve({ user: { id: 7, isApproved: true } })),
}));

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: any) => fn({})),
    // A2: the real-module block at the bottom reads the population, the demand ledger
    // and the global reorder settings through these.
    product: { findMany: jest.fn() },
    inventory_logs: { findMany: jest.fn() },
    globalReorderSettings: { findUnique: jest.fn() },
  },
}));

jest.mock("@/lib/change-tracking", () => ({
  __esModule: true,
  recordChange: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/lib/reports/reorder", () => ({
  __esModule: true,
  getReorderReport: jest.fn(),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/reports/reorder-recommendations/export/route";
import { getReorderReport } from "@/lib/reports/reorder";
import { recordChange } from "@/lib/change-tracking";
import prisma from "@/lib/prisma";

const mockReport = getReorderReport as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;
const mockRecord = recordChange as jest.Mock;

beforeEach(() => jest.clearAllMocks());

function seedReport() {
  mockReport.mockResolvedValue({
    rows: [
      {
        status: "suggested",
        productId: 1,
        productName: "=SUM(A1),evil", // injection payload (also has a comma -> quoted)
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
        costPrice: null, // unknown cost
        orderValue: null,
      },
      { status: "unavailable", productId: 2, productName: "Idle", currentStock: 5, reason: "no_demand_signal" },
    ],
    inventoryPositionKnown: false,
    assumptions: { windowDays: 90, bufferDaysDefault: 7, targetCoverageMultiple: 2, demandDefinition: "x" },
    coverage: { total: 2, suggested: 1, unavailable: 1, costed: 0 },
  });
}

test("records a DATA_EXPORT change event before streaming", async () => {
  seedReport();
  const res = await GET(new NextRequest("http://x/api/reports/reorder-recommendations/export"));
  expect(res.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledTimes(1);
  expect(mockRecord.mock.calls[0][1]).toMatchObject({
    actionType: "DATA_EXPORT",
    entityType: "SYSTEM",
  });
});

test("neutralizes CSV formula injection in the product name", async () => {
  seedReport();
  const res = await GET(new NextRequest("http://x/api/reports/reorder-recommendations/export"));
  const csv = await res.text();
  // The leading '=' is neutralized by a leading apostrophe, then quoted because of the comma.
  expect(csv).toContain('"\'=SUM(A1),evil"');
  expect(csv).not.toContain("\n=SUM("); // never a raw leading '='
});

test("null cost and unavailable rows export as blank cells, never $0", async () => {
  seedReport();
  const res = await GET(new NextRequest("http://x/api/reports/reorder-recommendations/export"));
  const csv = await res.text();
  const lines = csv.split("\n");
  // suggested row: cost + order value are the last two cells -> empty (trailing commas).
  const suggestedLine = lines.find((l) => l.includes("suggested"))!;
  expect(suggestedLine.endsWith(",,")).toBe(true);
  expect(suggestedLine).not.toContain("$0");
  expect(suggestedLine).not.toContain(",0,0");
  // the excluded product is present with its reason.
  const unavailableLine = lines.find((l) => l.includes("unavailable"))!;
  expect(unavailableLine).toContain("Idle");
  expect(unavailableLine).toContain("no_demand_signal");
});

// Quality+reach C11 (Task 2.5, named ride-along): the widened unavailable union carries
// a NULL productName (unknown_id) and a NULL currentStock (both new variants). The CSV
// must render those as EMPTY cells — "null" text or a 0 would both read as data.
test("the requested-id variants export as BLANK cells, never 'null' and never 0", async () => {
  mockReport.mockResolvedValue({
    rows: [
      {
        status: "unavailable",
        productId: 9,
        productName: "Archived Product",
        currentStock: null,
        reason: "not_active",
      },
      {
        status: "unavailable",
        productId: 4242,
        productName: null,
        currentStock: null,
        reason: "unknown_id",
      },
    ],
    inventoryPositionKnown: false,
    assumptions: { windowDays: 90, bufferDaysDefault: 7, targetCoverageMultiple: 2, demandDefinition: "x" },
    coverage: {
      total: 0,
      suggested: 0,
      unavailable: 0,
      healthy: 0,
      approachingOmitted: 0,
      costed: 0,
      requested: { requested: 2, notActive: 1, unknownIds: 1 },
    },
  });

  const res = await GET(new NextRequest("http://x/api/reports/reorder-recommendations/export"));
  expect(res.status).toBe(200);
  const csv = await res.text();
  const lines = csv.trim().split("\n");
  const archived = lines.find((l) => l.startsWith("Archived Product"))!;
  const unknown = lines.find((l) => l.includes("unknown_id"))!;

  // not_active: the real name is reported; the stock cell is EMPTY (no fabricated 0).
  expect(archived.split(",")[0]).toBe("Archived Product");
  expect(archived.split(",")[4]).toBe("");
  expect(archived).not.toMatch(/null/);
  // unknown_id: no name, no stock — two empty leading cells, reason intact.
  expect(unknown.startsWith(",unavailable,unknown_id,,")).toBe(true);
  expect(unknown).not.toMatch(/null/);
});

// ---------------------------------------------------------------------------
// A2 pack C5 — the reorder module's rows gained `reorderPointSource` and its note changed
// (a DECLARED web-body change). The CSV export is pinned UNCHANGED through the REAL
// module: the same header, the same cells (no new column), and the same DATA_EXPORT
// record (coverage + assumptions — never the note, never a tool-layer key).
// ---------------------------------------------------------------------------

describe("A2 C5: the CSV and its audit record are unchanged (real module)", () => {
  const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
  const HEADER =
    "Product,State,Reason,Urgency,Current Stock,Avg Daily Demand,Days Covered,Lead Time Days," +
    "Lead Time Source,Buffer Days,Reorder Point,Target Level,Suggested Order Qty,Min Order Qty," +
    "Cost Price,Order Value";

  beforeEach(() => {
    mockReport.mockImplementation(jest.requireActual("@/lib/reports/reorder").getReorderReport);
    db.globalReorderSettings.findUnique.mockResolvedValue(null); // built-in defaults
    db.product.findMany.mockResolvedValue([
      // 30 units over 30 covered days => 1/day: lead 14 + buffer 7 => point 21, target 28.
      { id: 1, name: "Computed", costPrice: "2.00", product_locations: [{ quantity: 0 }], reorderConfig: null },
      // The same demand with a hand-set point of 40 => target max(40, 28) = 40, need 35.
      {
        id: 2,
        name: "Pinned",
        costPrice: null,
        product_locations: [{ quantity: 5 }],
        reorderConfig: { leadTimeDays: null, customSafetyStockDays: null, minOrderQuantity: null, reorderPointOverride: 40 },
      },
      { id: 3, name: "Idle", costPrice: "1.00", product_locations: [{ quantity: 4 }], reorderConfig: null },
    ]);
    db.inventory_logs.findMany.mockResolvedValue(
      [1, 2].flatMap((productId) =>
        [30, 20, 10].map((daysAgo) => ({
          productId,
          delta: -10,
          // The first event exactly 30 days back (minus a minute, so it is inside the window).
          changeTime: new Date(recent(daysAgo).getTime() + 60_000),
          logType: "SALE",
          reasonCode: null,
        })),
      ),
    );
  });

  it("header and every cell are byte-identical to the pre-A2 export (no reorderPointSource column)", async () => {
    const res = await GET(new NextRequest("http://x/api/reports/reorder-recommendations/export"));
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toEqual([
      HEADER,
      "Computed,suggested,,OUT,0,1,30,14,default,7,21,28,28,1,2,56",
      // Stock 5 is below lead-time demand (14): CRITICAL is checked before the hand-set point.
      "Pinned,suggested,,CRITICAL,5,1,30,14,default,7,40,40,35,1,,",
      "Idle,unavailable,no_demand_signal,,4,,,,,,,,,,,",
    ]);
    expect(lines.join("\n")).not.toMatch(/computed|override|orderSignal/);
  });

  it("the DATA_EXPORT record carries exactly coverage + assumptions (no note, no new key)", async () => {
    await GET(new NextRequest("http://x/api/reports/reorder-recommendations/export"));
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const record = mockRecord.mock.calls[0][1];
    expect(record).toMatchObject({
      actor: { userId: 7 },
      actionType: "DATA_EXPORT",
      entityType: "SYSTEM",
      entityId: null,
      action: "Exported reorder report CSV",
    });
    expect(record.details).toEqual({
      export: "reorder-report",
      coverage: { total: 3, suggested: 2, unavailable: 1, healthy: 0, approachingOmitted: 0, costed: 1 },
      assumptions: {
        windowDays: 90,
        bufferDaysDefault: 7,
        targetCoverageMultiple: 2,
        demandDefinition: jest.requireActual("@/lib/reports/metrics-contract").REORDER_DEMAND_DEFINITION,
      },
    });
  });
});
