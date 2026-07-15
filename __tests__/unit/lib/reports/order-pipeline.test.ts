/**
 * @jest-environment node
 *
 * assistant toolsuite breadth — W2-ORD: the order-pipeline module
 * (lib/reports/order-pipeline.ts, spec §5 T-ORD REV-2).
 *
 * Pins the normative choices:
 *   - PII ALLOWLIST: the two exported `select` objects match the allowlist EXACTLY
 *     (the W2-INT PII gate snapshots these); no PII/verbatim column is selectable.
 *   - ORDER-level and ITEM-level sections are SEPARATE — a 3-item order never
 *     triples its revenue.
 *   - timestamp = externalCreatedAt ?? createdAt; the fallback USE count is disclosed.
 *   - final statuses = fulfilled|cancelled; aging (0-7 / 8-30 / 31+ elapsed days vs
 *     an injectable `now`) applies to pending|processing ONLY, at the 7/8 & 30/31
 *     boundaries.
 *   - grouped by (groupBy key AND currency); currencies disclosed.
 *   - empty companyIds ⇒ empty result WITHOUT querying.
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import type { ResolvedWindow } from "@/lib/assistant/window";

jest.mock("@/lib/prisma", () => {
  const { mockDeep } = require("jest-mock-extended");
  return { __esModule: true, default: mockDeep() };
});

import prisma from "@/lib/prisma";
import {
  getOrderPipeline,
  ORDER_PIPELINE_SELECT,
  ORDER_ITEM_UNITS_SELECT,
  FINAL_ORDER_STATUSES,
} from "@/lib/reports/order-pipeline";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const win = (from: string, to: string): ResolvedWindow => ({
  from,
  to,
  days: Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  ) + 1,
  source: "explicit",
});

/** Minimal ExternalOrder fixture matching ORDER_PIPELINE_SELECT. */
type OrderRow = {
  id: string;
  companyId: string;
  integrationId: string;
  internalStatus: string;
  nativeStatus: string;
  total: number; // module coerces Decimal|string|number → cents
  currency: string;
  externalCreatedAt: Date | null;
  createdAt: Date;
};
/** Minimal ExternalOrderItem fixture matching ORDER_ITEM_UNITS_SELECT. */
type ItemRow = { id: string; orderId: string; quantity: number; isMapped: boolean };

const D = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

const mkOrder = (p: Partial<OrderRow> & { id: string }): OrderRow => ({
  companyId: "c1",
  integrationId: "int1",
  internalStatus: "pending",
  nativeStatus: "processing",
  total: 100,
  currency: "USD",
  externalCreatedAt: D("2026-07-10"),
  createdAt: D("2026-07-10"),
  ...p,
});

const setOrders = (rows: OrderRow[]) =>
  db.externalOrder.findMany.mockResolvedValue(rows as never);
const setItems = (rows: ItemRow[]) =>
  db.externalOrderItem.findMany.mockResolvedValue(rows as never);

const WINDOW = win("2026-07-01", "2026-07-31");

beforeEach(() => {
  mockReset(db);
  setItems([]); // default: no items unless a test overrides
});

// ───────────────────────────────────────────────────────────────────────────
describe("PII allowlist — the exported selects match the allowlist EXACTLY", () => {
  it("ORDER_PIPELINE_SELECT is the nine-column allowlist and NOTHING else", () => {
    expect(ORDER_PIPELINE_SELECT).toEqual({
      id: true,
      companyId: true,
      integrationId: true,
      internalStatus: true,
      nativeStatus: true,
      total: true,
      currency: true,
      externalCreatedAt: true,
      createdAt: true,
    });
  });

  it("ORDER_PIPELINE_SELECT selects NONE of the PII/verbatim columns", () => {
    for (const pii of [
      "customerEmail",
      "customerName",
      "rawPayload",
      "platformStatusRaw",
      "externalOrderUrl",
    ]) {
      expect(pii in ORDER_PIPELINE_SELECT).toBe(false);
    }
  });

  it("ORDER_ITEM_UNITS_SELECT is units + mapping only", () => {
    expect(ORDER_ITEM_UNITS_SELECT).toEqual({
      id: true,
      orderId: true,
      quantity: true,
      isMapped: true,
    });
    // no name/sku/price leak
    for (const leak of ["name", "sku", "price", "variantName"]) {
      expect(leak in ORDER_ITEM_UNITS_SELECT).toBe(false);
    }
  });

  it("EVERY query uses the allowlist select and never `include`", async () => {
    setOrders([mkOrder({ id: "o1" })]);
    setItems([{ id: "i1", orderId: "o1", quantity: 1, isMapped: true }]);
    await getOrderPipeline({ window: WINDOW, groupBy: "status", companyIds: ["c1"] });

    const orderCall = db.externalOrder.findMany.mock.calls[0][0]!;
    expect(orderCall.select).toBe(ORDER_PIPELINE_SELECT);
    expect((orderCall as Record<string, unknown>).include).toBeUndefined();

    const itemCall = db.externalOrderItem.findMany.mock.calls[0][0]!;
    expect(itemCall.select).toBe(ORDER_ITEM_UNITS_SELECT);
    expect((itemCall as Record<string, unknown>).include).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("ORDER vs ITEM sections are SEPARATE — no cross-multiply", () => {
  it("a 3-item order counts revenue ONCE and units THREE times (never 3× revenue)", async () => {
    setOrders([mkOrder({ id: "o1", internalStatus: "processing", total: 100, currency: "USD" })]);
    setItems([
      { id: "i1", orderId: "o1", quantity: 2, isMapped: true },
      { id: "i2", orderId: "o1", quantity: 2, isMapped: true },
      { id: "i3", orderId: "o1", quantity: 2, isMapped: true },
    ]);

    const res = await getOrderPipeline({ window: WINDOW, groupBy: "status", companyIds: ["c1"] });

    expect(res.orders).toEqual([
      { key: "processing", currency: "USD", orderCount: 1, totalCents: 10000 },
    ]);
    // Revenue is NOT 30000 — the three items do not multiply the order total.
    expect(res.orders[0].totalCents).toBe(10000);
    expect(res.items).toEqual([{ key: "processing", currency: "USD", units: 6, unmappedItems: 0 }]);
  });

  it("counts unmapped line items separately (coverage, not zero)", async () => {
    setOrders([mkOrder({ id: "o1", internalStatus: "pending" })]);
    setItems([
      { id: "i1", orderId: "o1", quantity: 5, isMapped: true },
      { id: "i2", orderId: "o1", quantity: 3, isMapped: false },
    ]);

    const res = await getOrderPipeline({ window: WINDOW, groupBy: "status", companyIds: ["c1"] });
    expect(res.items[0]).toMatchObject({ units: 8, unmappedItems: 1 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("timestamp convention — externalCreatedAt ?? createdAt + fallback disclosure", () => {
  it("counts orders that fell back to createdAt (externalCreatedAt null) in coverage", async () => {
    setOrders([
      mkOrder({ id: "a", externalCreatedAt: D("2026-07-05"), createdAt: D("2026-07-05") }),
      mkOrder({ id: "b", externalCreatedAt: null, createdAt: D("2026-07-06") }),
      mkOrder({ id: "c", externalCreatedAt: null, createdAt: D("2026-07-07") }),
    ]);
    const res = await getOrderPipeline({ window: WINDOW, groupBy: "status", companyIds: ["c1"] });
    expect(res.coverage.timestampFallbacks).toBe(2);
    expect(res.coverage.refundsNote).toBe("refunds are not netted");
  });

  it("groupBy day uses the fallback createdAt dayKey when externalCreatedAt is null", async () => {
    setOrders([
      mkOrder({ id: "a", externalCreatedAt: D("2026-07-05"), createdAt: D("2026-07-20") }),
      mkOrder({ id: "b", externalCreatedAt: null, createdAt: D("2026-07-09") }),
    ]);
    const res = await getOrderPipeline({ window: WINDOW, groupBy: "day", companyIds: ["c1"] });
    // 'a' keys on externalCreatedAt (2026-07-05), 'b' falls back to createdAt (2026-07-09).
    expect(res.orders.map((r) => r.key)).toEqual(["2026-07-05", "2026-07-09"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("aging — final-status exclusion + 7/8 and 30/31 boundaries", () => {
  const NOW = new Date("2026-07-31T12:00:00.000Z");
  const agedDays = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it("buckets OPEN orders at the boundaries and EXCLUDES fulfilled|cancelled", async () => {
    setOrders([
      mkOrder({ id: "p7", internalStatus: "pending", externalCreatedAt: agedDays(7) }), // → 0-7
      mkOrder({ id: "p8", internalStatus: "processing", externalCreatedAt: agedDays(8) }), // → 8-30
      mkOrder({ id: "p30", internalStatus: "pending", externalCreatedAt: agedDays(30) }), // → 8-30
      mkOrder({ id: "p31", internalStatus: "processing", externalCreatedAt: agedDays(31) }), // → 31+
      mkOrder({ id: "f", internalStatus: "fulfilled", externalCreatedAt: agedDays(40) }), // excluded
      mkOrder({ id: "x", internalStatus: "cancelled", externalCreatedAt: agedDays(40) }), // excluded
    ]);

    const res = await getOrderPipeline({
      window: WINDOW,
      groupBy: "status",
      companyIds: ["c1"],
      now: NOW,
    });

    expect(res.aging).toEqual({ days0to7: 1, days8to30: 2, days31plus: 1 });
    expect(FINAL_ORDER_STATUSES).toEqual(["fulfilled", "cancelled"]);
    expect(res.coverage.finalStatuses).toEqual(["fulfilled", "cancelled"]);
  });

  it("aging uses the timestamp fallback (createdAt) when externalCreatedAt is null", async () => {
    setOrders([
      mkOrder({ id: "p", internalStatus: "pending", externalCreatedAt: null, createdAt: agedDays(31) }),
    ]);
    const res = await getOrderPipeline({
      window: WINDOW,
      groupBy: "status",
      companyIds: ["c1"],
      now: NOW,
    });
    expect(res.aging).toEqual({ days0to7: 0, days8to30: 0, days31plus: 1 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("currency split — a second currency produces separate rows", () => {
  it("splits orders AND items by currency and discloses the currency list", async () => {
    setOrders([
      mkOrder({ id: "u", internalStatus: "pending", total: 100, currency: "USD" }),
      mkOrder({ id: "e", internalStatus: "pending", total: 50, currency: "EUR" }),
    ]);
    setItems([
      { id: "iu", orderId: "u", quantity: 3, isMapped: true },
      { id: "ie", orderId: "e", quantity: 4, isMapped: true },
    ]);

    const res = await getOrderPipeline({ window: WINDOW, groupBy: "status", companyIds: ["c1"] });

    expect(res.orders).toEqual([
      { key: "pending", currency: "EUR", orderCount: 1, totalCents: 5000 },
      { key: "pending", currency: "USD", orderCount: 1, totalCents: 10000 },
    ]);
    expect(res.items).toEqual([
      { key: "pending", currency: "EUR", units: 4, unmappedItems: 0 },
      { key: "pending", currency: "USD", units: 3, unmappedItems: 0 },
    ]);
    expect(res.coverage.currencies).toEqual(["EUR", "USD"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("groupBy shapes — status | integration | day", () => {
  it("groupBy status groups by internalStatus", async () => {
    setOrders([
      mkOrder({ id: "a", internalStatus: "pending" }),
      mkOrder({ id: "b", internalStatus: "pending" }),
      mkOrder({ id: "c", internalStatus: "processing" }),
    ]);
    const res = await getOrderPipeline({ window: WINDOW, groupBy: "status", companyIds: ["c1"] });
    expect(res.orders).toEqual([
      { key: "pending", currency: "USD", orderCount: 2, totalCents: 20000 },
      { key: "processing", currency: "USD", orderCount: 1, totalCents: 10000 },
    ]);
    // nativeStatusByIntegration is NOT disclosed unless groupBy === integration.
    expect(res.coverage.nativeStatusByIntegration).toBeUndefined();
    expect(res.coverage.platformStatusNote).toBeUndefined();
  });

  it("groupBy integration groups by integrationId and discloses platform-verbatim nativeStatus", async () => {
    setOrders([
      mkOrder({ id: "a", integrationId: "int1", nativeStatus: "completed" }),
      mkOrder({ id: "b", integrationId: "int1", nativeStatus: "processing" }),
      mkOrder({ id: "c", integrationId: "int2", nativeStatus: "on-hold" }),
    ]);
    const res = await getOrderPipeline({ window: WINDOW, groupBy: "integration", companyIds: ["c1"] });

    expect(res.orders.map((r) => r.key)).toEqual(["int1", "int2"]);
    expect(res.orders.find((r) => r.key === "int1")?.orderCount).toBe(2);
    expect(res.coverage.nativeStatusByIntegration).toEqual({
      int1: { completed: 1, processing: 1 },
      int2: { "on-hold": 1 },
    });
    expect(res.coverage.platformStatusNote).toEqual(expect.stringMatching(/verbatim/i));
  });

  it("groupBy day groups by the timestamp dayKey", async () => {
    setOrders([
      mkOrder({ id: "a", externalCreatedAt: D("2026-07-05") }),
      mkOrder({ id: "b", externalCreatedAt: D("2026-07-05") }),
      mkOrder({ id: "c", externalCreatedAt: D("2026-07-09") }),
    ]);
    const res = await getOrderPipeline({ window: WINDOW, groupBy: "day", companyIds: ["c1"] });
    expect(res.orders).toEqual([
      { key: "2026-07-05", currency: "USD", orderCount: 2, totalCents: 20000 },
      { key: "2026-07-09", currency: "USD", orderCount: 1, totalCents: 10000 },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("company scope + query shape", () => {
  it("empty companyIds ⇒ empty result WITHOUT querying", async () => {
    const res = await getOrderPipeline({ window: WINDOW, groupBy: "status", companyIds: [] });

    expect(res.orders).toEqual([]);
    expect(res.items).toEqual([]);
    expect(res.aging).toEqual({ days0to7: 0, days8to30: 0, days31plus: 0 });
    expect(res.coverage.currencies).toEqual([]);
    expect(res.coverage.timestampFallbacks).toBe(0);
    expect(res.coverage.refundsNote).toBe("refunds are not netted");
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
    expect(db.externalOrderItem.findMany).not.toHaveBeenCalled();
  });

  it("scopes to companyIds and filters the window on the timestamp convention", async () => {
    setOrders([]);
    await getOrderPipeline({
      window: win("2026-07-01", "2026-07-31"),
      groupBy: "status",
      companyIds: ["c1", "c2"],
    });

    const where = db.externalOrder.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.companyId).toEqual({ in: ["c1", "c2"] });
    // In-window iff externalCreatedAt in range, OR (externalCreatedAt null AND createdAt in range).
    expect(where.OR).toEqual([
      {
        externalCreatedAt: {
          gte: new Date("2026-07-01T00:00:00.000Z"),
          lt: new Date("2026-08-01T00:00:00.000Z"), // exclusive upper: day AFTER `to`
        },
      },
      {
        AND: [
          { externalCreatedAt: null },
          {
            createdAt: {
              gte: new Date("2026-07-01T00:00:00.000Z"),
              lt: new Date("2026-08-01T00:00:00.000Z"),
            },
          },
        ],
      },
    ]);
  });

  it("does not query items when no orders fall in the window", async () => {
    setOrders([]);
    const res = await getOrderPipeline({ window: WINDOW, groupBy: "status", companyIds: ["c1"] });
    expect(res.items).toEqual([]);
    expect(db.externalOrderItem.findMany).not.toHaveBeenCalled();
  });

  it("echoes the resolved window and groupBy verbatim", async () => {
    setOrders([]);
    const res = await getOrderPipeline({ window: WINDOW, groupBy: "integration", companyIds: ["c1"] });
    expect(res.window).toBe(WINDOW);
    expect(res.groupBy).toBe("integration");
  });
});
