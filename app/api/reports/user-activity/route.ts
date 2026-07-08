import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { subDays } from "date-fns";
import { UserActivityResponse, UserActivitySummary } from "@/types/reports";

export const dynamic = "force-dynamic";

// Default trailing window applied when the client sends no explicit range.
// The reports "User Activity" panel (components/reports/user-activity.tsx) fetches this
// endpoint with NO query params, so without a bound this route used to read the ENTIRE
// inventory_logs table into memory every request. A 1-year trailing window bounds the
// scan while preserving the panel's semantics in practice: for an active inventory
// virtually all meaningful activity (and the >100/>50 activity-level buckets the card
// renders) falls inside the last year. Explicit startDate/endDate override the default.
const USER_ACTIVITY_WINDOW_DAYS = 365;

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const startDateParam = searchParams.get("startDate");
  const endDateParam = searchParams.get("endDate");

  // Bound the query: explicit range if supplied, otherwise a trailing default window.
  const rangeStart = startDateParam ? new Date(startDateParam) : subDays(new Date(), USER_ACTIVITY_WINDOW_DAYS);
  const rangeEnd = endDateParam ? new Date(endDateParam) : null; // open-ended to "now"

  // Get all users
  const users = await prisma.user.findMany({
    where: { isApproved: true },
  });
  const userIds = users.map((u) => u.id);

  // Shared changeTime window + approved-user filter reused by every aggregate below.
  const changeTime: { gte: Date; lte?: Date } = { gte: rangeStart };
  if (rangeEnd) changeTime.lte = rangeEnd;
  const baseWhere = { userId: { in: userIds }, changeTime };

  // Aggregate in the DB via groupBy instead of streaming the whole table into JS.
  // Each grouped query returns at most one row per user, so nothing unbounded is
  // materialized in memory (a hard row cap is unnecessary once aggregation is pushed
  // down). Conditional counts (in/out/adjustment) cannot share a single groupBy, so
  // they run as four cheap parallel aggregates over the covering index
  // idx_inventory_logs_user_covering(userId, changeTime, ..., delta).
  const [totals, stockIn, stockOut, adjustments] = await Promise.all([
    prisma.inventory_logs.groupBy({
      by: ["userId"],
      where: baseWhere,
      _count: { _all: true },
      _max: { changeTime: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["userId"],
      where: { ...baseWhere, delta: { gt: 0 } },
      _count: { _all: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["userId"],
      where: { ...baseWhere, delta: { lt: 0 } },
      _count: { _all: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["userId"],
      where: { ...baseWhere, logType: "ADJUSTMENT" },
      _count: { _all: true },
    }),
  ]);

  const totalMap = new Map<number, { count: number; last: Date | null }>();
  totals.forEach((t) => totalMap.set(t.userId, { count: t._count._all, last: t._max.changeTime }));
  const stockInMap = new Map<number, number>(stockIn.map((s) => [s.userId, s._count._all]));
  const stockOutMap = new Map<number, number>(stockOut.map((s) => [s.userId, s._count._all]));
  const adjustmentMap = new Map<number, number>(adjustments.map((s) => [s.userId, s._count._all]));

  const userActivities: UserActivitySummary[] = users.map((user) => {
    const total = totalMap.get(user.id);
    return {
      userId: user.id,
      username: user.username,
      totalTransactions: total?.count ?? 0,
      stockInCount: stockInMap.get(user.id) ?? 0,
      stockOutCount: stockOutMap.get(user.id) ?? 0,
      adjustmentCount: adjustmentMap.get(user.id) ?? 0,
      lastActivity: total?.last ?? null,
    };
  });

  // Sort by total transactions (most active first)
  userActivities.sort((a, b) => b.totalTransactions - a.totalTransactions);

  const response: UserActivityResponse = {
    users: userActivities,
  };

  return NextResponse.json(response);
});
