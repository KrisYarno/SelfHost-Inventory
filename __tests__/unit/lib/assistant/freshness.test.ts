/**
 * @jest-environment node
 *
 * Assistant toolsuite breadth — W1-FRESH: `lib/assistant/freshness.ts` data layer
 * for the `get_data_freshness` tool (spec §5 T-FRESH REV-2).
 *
 * Pins:
 *  - full report shape (rebuild / sales / fulfillmentSync / dataStarts / snapshots /
 *    notTracked) against a mocked prisma;
 *  - `fulfillmentSync.enabled` is ALWAYS null with the exact fixed reason, EVEN when
 *    the sync-state row is fresh (REV-2: enablement is not observable from row
 *    staleness — a fresh row must not flip this to true);
 *  - order-derived fields (`sales.unattributedOrders`, `dataStarts.ordersFirstSeen`)
 *    are CALLER-SCOPED: unattributedOrders is CONSUMED from `callerScopedSalesCoverage`
 *    (never a raw global count), and ordersFirstSeen queries only the caller's
 *    companyIds;
 *  - empty companyIds short-circuits the order-derived fields WITHOUT querying
 *    ExternalOrder at all;
 *  - a totally empty DB (no rebuild/sync rows, no ledger/snapshot/order rows) yields
 *    nulls/zeros, never throws;
 *  - the `notTracked` list content is pinned verbatim.
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    analyticsRebuildState: { findUnique: jest.fn() },
    // IN-WAVE FIX (W1-INT): fulfillmentSync now aggregates across ALL rows (two Woo
    // stores in prod) — the query is findMany, not findFirst.
    fulfillmentSyncState: { findMany: jest.fn() },
    inventory_logs: { aggregate: jest.fn() },
    productStockSnapshot: { aggregate: jest.fn() },
    externalOrder: { findFirst: jest.fn() },
  },
}));

jest.mock("@/lib/assistant/sales-coverage", () => ({
  __esModule: true,
  callerScopedSalesCoverage: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { inventory_logs_logType } from "@prisma/client";
import { callerScopedSalesCoverage } from "@/lib/assistant/sales-coverage";
import {
  getFreshness,
  FRESHNESS_NOT_TRACKED,
  FULFILLMENT_SYNC_NOT_OBSERVABLE_REASON,
} from "@/lib/assistant/freshness";

const mockRebuildFindUnique = prisma.analyticsRebuildState.findUnique as jest.Mock;
const mockSyncFindMany = prisma.fulfillmentSyncState.findMany as jest.Mock;
const mockLedgerAggregate = prisma.inventory_logs.aggregate as jest.Mock;
const mockSnapshotAggregate = prisma.productStockSnapshot.aggregate as jest.Mock;
const mockOrderFindFirst = prisma.externalOrder.findFirst as jest.Mock;
const mockCoverage = callerScopedSalesCoverage as jest.Mock;

const OUTBOUND_START = new Date("2026-01-01T00:00:00.000Z");
const SALE_START = new Date("2026-01-05T00:00:00.000Z");
const RECEIPT_START = new Date("2025-12-01T00:00:00.000Z");
const REBUILD_LAST_RUN = new Date("2026-07-14T03:00:00.000Z");
const REBUILD_WATERMARK = new Date("2026-07-14T02:00:00.000Z");
const SYNC_CURSOR = new Date("2026-07-13T12:00:00.000Z");

/** Branch inventory_logs.aggregate by its `where` shape: PHYSICAL_OUTBOUND_WHERE has
 *  an object logType ({not: "TRANSFER"}); SALE / STOCK_IN reads use a plain string. */
function wireLedgerAggregate() {
  mockLedgerAggregate.mockImplementation(async ({ where }: any) => {
    if (where?.logType && typeof where.logType === "object") {
      return { _min: { changeTime: OUTBOUND_START } };
    }
    if (where?.logType === inventory_logs_logType.SALE) {
      return { _min: { changeTime: SALE_START } };
    }
    if (where?.logType === inventory_logs_logType.STOCK_IN) {
      return { _min: { changeTime: RECEIPT_START } };
    }
    return { _min: { changeTime: null } };
  });
}

function wireEmptyLedgerAggregate() {
  mockLedgerAggregate.mockResolvedValue({ _min: { changeTime: null } });
}

/** Branch analyticsRebuildState.findUnique by job. */
function wireRebuildState(opts: {
  sales?: { lastRunAt: Date | null; sourceWatermark: Date | null } | null;
  snapshots?: { flaggedPairs: number } | null;
}) {
  mockRebuildFindUnique.mockImplementation(async ({ where }: any) => {
    if (where.job === "sales") return opts.sales ?? null;
    if (where.job === "snapshots") return opts.snapshots ?? null;
    return null;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getFreshness", () => {
  it("returns the full report shape on a populated mocked prisma", async () => {
    wireRebuildState({
      sales: { lastRunAt: REBUILD_LAST_RUN, sourceWatermark: REBUILD_WATERMARK },
      snapshots: { flaggedPairs: 3 },
    });
    mockSyncFindMany.mockResolvedValue([
      {
        cursorModifiedAt: SYNC_CURSOR,
        backfillComplete: true,
        backfillPage: null,
        backfillBefore: null,
      },
    ]);
    wireLedgerAggregate();
    mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: "2026-01-02" } });
    mockCoverage.mockResolvedValue({
      unattributedOrders: 7,
      bundleRevenue: "excluded — bundle components carry units only",
      lastRebuildAt: REBUILD_LAST_RUN.toISOString(),
    });
    mockOrderFindFirst
      .mockResolvedValueOnce({
        externalCreatedAt: new Date("2025-11-10T00:00:00.000Z"),
        createdAt: new Date("2025-11-11T00:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        externalCreatedAt: null,
        createdAt: new Date("2025-11-09T00:00:00.000Z"),
      });

    const report = await getFreshness(["company-1"]);

    expect(report).toEqual({
      rebuild: {
        lastRunAt: REBUILD_LAST_RUN.toISOString(),
        sourceWatermark: REBUILD_WATERMARK.toISOString(),
      },
      sales: { unattributedOrders: 7, scope: "caller-companies" },
      fulfillmentSync: {
        enabled: null,
        reason: FULFILLMENT_SYNC_NOT_OBSERVABLE_REASON,
        // IN-WAVE FIX: cursor/backfill carry the "(oldest of N integrations)" disclosure.
        cursor: `${SYNC_CURSOR.toISOString()} (oldest of 1 integration)`,
        backfill: "complete (oldest of 1 integration)",
      },
      dataStarts: {
        ledgerOutboundStart: OUTBOUND_START.toISOString(),
        ledgerSaleStart: SALE_START.toISOString(),
        ledgerReceiptStart: RECEIPT_START.toISOString(),
        snapshotStart: "2026-01-02",
        // MIN(externalCreatedAt ?? createdAt) across the two candidate rows:
        // 2025-11-10 (externalCreatedAt) vs 2025-11-09 (createdAt fallback) -> the latter wins.
        ordersFirstSeen: "2025-11-09T00:00:00.000Z",
      },
      snapshots: { flaggedPairs: 3, scope: "global" },
      notTracked: [...FRESHNESS_NOT_TRACKED],
    });
  });

  it("consumes callerScopedSalesCoverage for unattributedOrders and NEVER derives it from a raw rebuild-state field", async () => {
    wireRebuildState({ sales: null, snapshots: null });
    mockSyncFindMany.mockResolvedValue([]);
    wireEmptyLedgerAggregate();
    mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
    mockOrderFindFirst.mockResolvedValue(null);
    mockCoverage.mockResolvedValue({
      unattributedOrders: 42,
      bundleRevenue: "excluded — bundle components carry units only",
      lastRebuildAt: null,
    });

    const report = await getFreshness(["company-9"]);

    expect(mockCoverage).toHaveBeenCalledWith(["company-9"]);
    expect(report.sales.unattributedOrders).toBe(42);
    expect(report.sales.scope).toBe("caller-companies");
  });

  it("scopes dataStarts.ordersFirstSeen to the caller's companyIds", async () => {
    wireRebuildState({ sales: null, snapshots: null });
    mockSyncFindMany.mockResolvedValue([]);
    wireEmptyLedgerAggregate();
    mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
    mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });
    mockOrderFindFirst.mockResolvedValue(null);

    await getFreshness(["company-a", "company-b"]);

    expect(mockOrderFindFirst).toHaveBeenCalledTimes(2);
    for (const call of mockOrderFindFirst.mock.calls) {
      expect(call[0].where.companyId).toEqual({ in: ["company-a", "company-b"] });
    }
  });

  it("computes ordersFirstSeen's fallback as MIN(createdAt WHERE externalCreatedAt IS NULL), not MIN(createdAt) overall (item 5)", async () => {
    wireRebuildState({ sales: null, snapshots: null });
    mockSyncFindMany.mockResolvedValue([]);
    wireEmptyLedgerAggregate();
    mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
    mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

    // Candidate 1 (earliest non-null externalCreatedAt): a row whose createdAt is Jan1
    // but whose external order date is Feb1 — its TRUE contribution is Feb1. Candidate 2
    // must be the earliest createdAt among rows WITH NO external date (Jan2) -> Jan2.
    // The correct MIN(externalCreatedAt ?? createdAt) is Jan2. The OLD MIN(createdAt)
    // overall picks the Jan1 row, coalesces through its non-null externalCreatedAt back
    // to Feb1, and hides the earlier null-external row entirely.
    mockOrderFindFirst.mockImplementation(async ({ where }: { where: { externalCreatedAt?: unknown } }) => {
      if (where.externalCreatedAt && (where.externalCreatedAt as { not?: unknown }).not === null) {
        return {
          externalCreatedAt: new Date("2026-02-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
      }
      if (where.externalCreatedAt === null) {
        return { externalCreatedAt: null, createdAt: new Date("2026-01-02T00:00:00.000Z") };
      }
      throw new Error("second ordersFirstSeen candidate must filter externalCreatedAt IS NULL");
    });

    const report = await getFreshness(["company-1"]);
    expect(report.dataStarts.ordersFirstSeen).toBe("2026-01-02T00:00:00.000Z");
  });

  it("short-circuits order-derived fields for empty companyIds WITHOUT querying ExternalOrder", async () => {
    wireRebuildState({ sales: null, snapshots: null });
    mockSyncFindMany.mockResolvedValue([]);
    wireEmptyLedgerAggregate();
    mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
    mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

    const report = await getFreshness([]);

    expect(mockOrderFindFirst).not.toHaveBeenCalled();
    expect(mockCoverage).toHaveBeenCalledWith([]);
    expect(report.dataStarts.ordersFirstSeen).toBeNull();
    expect(report.sales.unattributedOrders).toBe(0);
    // Global fields still populate — only the order-derived fields short-circuit.
    expect(report.dataStarts.ledgerOutboundStart).toBeNull();
  });

  it("returns nulls (not a throw) when no rebuild/sync/ledger/snapshot/order rows exist anywhere", async () => {
    wireRebuildState({ sales: null, snapshots: null });
    mockSyncFindMany.mockResolvedValue([]);
    wireEmptyLedgerAggregate();
    mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
    mockOrderFindFirst.mockResolvedValue(null);
    mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

    const report = await getFreshness(["company-1"]);

    expect(report.rebuild).toEqual({ lastRunAt: null, sourceWatermark: null });
    expect(report.fulfillmentSync).toEqual({
      enabled: null,
      reason: FULFILLMENT_SYNC_NOT_OBSERVABLE_REASON,
      cursor: null,
      backfill: null,
    });
    expect(report.dataStarts).toEqual({
      ledgerOutboundStart: null,
      ledgerSaleStart: null,
      ledgerReceiptStart: null,
      snapshotStart: null,
      ordersFirstSeen: null,
    });
    expect(report.snapshots).toEqual({ flaggedPairs: 0, scope: "global" });
  });

  describe("fulfillmentSync.enabled (REV-2: never inferred from row staleness)", () => {
    it("is null with the fixed reason even for a FRESH sync-state row", async () => {
      wireRebuildState({ sales: null, snapshots: null });
      const now = new Date();
      mockSyncFindMany.mockResolvedValue([
        {
          cursorModifiedAt: now,
          backfillComplete: false,
          backfillPage: 12,
          backfillBefore: now,
        },
      ]);
      wireEmptyLedgerAggregate();
      mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
      mockOrderFindFirst.mockResolvedValue(null);
      mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

      const report = await getFreshness(["company-1"]);

      expect(report.fulfillmentSync.enabled).toBeNull();
      expect(report.fulfillmentSync.reason).toBe(FULFILLMENT_SYNC_NOT_OBSERVABLE_REASON);
      // Recency of the row must not leak into "enabled" — only cursor/backfill relay it.
      expect(report.fulfillmentSync.cursor).toBe(`${now.toISOString()} (oldest of 1 integration)`);
    });

    it("is null with the same reason for a stale/absent sync-state row", async () => {
      wireRebuildState({ sales: null, snapshots: null });
      mockSyncFindMany.mockResolvedValue([]);
      wireEmptyLedgerAggregate();
      mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
      mockOrderFindFirst.mockResolvedValue(null);
      mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

      const report = await getFreshness(["company-1"]);

      expect(report.fulfillmentSync.enabled).toBeNull();
      expect(report.fulfillmentSync.reason).toBe(FULFILLMENT_SYNC_NOT_OBSERVABLE_REASON);
    });
  });

  describe("fulfillmentSync.backfill summarization", () => {
    const base = { cursorModifiedAt: null as Date | null };

    it("reads 'not started' when the row exists but backfill never began", async () => {
      wireRebuildState({ sales: null, snapshots: null });
      mockSyncFindMany.mockResolvedValue([
        {
          ...base,
          backfillComplete: false,
          backfillPage: null,
          backfillBefore: null,
        },
      ]);
      wireEmptyLedgerAggregate();
      mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
      mockOrderFindFirst.mockResolvedValue(null);
      mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

      const report = await getFreshness(["company-1"]);
      expect(report.fulfillmentSync.backfill).toBe("not started (oldest of 1 integration)");
    });

    it("reads an in-progress page/before summary", async () => {
      wireRebuildState({ sales: null, snapshots: null });
      const before = new Date("2026-06-01T00:00:00.000Z");
      mockSyncFindMany.mockResolvedValue([
        {
          ...base,
          backfillComplete: false,
          backfillPage: 5,
          backfillBefore: before,
        },
      ]);
      wireEmptyLedgerAggregate();
      mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
      mockOrderFindFirst.mockResolvedValue(null);
      mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

      const report = await getFreshness(["company-1"]);
      expect(report.fulfillmentSync.backfill).toBe(
        `in progress — page 5, before ${before.toISOString()} (oldest of 1 integration)`,
      );
    });

    it("aggregates TWO integrations: oldest cursor + least-progressed backfill + count disclosed", async () => {
      wireRebuildState({ sales: null, snapshots: null });
      const older = new Date("2026-06-01T00:00:00.000Z");
      const newer = new Date("2026-07-10T00:00:00.000Z");
      // Store A is fully backfilled and fresh; store B lags (older cursor, still
      // in progress). The aggregate must report B's older cursor and B's backfill
      // floor — never A's rosier numbers.
      mockSyncFindMany.mockResolvedValue([
        { cursorModifiedAt: newer, backfillComplete: true, backfillPage: null, backfillBefore: null },
        { cursorModifiedAt: older, backfillComplete: false, backfillPage: 3, backfillBefore: older },
      ]);
      wireEmptyLedgerAggregate();
      mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
      mockOrderFindFirst.mockResolvedValue(null);
      mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

      const report = await getFreshness(["company-1"]);
      expect(report.fulfillmentSync.cursor).toBe(`${older.toISOString()} (oldest of 2 integrations)`);
      expect(report.fulfillmentSync.backfill).toBe(
        `in progress — page 3, before ${older.toISOString()} (oldest of 2 integrations)`,
      );
      expect(report.fulfillmentSync.enabled).toBeNull();
    });

    it("does NOT hide a never-cursored store behind a fresh one — cursor discloses the null (item 2a)", async () => {
      wireRebuildState({ sales: null, snapshots: null });
      const fresh = new Date("2026-07-14T00:00:00.000Z");
      // Store A has a fresh cursor; store B has NEVER cursored (null). Filtering the null
      // out and taking min would report A's fresh cursor as "the" freshness floor,
      // silently hiding a store that has never synced.
      mockSyncFindMany.mockResolvedValue([
        { cursorModifiedAt: fresh, backfillComplete: true, backfillPage: null, backfillBefore: null },
        { cursorModifiedAt: null, backfillComplete: true, backfillPage: null, backfillBefore: null },
      ]);
      wireEmptyLedgerAggregate();
      mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
      mockOrderFindFirst.mockResolvedValue(null);
      mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

      const report = await getFreshness(["company-1"]);
      // The fresh ISO date must NOT be presented as the freshness floor.
      expect(report.fulfillmentSync.cursor).not.toContain(fresh.toISOString());
      // It discloses HOW MANY stores have no cursor yet.
      expect(report.fulfillmentSync.cursor).toContain("1 of 2 integrations have no cursor yet");
      expect(report.fulfillmentSync.enabled).toBeNull();
    });

    it("breaks a backfill tie between two in-progress stores by LOWEST page, deterministic — not arbitrary row order (item 2b)", async () => {
      wireRebuildState({ sales: null, snapshots: null });
      const before = new Date("2026-06-01T00:00:00.000Z");
      const c1 = new Date("2026-07-01T00:00:00.000Z");
      const c2 = new Date("2026-07-02T00:00:00.000Z");
      // Two in-progress stores (same backfillRank). Least-progressed = LOWEST page (2)
      // must set the floor even though it is SECOND in the array — the OLD `<=` reduce
      // kept the first row (page 5) arbitrarily.
      const storeHighPage = { cursorModifiedAt: c1, backfillComplete: false, backfillPage: 5, backfillBefore: before };
      const storeLowPage = { cursorModifiedAt: c2, backfillComplete: false, backfillPage: 2, backfillBefore: before };
      mockSyncFindMany.mockResolvedValue([storeHighPage, storeLowPage]);
      wireEmptyLedgerAggregate();
      mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
      mockOrderFindFirst.mockResolvedValue(null);
      mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

      const report = await getFreshness(["company-1"]);
      expect(report.fulfillmentSync.backfill).toBe(
        `in progress — page 2, before ${before.toISOString()} (oldest of 2 integrations)`,
      );
    });

    it("is null (not 'not started') when there is no sync-state row at all", async () => {
      wireRebuildState({ sales: null, snapshots: null });
      mockSyncFindMany.mockResolvedValue([]);
      wireEmptyLedgerAggregate();
      mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
      mockOrderFindFirst.mockResolvedValue(null);
      mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

      const report = await getFreshness(["company-1"]);
      expect(report.fulfillmentSync.backfill).toBeNull();
      expect(report.fulfillmentSync.cursor).toBeNull();
    });
  });

  it("pins the notTracked list content verbatim", async () => {
    wireRebuildState({ sales: null, snapshots: null });
    mockSyncFindMany.mockResolvedValue([]);
    wireEmptyLedgerAggregate();
    mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
    mockOrderFindFirst.mockResolvedValue(null);
    mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

    const report = await getFreshness(["company-1"]);

    expect(report.notTracked).toEqual([
      "fulfillment quantities (recorded in WooCommerce)",
      "purchase orders / on-order quantities",
      "supplier data",
      "lot / expiry tracking",
      "historical cost, retail, and policy values (only current values are stored)",
      "movement-by-actor breakdowns",
    ]);
  });

  it("labels dataStarts.snapshots.flaggedPairs from the 'snapshots' rebuild job, distinct from the 'sales' job", async () => {
    wireRebuildState({
      sales: { lastRunAt: REBUILD_LAST_RUN, sourceWatermark: null },
      snapshots: { flaggedPairs: 11 },
    });
    mockSyncFindMany.mockResolvedValue([]);
    wireEmptyLedgerAggregate();
    mockSnapshotAggregate.mockResolvedValue({ _min: { dayKey: null } });
    mockOrderFindFirst.mockResolvedValue(null);
    mockCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "x", lastRebuildAt: null });

    const report = await getFreshness(["company-1"]);

    expect(report.rebuild.lastRunAt).toBe(REBUILD_LAST_RUN.toISOString());
    expect(report.snapshots.flaggedPairs).toBe(11);
  });
});
