// @jest-environment node
//
// P2-B3-2 (contract pack § P2-B3-2, C2-8) — WHAT THE DIALOG'S COUNT ROW DOES
// DOWNSTREAM, pinned against the row the count arm ACTUALLY writes.
//
// The precedent is mass-update-count-stamp.test.ts: a stamp is one line, and
// the reason a file exists is the consequences. Before the Adjust stock
// dialog had a Count, an operator who found fewer units than the record removed
// the difference as a REASON-LESS ADJUSTMENT. The same event is now ONE row of
// `logType COUNT`, `reasonCode 'COUNT'`, signed delta, a batch id — and four
// readers treat that row differently:
//
//   the attribution population (lib/reconciliation/population)  -> OUT
//   the movement partition (lib/reports/movement)               -> countOut / countIn
//   reorder demand (lib/reports/metrics-contract)               -> STILL IN (unchanged)
//   get_shrinkage (lib/analytics/queries getShrinkageSummary)    -> OUT OF DOMAIN
//
// Each reader is the REAL module. The row comes from driving the REAL route,
// the REAL count core and the REAL `applyStockDelta` against a mocked
// transaction — so if the arm ever stopped stamping COUNT, these pins would see
// a different row, not keep passing against a hand-written fixture. Each pin
// also states the BEFORE reading (the same event as a reason-less ADJUSTMENT),
// because the disclosure strings promise exactly that difference.
import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireApproved: jest.fn(),
  requireCSRF: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  ...jest.requireActual("@/lib/rateLimit"),
  enforceRateLimit: jest.fn(() => ({})),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApproved, requireCSRF } from "@/lib/api-utils";
import { ATTRIBUTABLE_PREDICATE, rowWhere } from "@/lib/reconciliation/population";
import { getMovementSeries } from "@/lib/reports/movement";
import { isReorderDemandRow } from "@/lib/reports/metrics-contract";
import { getShrinkageSummary } from "@/lib/analytics/queries";
import type { ResolvedWindow } from "@/lib/assistant/window";
import { POST as ADJUST } from "@/app/api/inventory/adjust/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;

const PRODUCT_ID = 5;
const LOCATION_ID = 2;

type LedgerRow = {
  delta: number;
  logType: string;
  reasonCode: string | null;
  batchId: string | null;
};

/** A transaction that holds ONE row at `record`, with the delegates the count
 *  core and the stock primitive reach. */
function makeTx(record: { quantity: number; version: number }) {
  const tx = mockDeep<Prisma.TransactionClient>();
  tx.$executeRaw.mockResolvedValue(1 as never);
  tx.$queryRaw.mockResolvedValue([
    { productId: PRODUCT_ID, locationId: LOCATION_ID, ...record },
  ] as never);
  tx.inventory_logs.create.mockImplementation(
    (async (args: { data: Record<string, unknown> }) => ({ id: 777, ...args.data })) as never
  );
  tx.product_locations.upsert.mockResolvedValue({ version: record.version + 1 } as never);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as never);
  return tx;
}

/** Drive one count through the REAL arm; hand back the ledger row it wrote. */
async function countedRow(onShelfRecord: number, counted: number): Promise<LedgerRow> {
  const tx = makeTx({ quantity: onShelfRecord, version: 4 });
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
  const res = await ADJUST(
    new NextRequest("http://x/api/inventory/adjust", {
      method: "POST",
      body: JSON.stringify({
        productId: PRODUCT_ID,
        locationId: LOCATION_ID,
        intent: "count",
        countedQuantity: counted,
        expectedVersion: 4,
      }),
      headers: { "content-type": "application/json", "x-csrf-token": "x" },
    })
  );
  expect(res.status).toBe(200);
  expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
  const data = tx.inventory_logs.create.mock.calls[0][0].data as Record<string, unknown>;
  return {
    delta: data.delta as number,
    logType: String(data.logType),
    reasonCode: (data.reasonCode as string | null) ?? null,
    batchId: (data.batchId as string | null) ?? null,
  };
}

/** The same event as operators recorded it BEFORE the Count existed. */
function asReasonlessRemoval(row: LedgerRow): LedgerRow {
  return { ...row, logType: "ADJUSTMENT", reasonCode: null };
}

beforeEach(() => {
  mockReset(db);
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
  db.product.findFirst.mockResolvedValue({ name: "Widget" } as never);
  db.location.findUnique.mockResolvedValue({ name: "Main" } as never);
});

// ---------------------------------------------------------------------------
// The row itself
// ---------------------------------------------------------------------------

describe("the dialog's count row — what the arm writes", () => {
  it("a count below the record: ONE COUNT/COUNT row, signed negative, with a batch id", async () => {
    const row = await countedRow(10, 4);
    expect(row).toEqual({
      delta: -6,
      logType: "COUNT",
      reasonCode: "COUNT",
      batchId: expect.any(String),
    });
  });

  it("a count above the record: the same pair, signed positive", async () => {
    const row = await countedRow(4, 10);
    expect(row).toMatchObject({ delta: 6, logType: "COUNT", reasonCode: "COUNT" });
  });
});

// ---------------------------------------------------------------------------
// 1. The attribution population (SALE/ADJUSTMENT deducts with a batch id)
// ---------------------------------------------------------------------------

describe("consequence — the count leaves the attribution population", () => {
  it("a negative count row is OUTSIDE ATTRIBUTABLE_PREDICATE / rowWhere — on its logType alone", async () => {
    const row = await countedRow(10, 4);
    const where = rowWhere as { logType: { in: string[] }; delta: { lt: number } };

    expect(ATTRIBUTABLE_PREDICATE.logTypes).not.toContain(row.logType);
    expect(where.logType.in).not.toContain(row.logType);
    // Every OTHER conjunct would admit it: it took stock out and carries a batch.
    expect(row.delta).toBeLessThan(where.delta.lt);
    expect(row.batchId).not.toBeNull();
  });

  it("BEFORE: the same event as a reason-less removal was IN the population", async () => {
    const before = asReasonlessRemoval(await countedRow(10, 4));
    expect(ATTRIBUTABLE_PREDICATE.logTypes).toContain(before.logType);
    expect((rowWhere as { logType: { in: string[] } }).logType.in).toContain(before.logType);
  });
});

// ---------------------------------------------------------------------------
// 2. The movement partition (classify is module-private: drive getMovementSeries)
// ---------------------------------------------------------------------------

describe("consequence — the movement partition buckets the count as countOut / countIn", () => {
  const WINDOW: ResolvedWindow = { from: "2026-11-01", to: "2026-11-30", days: 30, source: "explicit" };

  async function seriesTotalsOf(row: LedgerRow) {
    db.inventory_logs.findMany.mockResolvedValue([
      {
        delta: row.delta,
        changeTime: new Date("2026-11-20T12:00:00.000Z"),
        logType: row.logType,
        reasonCode: row.reasonCode,
      },
    ] as never);
    const result = await getMovementSeries({ window: WINDOW, grain: "day", approvedIds: [PRODUCT_ID] });
    return result;
  }

  it("a negative count row -> countOut, and NOT adjustmentUnclassified / classifiedLoss", async () => {
    const row = await countedRow(10, 4);
    const { totals, coverage } = await seriesTotalsOf(row);
    expect(totals.countOut).toBe(-6);
    expect(totals.adjustmentUnclassified).toBe(0);
    expect(totals.classifiedLoss).toBe(0);
    // Not a reason-less outbound row, so no unclassified note rides with it.
    expect(coverage.reasonCodeNullRows).toBe(0);
  });

  it("a positive count row -> countIn, and NOT adjustmentIn", async () => {
    const row = await countedRow(4, 10);
    const { totals } = await seriesTotalsOf(row);
    expect(totals.countIn).toBe(6);
    expect(totals.adjustmentIn).toBe(0);
  });

  it("BEFORE: the same events as reason-less adjustments sat in adjustmentUnclassified / adjustmentIn", async () => {
    const down = await seriesTotalsOf(asReasonlessRemoval(await countedRow(10, 4)));
    expect(down.totals.adjustmentUnclassified).toBe(-6);
    expect(down.totals.countOut).toBe(0);
    const up = await seriesTotalsOf(asReasonlessRemoval(await countedRow(4, 10)));
    expect(up.totals.adjustmentIn).toBe(6);
    expect(up.totals.countIn).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Reorder demand — UNCHANGED
// ---------------------------------------------------------------------------

describe("consequence — reorder demand is unchanged", () => {
  it("a negative count row still satisfies the locked reorder-demand predicate", async () => {
    const row = await countedRow(10, 4);
    expect(isReorderDemandRow(row)).toBe(true);
    // ...exactly as the reason-less removal it replaces did.
    expect(isReorderDemandRow(asReasonlessRemoval(row))).toBe(true);
  });

  it("a positive count row is not demand (demand is delta < 0)", async () => {
    const row = await countedRow(4, 10);
    expect(isReorderDemandRow(row)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. get_shrinkage — out of its domain entirely
// ---------------------------------------------------------------------------

describe("consequence — the count row is outside getShrinkageSummary's domain", () => {
  /** The shrinkage read, answered QUERY-FAITHFULLY over a one-row ledger: the
   *  groupBy returns the row only when the read's own `where` admits it. */
  async function shrinkageOver(row: LedgerRow) {
    db.inventory_logs.groupBy.mockImplementation((async (args: {
      where: { logType: { in: string[] }; delta: { lt: number } };
    }) => {
      const admitted = args.where.logType.in.includes(row.logType) && row.delta < args.where.delta.lt;
      return admitted
        ? [{ productId: PRODUCT_ID, reasonCode: row.reasonCode, _sum: { delta: row.delta } }]
        : [];
    }) as never);
    db.inventory_logs.aggregate.mockResolvedValue({ _min: { changeTime: null } } as never);
    db.product.findMany.mockResolvedValue([] as never);
    const summary = await getShrinkageSummary({ days: 90 });
    const where = (db.inventory_logs.groupBy.mock.calls[0][0] as { where: { logType: { in: string[] } } })
      .where;
    return { summary, domain: where.logType.in };
  }

  it("the count row's logType is not in the read's domain: it lands in NEITHER unclassifiedOutboundUnits NOR byReason.COUNT", async () => {
    const row = await countedRow(10, 4);
    const { summary, domain } = await shrinkageOver(row);

    expect(domain).not.toContain(row.logType);
    expect(summary.coverage.unclassifiedOutboundUnits).toBe(0);
    expect(summary.byReason.COUNT.units).toBe(0);
    expect(summary.totalUnits).toBe(0);
  });

  it("BEFORE: the same event as a reason-less removal WAS unclassifiedOutboundUnits (the step down the disclosure names)", async () => {
    const before = asReasonlessRemoval(await countedRow(10, 4));
    const { summary, domain } = await shrinkageOver(before);

    expect(domain).toContain(before.logType);
    expect(summary.coverage.unclassifiedOutboundUnits).toBe(6);
    expect(summary.byReason.COUNT.units).toBe(0);
  });
});
