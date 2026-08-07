/**
 * @jest-environment node
 *
 * Lane reorder-points — Task 2: the ONE demand module (lib/reports/demand.ts).
 *
 * Pins the LOCKED reorder-demand predicate and the truthful days-covered math:
 *  - delta < 0 AND logType != TRANSFER AND (reasonCode IS NULL OR != 'CORRECTION').
 *  - TRANSFER excluded at the SQL boundary; CORRECTION excluded in JS (reorderDemand);
 *    a null/DAMAGE/THEFT/EXPIRY reason is INCLUDED.
 *  - avgDailyDemand = sum(|delta|) / daysCovered (days from first-qualifying-outbound
 *    to now, clamped [1, windowDays]) — NEVER a flat 30, NEVER 0-as-measurement.
 *  - zero qualifying rows => avgDailyDemand: null, outboundEvents: 0, daysCovered: 0,
 *    demandUnits: 0, mix: null (spec C12 — a null mix, never a zero-filled one).
 *  - demandUnits is the RAW numerator and `mix` its six-bucket composition over exactly
 *    the rows the predicate admitted (spec C12): bucket sum == demandUnits, always.
 *  - outboundVelocity (the units-out sibling) INCLUDES corrections (registered: not
 *    aligned to the reorder predicate) but shares the days-covered + null semantics.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import prisma from "@/lib/prisma";
import {
  reorderDemand,
  outboundVelocity,
  isReorderDemandRow,
  isOutboundUsageRow,
} from "@/lib/reports/demand";
import { emptyOutboundMix, type OutboundMix } from "@/lib/reports/outbound-mix";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

/** The C12 mix additions, spelled out per fixture so the exact ProductDemand shape
 *  stays pinned (a partial assertion would let a bucket drift unnoticed). */
const mixOf = (over: Partial<OutboundMix>): OutboundMix => ({ ...emptyOutboundMix(), ...over });
const NO_SIGNAL = { avgDailyDemand: null, outboundEvents: 0, daysCovered: 0, demandUnits: 0, mix: null };

const NOW = new Date("2026-07-14T00:00:00.000Z");
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

beforeEach(() => {
  mockReset(db);
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("pure predicates", () => {
  it("isReorderDemandRow excludes TRANSFER and CORRECTION, includes null/DAMAGE", () => {
    expect(isReorderDemandRow({ delta: -1, logType: "SALE", reasonCode: null })).toBe(true);
    expect(isReorderDemandRow({ delta: -1, logType: "ADJUSTMENT", reasonCode: "DAMAGE" })).toBe(true);
    expect(isReorderDemandRow({ delta: -1, logType: "TRANSFER", reasonCode: null })).toBe(false);
    expect(isReorderDemandRow({ delta: -1, logType: "CORRECTION", reasonCode: "CORRECTION" })).toBe(false);
    expect(isReorderDemandRow({ delta: -1, logType: "ADJUSTMENT", reasonCode: "CORRECTION" })).toBe(false);
    expect(isReorderDemandRow({ delta: 5, logType: "SALE", reasonCode: null })).toBe(false); // inbound
  });

  it("isOutboundUsageRow excludes only TRANSFER — corrections count as usage", () => {
    expect(isOutboundUsageRow({ delta: -1, logType: "SALE", reasonCode: null })).toBe(true);
    expect(isOutboundUsageRow({ delta: -1, logType: "ADJUSTMENT", reasonCode: "CORRECTION" })).toBe(true);
    expect(isOutboundUsageRow({ delta: -1, logType: "TRANSFER", reasonCode: null })).toBe(false);
    expect(isOutboundUsageRow({ delta: 5, logType: "SALE", reasonCode: null })).toBe(false);
  });
});

describe("reorderDemand — LOCKED predicate + days-covered", () => {
  it("computes avgDaily = sum/daysCovered, counts events, excludes corrections", async () => {
    db.inventory_logs.findMany.mockResolvedValue([
      // product 1: three genuine outbound events, first 5 days ago.
      { productId: 1, delta: -2, changeTime: daysAgo(5), logType: "SALE", reasonCode: null },
      { productId: 1, delta: -3, changeTime: daysAgo(3), logType: "SALE", reasonCode: null },
      { productId: 1, delta: -1, changeTime: daysAgo(1), logType: "ADJUSTMENT", reasonCode: null },
      // product 2: a single CORRECTION reversal — excluded entirely.
      { productId: 2, delta: -10, changeTime: daysAgo(4), logType: "ADJUSTMENT", reasonCode: "CORRECTION" },
      // product 3: a genuine DAMAGE loss 2 days ago — included.
      { productId: 3, delta: -4, changeTime: daysAgo(2), logType: "ADJUSTMENT", reasonCode: "DAMAGE" },
    ] as never);

    const map = await reorderDemand([1, 2, 3, 4], 30);

    expect(map.get(1)).toEqual({
      avgDailyDemand: 6 / 5,
      outboundEvents: 3,
      daysCovered: 5,
      demandUnits: 6,
      mix: mixOf({ sale: 5, adjustmentUnclassified: 1 }),
    });
    expect(map.get(2)).toEqual(NO_SIGNAL);
    expect(map.get(3)).toEqual({
      avgDailyDemand: 2,
      outboundEvents: 1,
      daysCovered: 2,
      demandUnits: 4,
      mix: mixOf({ classifiedLoss: 4 }),
    });
    // product 4 had no rows at all — still present, still null (never 0-as-measurement).
    expect(map.get(4)).toEqual(NO_SIGNAL);

    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.delta).toEqual({ lt: 0 });
    expect(where.logType).toEqual({ not: "TRANSFER" });
  });

  it("floors daysCovered at 1 for a same-day-only signal (no divide-by-zero)", async () => {
    db.inventory_logs.findMany.mockResolvedValue([
      { productId: 1, delta: -5, changeTime: NOW, logType: "SALE", reasonCode: null },
    ] as never);
    const map = await reorderDemand([1], 30);
    expect(map.get(1)).toEqual({
      avgDailyDemand: 5,
      outboundEvents: 1,
      daysCovered: 1,
      demandUnits: 5,
      mix: mixOf({ sale: 5 }),
    });
  });

  it("clamps daysCovered to windowDays when the first event predates the window edge", async () => {
    db.inventory_logs.findMany.mockResolvedValue([
      { productId: 1, delta: -30, changeTime: daysAgo(40), logType: "ADJUSTMENT", reasonCode: null },
    ] as never);
    const map = await reorderDemand([1], 30);
    expect(map.get(1)).toEqual({
      avgDailyDemand: 1,
      outboundEvents: 1,
      daysCovered: 30,
      demandUnits: 30,
      mix: mixOf({ adjustmentUnclassified: 30 }),
    });
  });

  it("returns an empty map for an empty id list without querying", async () => {
    const map = await reorderDemand([], 30);
    expect(map.size).toBe(0);
    expect(db.inventory_logs.findMany).not.toHaveBeenCalled();
  });
});

describe("outboundVelocity — corrections INCLUDED; optional location scope", () => {
  it("counts a correction row as usage (distinct from reorder demand)", async () => {
    db.inventory_logs.findMany.mockResolvedValue([
      { productId: 2, delta: -10, changeTime: daysAgo(4), logType: "ADJUSTMENT", reasonCode: "CORRECTION" },
    ] as never);
    const map = await outboundVelocity([2], 30);
    // The SAME row the reorder predicate drops: physical outbound counts it, and the
    // mix places it in adjustmentUnclassified (the reason is not a logType).
    expect(map.get(2)).toEqual({
      avgDailyDemand: 10 / 4,
      outboundEvents: 1,
      daysCovered: 4,
      demandUnits: 10,
      mix: mixOf({ adjustmentUnclassified: 10 }),
    });
  });

  it("pushes a locationId into the where clause when provided", async () => {
    db.inventory_logs.findMany.mockResolvedValue([] as never);
    await outboundVelocity([1], 30, { locationId: 7 });
    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.locationId).toBe(7);
  });
});
