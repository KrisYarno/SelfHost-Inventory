// @jest-environment node
//
// Phase C (P-C6): the in-memory "adjustments" buckets in the reports consumers must
// count ADJUSTMENT + CORRECTION + COUNT, and must NOT count SALE / STOCK_IN (those are
// flow, not correction). Covers the three findMany-based sites: daily-activity,
// date-details, user-details. (user-activity is groupBy-based; covered in its own suite.)
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    inventory_logs: { findMany: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET as dailyActivityGET } from "@/app/api/reports/daily-activity/route";
import { GET as dateDetailsGET } from "@/app/api/reports/date-details/route";
import { GET as userDetailsGET } from "@/app/api/reports/user-details/[id]/route";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  user: { findUnique: jest.Mock };
  inventory_logs: { findMany: jest.Mock };
};

// One row per logType, all on the same day, so the day's adjustments bucket
// equals |−4| + |7| + |0| = 11 (CORRECTION + COUNT + ADJUSTMENT), and SALE/STOCK_IN
// (|−9| + |5|) are excluded.
const DAY = new Date("2026-06-10T12:00:00.000Z");
function mixedRows() {
  return [
    { changeTime: DAY, logType: "ADJUSTMENT", delta: 7, id: 1, delta_: 0 },
    { changeTime: DAY, logType: "CORRECTION", delta: -4, id: 2 },
    { changeTime: DAY, logType: "COUNT", delta: 0, id: 3 },
    { changeTime: DAY, logType: "SALE", delta: -9, id: 4 },
    { changeTime: DAY, logType: "STOCK_IN", delta: 5, id: 5 },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: true } });
});

describe("daily-activity adjustments bucket (P-C6)", () => {
  test("counts ADJUSTMENT+CORRECTION+COUNT, excludes SALE/STOCK_IN", async () => {
    m.inventory_logs.findMany.mockResolvedValue(
      mixedRows().map((r) => ({ changeTime: r.changeTime, logType: r.logType, delta: r.delta }))
    );
    const res = await dailyActivityGET(
      new NextRequest("http://x/api/reports/daily-activity?startDate=2026-06-10&endDate=2026-06-10")
    );
    const body = await res.json();
    const day = body.data.find((d: any) => d.adjustments > 0);
    // |7| + |-4| + |0| = 11; SALE(-9) and STOCK_IN(5) NOT counted.
    expect(day.adjustments).toBe(11);
  });
});

describe("date-details adjustments total (P-C6)", () => {
  test("counts ADJUSTMENT+CORRECTION+COUNT, excludes SALE/STOCK_IN", async () => {
    m.inventory_logs.findMany.mockResolvedValue(
      mixedRows().map((r) => ({
        id: r.id,
        changeTime: r.changeTime,
        logType: r.logType,
        delta: r.delta,
        products: { name: "Widget" },
        users: { username: "kris" },
        locations: { name: "Shelf A" },
      }))
    );
    const res = await dateDetailsGET(new NextRequest("http://x/api/reports/date-details?date=2026-06-10"));
    const body = await res.json();
    expect(body.totalAdjustments).toBe(11);
  });
});

describe("user-details activity pattern adjustments bucket (P-C6)", () => {
  test("counts ADJUSTMENT+CORRECTION+COUNT, excludes SALE/STOCK_IN", async () => {
    m.user.findUnique.mockResolvedValue({ id: 3, username: "kris" });
    m.inventory_logs.findMany.mockResolvedValue(
      mixedRows().map((r) => ({
        id: r.id,
        changeTime: r.changeTime,
        logType: r.logType,
        delta: r.delta,
        products: { name: "Widget" },
        locations: { name: "Shelf A" },
      }))
    );
    const res = await userDetailsGET(
      new NextRequest("http://x/api/reports/user-details/3?startDate=2026-06-10&endDate=2026-06-10"),
      { params: { id: "3" } }
    );
    const body = await res.json();
    const day = body.activityPattern.find((d: any) => d.adjustments > 0);
    expect(day.adjustments).toBe(11);
    // The raw activities list still surfaces the enum logType verbatim (drill-down).
    expect(body.activities.map((a: any) => a.type)).toEqual(
      expect.arrayContaining(["ADJUSTMENT", "CORRECTION", "COUNT", "SALE", "STOCK_IN"])
    );
  });
});
