/**
 * @jest-environment node
 *
 * The metrics contract (assistant toolsuite breadth, spec §2 D1-D5): the two locked
 * outbound predicates (row AND Prisma-where variants against a mocked findMany), the
 * shared days-covered denominator, and the non-empty definition strings.
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import prisma from "@/lib/prisma";
import {
  isPhysicalOutboundRow,
  isReorderDemandRow,
  PHYSICAL_OUTBOUND_WHERE,
  REORDER_DEMAND_WHERE,
  daysCovered,
  PHYSICAL_OUTBOUND_DEFINITION,
  REORDER_DEMAND_DEFINITION,
  OUTBOUND_USAGE_DEFINITION,
  SHRINKAGE_CLASS_REASONS,
} from "@/lib/reports/metrics-contract";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const DAY_MS = 86_400_000;

beforeEach(() => mockReset(db));

describe("predicates — row variants (spec §2 D1)", () => {
  it("isPhysicalOutboundRow: negative non-transfer only; corrections INCLUDED", () => {
    expect(isPhysicalOutboundRow({ delta: -1, logType: "SALE" })).toBe(true);
    expect(isPhysicalOutboundRow({ delta: -1, logType: "ADJUSTMENT" })).toBe(true);
    expect(isPhysicalOutboundRow({ delta: -1, logType: "TRANSFER" })).toBe(false); // TRANSFER excluded
    expect(isPhysicalOutboundRow({ delta: 5, logType: "SALE" })).toBe(false); // inbound
  });

  it("isReorderDemandRow: excludes TRANSFER and CORRECTION; INCLUDES null/DAMAGE reason", () => {
    expect(isReorderDemandRow({ delta: -1, logType: "SALE", reasonCode: null })).toBe(true);
    expect(isReorderDemandRow({ delta: -1, logType: "ADJUSTMENT", reasonCode: "DAMAGE" })).toBe(true);
    expect(isReorderDemandRow({ delta: -1, logType: "TRANSFER", reasonCode: null })).toBe(false);
    expect(isReorderDemandRow({ delta: -1, logType: "ADJUSTMENT", reasonCode: "CORRECTION" })).toBe(false);
    expect(isReorderDemandRow({ delta: 5, logType: "SALE", reasonCode: null })).toBe(false);
  });

  it("the two predicates diverge ONLY on CORRECTION (D5)", () => {
    const correction = { delta: -3, logType: "ADJUSTMENT", reasonCode: "CORRECTION" };
    expect(isPhysicalOutboundRow(correction)).toBe(true); // usage counts it
    expect(isReorderDemandRow(correction)).toBe(false); // demand does not
    // a null reason lands in BOTH.
    const plain = { delta: -3, logType: "SALE", reasonCode: null };
    expect(isPhysicalOutboundRow(plain)).toBe(true);
    expect(isReorderDemandRow(plain)).toBe(true);
  });
});

describe("predicates — Prisma-where variants (spec §2 D1)", () => {
  it("PHYSICAL_OUTBOUND_WHERE is delta<0 AND logType != TRANSFER", () => {
    expect(PHYSICAL_OUTBOUND_WHERE).toEqual({ delta: { lt: 0 }, logType: { not: "TRANSFER" } });
  });

  it("REORDER_DEMAND_WHERE keeps null-reasonCode rows via OR (bare NOT excludes nulls — Prisma SQL 3VL)", () => {
    // Prisma docs: `not` on a NULLABLE column does NOT return NULL rows; you must add an
    // OR to include them. A bare `NOT: { reasonCode: "CORRECTION" }` therefore drops every
    // null-reason sale — the exact rows demand MUST count. The OR restores null-inclusion.
    expect(REORDER_DEMAND_WHERE).toEqual({
      delta: { lt: 0 },
      logType: { not: "TRANSFER" },
      OR: [{ reasonCode: null }, { NOT: { reasonCode: "CORRECTION" } }],
    });
  });

  it("passes each WHERE to a mocked findMany verbatim", async () => {
    db.inventory_logs.findMany.mockResolvedValue([] as never);
    await prisma.inventory_logs.findMany({ where: PHYSICAL_OUTBOUND_WHERE });
    await prisma.inventory_logs.findMany({ where: REORDER_DEMAND_WHERE });
    expect(db.inventory_logs.findMany).toHaveBeenNthCalledWith(1, {
      where: { delta: { lt: 0 }, logType: { not: "TRANSFER" } },
    });
    expect(db.inventory_logs.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        delta: { lt: 0 },
        logType: { not: "TRANSFER" },
        OR: [{ reasonCode: null }, { NOT: { reasonCode: "CORRECTION" } }],
      },
    });
  });
});

describe("daysCovered denominator (spec §2 D2)", () => {
  const now = 1_000 * DAY_MS;
  it("floors a same-day span at 1 (no divide-by-zero)", () => {
    expect(daysCovered(now, now, 30)).toBe(1);
  });
  it("ceilings a partial span", () => {
    expect(daysCovered(now - 5 * DAY_MS, now, 30)).toBe(5);
    expect(daysCovered(now - Math.floor(4.2 * DAY_MS), now, 30)).toBe(5); // ceil(4.2) = 5
  });
  it("clamps to windowDays when the first event predates the window edge", () => {
    expect(daysCovered(now - 40 * DAY_MS, now, 30)).toBe(30);
  });
});

describe("definition strings are non-empty (spec §2 D3)", () => {
  it.each([
    ["PHYSICAL_OUTBOUND_DEFINITION", PHYSICAL_OUTBOUND_DEFINITION],
    ["REORDER_DEMAND_DEFINITION", REORDER_DEMAND_DEFINITION],
    ["OUTBOUND_USAGE_DEFINITION", OUTBOUND_USAGE_DEFINITION],
  ])("%s is a non-empty string", (_name, value) => {
    expect(typeof value).toBe("string");
    expect((value as string).length).toBeGreaterThan(0);
  });

  // Quality+reach lane C3: the payload prose must state the EXACT predicate it measures
  // and must never claim empirical composition ("largest component", "genuine losses") —
  // review F2's over-claims are what made outbound figures read as verified sales.
  it.each([
    ["PHYSICAL_OUTBOUND_DEFINITION", PHYSICAL_OUTBOUND_DEFINITION, "delta < 0"],
    ["REORDER_DEMAND_DEFINITION", REORDER_DEMAND_DEFINITION, "reasonCode != CORRECTION"],
    ["OUTBOUND_USAGE_DEFINITION", OUTBOUND_USAGE_DEFINITION, "delta < 0"],
  ])("%s states its exact predicate", (_n, s, predicate) => {
    expect(s).toContain(predicate);
    expect(s.toLowerCase()).toContain("not evidence of verified sales");
    expect(s).not.toMatch(/largest component|genuine losses/); // the review-F2 over-claims
  });

  // Quality+reach C12 (Task 2.1): the W0 text pointed at get_movement_series's outbound
  // buckets because the mix fields did not exist yet. Now they do — and they decompose
  // the SAME rows this definition describes, so the pointer names them instead (a
  // reader should not have to make a second, differently-defined call to see the split).
  it("PHYSICAL_OUTBOUND_DEFINITION points at the mix FIELDS, not at another tool's buckets", () => {
    expect(PHYSICAL_OUTBOUND_DEFINITION).toContain("outboundMix30");
    for (const bucket of [
      "sale",
      "classifiedLoss",
      "adjustmentUnclassified",
      "correctionUnclassified",
      "countOut",
      "stockInReversal",
    ]) {
      expect(PHYSICAL_OUTBOUND_DEFINITION).toContain(bucket);
    }
    expect(PHYSICAL_OUTBOUND_DEFINITION).not.toContain("get_movement_series");
  });

  // The taxonomy moved here in Task 2.1 (G2-5 module cycle); queries.ts keeps a
  // deprecated re-export. Both spellings must stay the SAME frozen tuple.
  it("SHRINKAGE_CLASS_REASONS is the canonical four-reason taxonomy", () => {
    expect(SHRINKAGE_CLASS_REASONS).toEqual(["DAMAGE", "THEFT", "EXPIRY", "COUNT"]);
  });
});
