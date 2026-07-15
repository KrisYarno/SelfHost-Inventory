/**
 * @jest-environment node
 *
 * W3-TUNE (spec §5 T-TUNE REV-2, turn-budget residual R2-m1) — the page-SHRINK pin.
 *
 * The adapter threads the turn's remaining budget into each tool's run-ctx
 * (`remainingBytes = min(PER_TOOL_RESULT_CAP_BYTES, budget.remaining)`), and every
 * list tool byte-fits its page to `byteBudget(ctx) − ENVELOPE_RESERVE_BYTES`. So a
 * late-turn read with only a little budget left returns a SMALLER page (fewer rows +
 * a nextOffset) instead of being discarded whole as a truncation notice.
 *
 * This pins that behavior for get_stock_asof (the W2 seam-fix wired its envelope
 * reserve) AND one W1 list tool (get_inventory_summary). The module functions are
 * mocked to byte-fit their page to the budget they are handed — exactly as the real
 * DB-side paging does — so the assertions exercise the ADAPTER threading + the tool's
 * reserve, not a live database. Remove the ctx threading (page against the fixed
 * ROW budget) OR the envelope reserve, and a tight budget truncates instead → red.
 */

// `ai` (v7) is ESM-only; createAiTools only stores def+execute, never invokes ai's
// tool() body, so a passthrough is faithful (same stub the asof-error suite uses).
jest.mock("ai", () => ({ __esModule: true, tool: (def: unknown) => def }));

// The two module functions are mocked, so their prisma reads never run; a bare stub
// satisfies the tools.ts import graph.
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/analytics/stock-asof", () => ({ __esModule: true, getStockAsOf: jest.fn() }));
jest.mock("@/lib/reports/inventory-summary", () => ({ __esModule: true, getInventorySummary: jest.fn() }));

import { createAiTools } from "@/lib/assistant/tool-adapters";
import { getStockAsOf } from "@/lib/analytics/stock-asof";
import { getInventorySummary } from "@/lib/reports/inventory-summary";
import type { ToolContext as ResolvedContext } from "@/lib/assistant/context";

const asOfMock = getStockAsOf as jest.Mock;
const summaryMock = getInventorySummary as jest.Mock;

const CTX: ResolvedContext = {
  userId: 1,
  tokenId: null,
  surface: "web",
  companyIds: ["c1"],
} as unknown as ResolvedContext;

// A tight late-turn budget vs. a comfortable one. TIGHT still clears one small page;
// the point is that the completed page shrinks to fit instead of being discarded.
const TIGHT = 16_384;
const LARGE = 65_536;
const TOTAL = 3_000; // far more rows than either budget can hold => nextOffset always set

/** Mirror the real byte-fit paginate: add rows until the next would exceed byteBudget. */
function fitPage<T>(byteBudget: number, total: number, makeRow: (i: number) => T) {
  const rows: T[] = [];
  let bytes = 2; // "[]"
  for (let i = 0; i < total; i++) {
    const row = makeRow(i);
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1; // + comma
    if (rows.length > 0 && bytes + rowBytes > byteBudget) break;
    rows.push(row);
    bytes += rowBytes;
  }
  return { rows, returned: rows.length, totalRows: total, nextOffset: rows.length < total ? rows.length : null };
}

beforeEach(() => {
  asOfMock.mockReset();
  summaryMock.mockReset();
  asOfMock.mockImplementation(async (opts: { dayKey: string; byteBudget: number }) => {
    const page = fitPage(opts.byteBudget, TOTAL, (i) => ({
      productId: i,
      name: `Product ${i}`,
      units: i,
      seriesEndsAt: "2020-01-02",
      possiblyStale: false,
      pairsPresentOnDay: 1,
      knownPairs: 1,
    }));
    return {
      ...page,
      coverage: {
        dayKey: opts.dayKey,
        snapshotWatermark: "2020-01-02",
        snapshotDataStart: "2019-01-01",
        flaggedPairs: 0,
      },
    };
  });
  summaryMock.mockImplementation(async (opts: { byteBudget: number }) => {
    const ranked = fitPage(opts.byteBudget, TOTAL, (i) => ({ productId: i, name: `Product ${i}`, metric: i }));
    return {
      unitsOnHand: 12_345,
      productCount: TOTAL,
      stockStateCounts: { in_stock: 1_000, low: 1_000, out: 1_000 },
      valuation: { coverage: { costedProducts: 10, ofProducts: TOTAL } },
      ranked,
    };
  });
});

type ExecResult = {
  status: string;
  notice?: string;
  data?: { rows?: unknown[]; totalRows?: number; nextOffset?: number | null; ranked?: { rows: unknown[]; totalRows: number; nextOffset: number | null } };
};
type ExecTool = { execute: (args: unknown) => Promise<ExecResult> };

/** One isolated turn: a fresh tool set + fresh budget (so tight vs. large never share). */
function runOnce(name: string, args: unknown, remaining: number): Promise<ExecResult> {
  const set = createAiTools(CTX, { remaining }, jest.fn().mockResolvedValue(undefined) as never);
  return (set[name] as unknown as ExecTool).execute(args);
}

describe("createAiTools — a tight remainingBytes shrinks the page, never truncates (W3-TUNE)", () => {
  it("get_stock_asof: tight budget -> smaller page + nextOffset, status ok (no truncation notice)", async () => {
    const tight = await runOnce("get_stock_asof", { dayKey: "2020-01-01" }, TIGHT);
    const large = await runOnce("get_stock_asof", { dayKey: "2020-01-01" }, LARGE);

    // A completed, byte-fit page — NOT the turn-budget truncation notice.
    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.rows!.length).toBeLessThan(tight.data!.totalRows!);
    expect(tight.data!.nextOffset).not.toBeNull();
    // Genuinely SMALLER than a comfortable-budget read of the same data.
    expect(tight.data!.rows!.length).toBeLessThan(large.data!.rows!.length);
  });

  it("get_inventory_summary (W1 list tool): tight budget -> smaller ranked page + nextOffset, status ok", async () => {
    const tight = await runOnce("get_inventory_summary", { rankBy: "onHand" }, TIGHT);
    const large = await runOnce("get_inventory_summary", { rankBy: "onHand" }, LARGE);

    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.ranked!.rows.length).toBeLessThan(tight.data!.ranked!.totalRows);
    expect(tight.data!.ranked!.nextOffset).not.toBeNull();
    expect(tight.data!.ranked!.rows.length).toBeLessThan(large.data!.ranked!.rows.length);
  });

  it("the ctx budget is threaded through with the envelope reserve subtracted (both tools)", async () => {
    await runOnce("get_stock_asof", { dayKey: "2020-01-01" }, TIGHT);
    await runOnce("get_stock_asof", { dayKey: "2020-01-01" }, LARGE);
    const tightAsOf = asOfMock.mock.calls[0][0].byteBudget as number;
    const largeAsOf = asOfMock.mock.calls[1][0].byteBudget as number;
    // A tighter remaining reaches the module as a smaller page budget (threading)...
    expect(tightAsOf).toBeLessThan(largeAsOf);
    // ...and the module budget is BELOW the raw remaining (the envelope reserve).
    expect(tightAsOf).toBeLessThan(TIGHT);

    await runOnce("get_inventory_summary", { rankBy: "onHand" }, TIGHT);
    await runOnce("get_inventory_summary", { rankBy: "onHand" }, LARGE);
    const tightSum = summaryMock.mock.calls[0][0].byteBudget as number;
    const largeSum = summaryMock.mock.calls[1][0].byteBudget as number;
    expect(tightSum).toBeLessThan(largeSum);
    expect(tightSum).toBeLessThan(TIGHT);
  });
});
