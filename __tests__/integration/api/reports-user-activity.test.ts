// @jest-environment node
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: jest.fn() },
    inventory_logs: { groupBy: jest.fn(), findMany: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/reports/user-activity/route";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  user: { findMany: jest.Mock };
  inventory_logs: { groupBy: jest.Mock; findMany: jest.Mock };
};

// Route the four grouped aggregates by inspecting each groupBy where-clause, so the test is
// independent of the Promise.all call ordering.
function routeGroupBy(rows: {
  totals: any[];
  stockIn: any[];
  stockOut: any[];
  adjustments: any[];
}) {
  m.inventory_logs.groupBy.mockImplementation(async (arg: any) => {
    const where = arg.where ?? {};
    if (where.delta?.gt !== undefined) return rows.stockIn;
    if (where.delta?.lt !== undefined) return rows.stockOut;
    if (where.logType !== undefined) return rows.adjustments;
    return rows.totals;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: true } });
  m.user.findMany.mockResolvedValue([
    { id: 1, username: "alice", isApproved: true },
    { id: 2, username: "bob", isApproved: true },
  ]);
  routeGroupBy({ totals: [], stockIn: [], stockOut: [], adjustments: [] });
});

test("aggregates via groupBy into the expected response shape, sorted by totalTransactions desc", async () => {
  routeGroupBy({
    totals: [
      { userId: 1, _count: { _all: 5 }, _max: { changeTime: new Date("2026-06-10T00:00:00.000Z") } },
      { userId: 2, _count: { _all: 2 }, _max: { changeTime: new Date("2026-06-05T00:00:00.000Z") } },
    ],
    stockIn: [
      { userId: 1, _count: { _all: 3 } },
      { userId: 2, _count: { _all: 1 } },
    ],
    stockOut: [
      { userId: 1, _count: { _all: 2 } },
      { userId: 2, _count: { _all: 1 } },
    ],
    adjustments: [{ userId: 1, _count: { _all: 1 } }],
  });

  const res = await GET(new NextRequest("http://x/api/reports/user-activity"));
  const body = await res.json();

  expect(body.users).toEqual([
    {
      userId: 1,
      username: "alice",
      totalTransactions: 5,
      stockInCount: 3,
      stockOutCount: 2,
      adjustmentCount: 1,
      lastActivity: "2026-06-10T00:00:00.000Z",
    },
    {
      userId: 2,
      username: "bob",
      totalTransactions: 2,
      stockInCount: 1,
      stockOutCount: 1,
      adjustmentCount: 0, // absent from adjustments groupBy => defaults to 0
      lastActivity: "2026-06-05T00:00:00.000Z",
    },
  ]);
});

test("a user with no activity gets zero counts and null lastActivity", async () => {
  // Only user 1 has any logs; user 2 is absent from every aggregate.
  routeGroupBy({
    totals: [{ userId: 1, _count: { _all: 4 }, _max: { changeTime: new Date("2026-06-09T00:00:00.000Z") } }],
    stockIn: [{ userId: 1, _count: { _all: 4 } }],
    stockOut: [],
    adjustments: [],
  });

  const res = await GET(new NextRequest("http://x/api/reports/user-activity"));
  const body = await res.json();

  const bob = body.users.find((u: any) => u.userId === 2);
  expect(bob).toEqual({
    userId: 2,
    username: "bob",
    totalTransactions: 0,
    stockInCount: 0,
    stockOutCount: 0,
    adjustmentCount: 0,
    lastActivity: null,
  });
});

test("machine-actor rows (userId null) are excluded from per-user stats and never form a 'System' bucket", async () => {
  // Change-tracking foundation: inventory_logs.userId is now nullable, so groupBy(["userId"])
  // can surface a null key. Per-user attribution must NOT count these against any real user,
  // and must NOT invent a synthetic "System" user row (truthful-data: exclude, don't fabricate).
  routeGroupBy({
    totals: [
      { userId: 1, _count: { _all: 5 }, _max: { changeTime: new Date("2026-06-10T00:00:00.000Z") } },
      { userId: null, _count: { _all: 99 }, _max: { changeTime: new Date("2026-06-11T00:00:00.000Z") } },
    ],
    stockIn: [
      { userId: 1, _count: { _all: 3 } },
      { userId: null, _count: { _all: 50 } },
    ],
    stockOut: [{ userId: null, _count: { _all: 40 } }],
    adjustments: [{ userId: null, _count: { _all: 9 } }],
  });

  const res = await GET(new NextRequest("http://x/api/reports/user-activity"));
  const body = await res.json();

  // Only the two approved real users appear — no synthetic System/null row.
  expect(body.users).toHaveLength(2);
  expect(body.users.map((u: any) => u.userId)).toEqual([1, 2]);
  expect(body.users.some((u: any) => u.username === "System")).toBe(false);
  expect(body.users.some((u: any) => u.userId === null)).toBe(false);

  // The null-actor counts (99/50/40/9) leak into NObody's totals.
  const alice = body.users.find((u: any) => u.userId === 1);
  expect(alice).toMatchObject({ totalTransactions: 5, stockInCount: 3, stockOutCount: 0, adjustmentCount: 0 });
  const bob = body.users.find((u: any) => u.userId === 2);
  expect(bob).toMatchObject({ totalTransactions: 0, stockInCount: 0, stockOutCount: 0, adjustmentCount: 0 });
});

test("no range params => a default trailing window (~365d) bounds every aggregate; nothing is streamed via findMany", async () => {
  await GET(new NextRequest("http://x/api/reports/user-activity"));

  // Aggregation is pushed into the DB: four grouped queries, no row-streaming findMany.
  expect(m.inventory_logs.groupBy).toHaveBeenCalledTimes(4);
  expect(m.inventory_logs.findMany).not.toHaveBeenCalled();

  for (const call of m.inventory_logs.groupBy.mock.calls) {
    const where = call[0].where;
    expect(where.userId).toEqual({ in: [1, 2] });
    const gte = where.changeTime.gte as Date;
    expect(gte).toBeInstanceOf(Date);
    const diffDays = (Date.now() - gte.getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(364);
    expect(diffDays).toBeLessThan(366);
    // Open-ended to "now" when no endDate is supplied.
    expect(where.changeTime).not.toHaveProperty("lte");
  }
});

test("explicit startDate/endDate are honored server-side and clamped into every aggregate", async () => {
  const start = "2026-01-01T00:00:00.000Z";
  const end = "2026-03-01T00:00:00.000Z";
  await GET(
    new NextRequest(`http://x/api/reports/user-activity?startDate=${start}&endDate=${end}`)
  );

  for (const call of m.inventory_logs.groupBy.mock.calls) {
    const where = call[0].where;
    expect((where.changeTime.gte as Date).toISOString()).toBe(start);
    expect((where.changeTime.lte as Date).toISOString()).toBe(end);
  }
});
