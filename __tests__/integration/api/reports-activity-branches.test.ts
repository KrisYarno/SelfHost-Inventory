// @jest-environment node
//
// Phase C (P-C9 codex addition): the activity feed gains explicit, human descriptions
// for the new ledger logTypes — STOCK_IN "Received", SALE "Sold", CORRECTION "Corrected
// by ±N", COUNT "Counted — no change" for a zero delta. A zero-delta COUNT must NEVER
// read "Removed 0 units" (the old generic fallback). metadata.logType passthrough stays.
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    inventory_logs: { findMany: jest.fn(), count: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/reports/activity/route";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  inventory_logs: { findMany: jest.Mock; count: jest.Mock };
};

function row(id: number, logType: string, delta: number) {
  return {
    id,
    changeTime: new Date("2026-06-10T12:00:00.000Z"),
    logType,
    delta,
    users: { id: 1, username: "kris" },
    products: { id: 7, name: "Widget" },
    locations: { id: 2, name: "Shelf A" },
  };
}

async function getActivities(rows: any[]) {
  m.inventory_logs.findMany.mockResolvedValue(rows);
  m.inventory_logs.count.mockResolvedValue(rows.length);
  const res = await GET(new NextRequest("http://x/api/reports/activity"));
  const body = await res.json();
  return body.activities as any[];
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: true } });
});

test("STOCK_IN -> 'Received N units', type stock_in", async () => {
  const [a] = await getActivities([row(1, "STOCK_IN", 5)]);
  expect(a.description).toBe("Received 5 units of Widget");
  expect(a.type).toBe("stock_in");
  expect(a.metadata.logType).toBe("STOCK_IN");
});

test("SALE -> 'Sold N units', type stock_out", async () => {
  const [a] = await getActivities([row(1, "SALE", -9)]);
  expect(a.description).toBe("Sold 9 units of Widget");
  expect(a.type).toBe("stock_out");
  expect(a.metadata.logType).toBe("SALE");
});

test("CORRECTION -> 'Corrected by ±N' with the signed delta", async () => {
  const [neg, pos] = await getActivities([row(1, "CORRECTION", -4), row(2, "CORRECTION", 3)]);
  expect(neg.description).toBe("Corrected by -4 units of Widget");
  expect(pos.description).toBe("Corrected by +3 units of Widget");
});

test("zero-delta COUNT -> 'no change', NEVER 'Removed 0'", async () => {
  const [a] = await getActivities([row(1, "COUNT", 0)]);
  expect(a.description).toBe("Counted Widget — no change");
  expect(a.description).not.toContain("Removed 0");
  expect(a.type).toBe("adjustment");
});

test("non-zero COUNT surfaces the signed delta (still not the removed-0 fallback)", async () => {
  const [a] = await getActivities([row(1, "COUNT", 2)]);
  expect(a.description).toBe("Counted Widget: +2 units");
});

test("ADJUSTMENT keeps its existing delta-based descriptions", async () => {
  const [pos, neg, zero] = await getActivities([
    row(1, "ADJUSTMENT", 6),
    row(2, "ADJUSTMENT", -2),
    row(3, "ADJUSTMENT", 0),
  ]);
  expect(pos.description).toBe("Stocked in 6 units of Widget");
  expect(neg.description).toBe("Removed 2 units of Widget");
  expect(zero.description).toBe("No quantity change for Widget");
});
