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
  default: { $transaction: jest.fn(async (fn: any) => fn({})) },
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

const mockReport = getReorderReport as jest.Mock;
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
