/**
 * @jest-environment node
 *
 * W2 seam-fix item 4 — the TRI-TOOL ledger reconciliation. One shared ledger fixture
 * (SALE -10, ADJUSTMENT -4, SALE +3, STOCK_IN -2) is pushed through the three tools
 * that report "outbound", pinning their DOCUMENTED differences so drift breaks CI:
 *
 *   compare_periods(outbound_units) = 16   (|Σ delta| over PHYSICAL_OUTBOUND_WHERE)
 *   get_operations unitsOut         = 16   (SAME shared PHYSICAL_OUTBOUND_WHERE predicate)
 *   get_movement_series outbound    = 11   (sale + *Unclassified buckets, |Σ|)  + stockIn -2
 *
 * The 16-vs-11 gap is EXACTLY the two wrong-signed folds movement.ts makes to keep its
 * `net === Σ delta` invariant (both documented in compare-periods.ts + movement.ts):
 *   - STOCK_IN -2 (a receipt reversal): the SIGN-FIRST ledger predicate counts it as
 *     outbound (delta<0, non-transfer); movement folds it into the logType-keyed stockIn
 *     bucket instead → +2 of the gap.
 *   - SALE +3 (a return): the ledger predicate EXCLUDES it (delta>0); movement always
 *     routes SALE-logType rows to its outbound `sale` bucket, so +3 lands there and
 *     shrinks the outbound family magnitude → +3 of the gap.
 *   2 + 3 = 5, and 16 - 5 = 11.
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import type { ResolvedWindow } from "@/lib/assistant/window";

jest.mock("@/lib/prisma", () => {
  const { mockDeep } = require("jest-mock-extended");
  return { __esModule: true, default: mockDeep() };
});

import prisma from "@/lib/prisma";
import { getMovementSeries } from "@/lib/reports/movement";
import { comparePeriods } from "@/lib/reports/compare-periods";
import { isPhysicalOutboundRow, PHYSICAL_OUTBOUND_WHERE } from "@/lib/reports/metrics-contract";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const win = (from: string, to: string): ResolvedWindow => ({
  from,
  to,
  days: Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1,
  source: "explicit",
});

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

/** The ONE shared ledger fixture — every tool reads exactly these four rows. */
type Row = { delta: number; changeTime: Date; logType: string; reasonCode: string | null; productId: number };
const FIXTURE: Row[] = [
  { delta: -10, changeTime: at("2026-07-10"), logType: "SALE", reasonCode: null, productId: 1 },
  { delta: -4, changeTime: at("2026-07-10"), logType: "ADJUSTMENT", reasonCode: null, productId: 1 }, // unclassified
  { delta: 3, changeTime: at("2026-07-11"), logType: "SALE", reasonCode: null, productId: 1 }, // a return (wrong-signed)
  { delta: -2, changeTime: at("2026-07-11"), logType: "STOCK_IN", reasonCode: null, productId: 1 }, // receipt reversal
];

const WINDOW = win("2026-07-01", "2026-07-31");

beforeEach(() => mockReset(db));

describe("tri-tool ledger divergence (item 4) — one fixture, three documented outbound numbers", () => {
  it("get_movement_series: outbound family = 11, stockIn = -2, net = -13 (real classification)", async () => {
    db.inventory_logs.findMany.mockResolvedValue(FIXTURE as never);

    const res = await getMovementSeries({ window: WINDOW, grain: "day" });
    const t = res.totals;

    // The two wrong-signed folds land in their natural logType buckets.
    expect(t.sale).toBe(-7); // -10 + 3 (the return folds in)
    expect(t.adjustmentUnclassified).toBe(-4);
    expect(t.stockIn).toBe(-2); // the receipt reversal folds into stockIn, NOT outbound

    // Outbound family = sale + classifiedLoss + *Unclassified + countOut.
    const outboundFamily =
      t.sale + t.classifiedLoss + t.adjustmentUnclassified + t.correctionUnclassified + t.countOut;
    expect(outboundFamily).toBe(-11);
    expect(Math.abs(outboundFamily)).toBe(11);

    // The normative invariant still holds over the whole fixture.
    expect(t.net).toBe(-13); // -10 -4 +3 -2
  });

  it("the shared PHYSICAL_OUTBOUND_WHERE predicate = 16 — what BOTH compare_periods and get_operations surface", () => {
    // get_operations unitsOut and compare_periods(outbound_units) read the IDENTICAL
    // predicate constant (metrics-contract PHYSICAL_OUTBOUND_WHERE). Applying its JS twin
    // to the shared fixture pins the 16 both tools report; if the predicate changes, this
    // number drifts and CI breaks.
    const matched = FIXTURE.filter((r) => isPhysicalOutboundRow(r));
    const signed = matched.reduce((s, r) => s + r.delta, 0);
    expect(matched.map((r) => r.logType)).toEqual(["SALE", "ADJUSTMENT", "STOCK_IN"]); // +3 SALE excluded (delta>0)
    expect(Math.abs(signed)).toBe(16); // |-10 -4 -2|
  });

  it("compare_periods(outbound_units): the REAL tool surfaces a = 16 through PHYSICAL_OUTBOUND_WHERE", async () => {
    // The DB applies the predicate; over the mock we feed it the predicate-filtered sum
    // computed from the SAME fixture, and assert the tool (a) surfaces |sum| = 16 and
    // (b) actually queried with the shared PHYSICAL_OUTBOUND_WHERE constant.
    const outSigned = FIXTURE.filter((r) => isPhysicalOutboundRow(r)).reduce((s, r) => s + r.delta, 0);
    db.inventory_logs.aggregate
      .mockResolvedValueOnce({ _min: { changeTime: at("2026-01-01") } } as never) // dataStart
      .mockResolvedValueOnce({ _sum: { delta: outSigned } } as never) // periodA value
      .mockResolvedValueOnce({ _sum: { delta: outSigned } } as never); // periodB value

    const res = await comparePeriods({
      metric: "outbound_units",
      periodA: WINDOW,
      periodB: WINDOW,
      companyIds: [], // ledger metric ignores company scope
    });

    expect(res.a).toBe(16);
    expect(res.b).toBe(16);
    // Pin that the query used the shared outbound predicate (ties 16 to the real constant).
    const valueCallWhere = (db.inventory_logs.aggregate.mock.calls[1][0] as { where: Record<string, unknown> }).where;
    expect(valueCallWhere).toMatchObject(PHYSICAL_OUTBOUND_WHERE);
  });

  it("reconciliation: 16 (ledger outbound) = 11 (movement outbound family) + the two wrong-signed folds (2 + 3)", async () => {
    db.inventory_logs.findMany.mockResolvedValue(FIXTURE as never);
    const t = (await getMovementSeries({ window: WINDOW, grain: "day" })).totals;

    const ledgerOutbound = Math.abs(
      FIXTURE.filter((r) => isPhysicalOutboundRow(r)).reduce((s, r) => s + r.delta, 0),
    ); // 16
    const movementOutboundFamily = Math.abs(
      t.sale + t.classifiedLoss + t.adjustmentUnclassified + t.correctionUnclassified + t.countOut,
    ); // 11

    // STOCK_IN -2: outbound to the ledger predicate, but movement routes it to stockIn.
    const stockInFold = Math.abs(t.stockIn); // 2
    // SALE +3: excluded by the ledger predicate, but folded into movement's sale bucket.
    const saleReturnFold = 3;

    expect(ledgerOutbound).toBe(16);
    expect(movementOutboundFamily).toBe(11);
    expect(ledgerOutbound).toBe(movementOutboundFamily + stockInFold + saleReturnFold);
  });
});
