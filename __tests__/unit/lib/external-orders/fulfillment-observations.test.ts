/**
 * @jest-environment node
 */

/**
 * Lane 6 (L-WOO) — the read-only WooCommerce fulfillment observation feed.
 *
 * Every read goes through the egress `platformRead` boundary, which is mocked
 * here (it is the egress seam). The module NEVER imports fetch — a source
 * assertion at the bottom pins that, alongside the global network interceptor.
 */

import { readFileSync } from "fs";
import path from "path";

import { mockDeep, mockReset } from "jest-mock-extended";

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: mockDeep(),
}));

const mockPlatformRead = jest.fn();
jest.mock("@/lib/platforms/egress", () => ({
  __esModule: true,
  platformRead: (...args: unknown[]) => mockPlatformRead(...args),
}));

import prisma from "@/lib/prisma";
import {
  refundPosture,
  deriveObservations,
  resolveMappings,
  applyObservations,
  syncFulfillmentObservations,
  backfillFulfillmentObservations,
  reconcileFulfillmentTombstones,
  getUnitsOnCompletedOrders,
  persistFulfillmentHint,
  processFulfillmentHints,
  parseWooGmt,
  type WooOrder,
} from "@/lib/external-orders/fulfillment-observations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep prisma mock (repo convention, see stock-sync.test.ts)
const db = prisma as any;
const INT = "int-1";

// ---------------------------------------------------------------------------
// Fake Woo Response (no network, re-readable)
// ---------------------------------------------------------------------------

function wooResponse(
  data: unknown,
  opts: { status?: number; totalPages?: number; retryAfter?: number } = {}
): Response {
  const status = opts.status ?? 200;
  const headers = new Map<string, string>();
  if (opts.totalPages !== undefined) headers.set("x-wp-totalpages", String(opts.totalPages));
  if (opts.retryAfter !== undefined) headers.set("retry-after", String(opts.retryAfter));
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof data === "string" ? JSON.parse(text) : data),
    text: async () => text,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
  } as unknown as Response;
}

function order(overrides: Partial<WooOrder> = {}): WooOrder {
  return {
    id: 100,
    status: "completed",
    date_completed_gmt: "2026-07-14T10:00:00",
    date_modified_gmt: "2026-07-14T10:00:00",
    date_created_gmt: "2026-07-13T09:00:00",
    line_items: [{ id: 1, product_id: 55, quantity: 3, name: "Widget" }],
    refunds: [],
    ...overrides,
  };
}

/** Sane defaults so a test only overrides what it exercises. */
function setupDefaults(): void {
  db.fulfillmentSyncState.upsert.mockResolvedValue({} as never);
  db.fulfillmentSyncState.updateMany.mockResolvedValue({ count: 1 } as never);
  db.fulfillmentSyncState.findUnique.mockResolvedValue(null as never);
  db.fulfillmentSyncState.update.mockResolvedValue({} as never);
  db.fulfillmentObservation.findUnique.mockResolvedValue(null as never);
  db.fulfillmentObservation.upsert.mockResolvedValue({} as never);
  db.fulfillmentObservation.findMany.mockResolvedValue([] as never);
  db.fulfillmentObservation.updateMany.mockResolvedValue({ count: 0 } as never);
  db.fulfillmentObservation.aggregate.mockResolvedValue({
    _sum: { unitsOnCompletedOrder: 0 },
  } as never);
  db.fulfillmentObservationHint.findMany.mockResolvedValue([] as never);
  db.fulfillmentObservationHint.upsert.mockResolvedValue({} as never);
  db.fulfillmentObservationHint.update.mockResolvedValue({} as never);
  db.productLink.findMany.mockResolvedValue([] as never);
  db.bundleComponent.findMany.mockResolvedValue([] as never);
}

beforeEach(() => {
  mockReset(db);
  mockPlatformRead.mockReset();
  setupDefaults();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Refund posture (REV-2 #26) — order-level records + status, NEVER per-line qty
// ---------------------------------------------------------------------------

describe("refundPosture", () => {
  it("full refund: status refunded => isFullyRefunded, not partial", () => {
    expect(refundPosture(order({ status: "refunded", refunds: [{ total: "-30.00" }] }))).toEqual({
      isFullyRefunded: true,
      hasPartialRefund: false,
    });
  });

  it("partial refund: a non-zero refund record on a non-refunded order", () => {
    expect(
      refundPosture(order({ status: "completed", refunds: [{ total: "-10.00" }] }))
    ).toEqual({ isFullyRefunded: false, hasPartialRefund: true });
  });

  it("zero-value refund record does NOT flag a partial refund (buggy per-item case)", () => {
    expect(
      refundPosture(order({ status: "completed", refunds: [{ total: "0.00" }] }))
    ).toEqual({ isFullyRefunded: false, hasPartialRefund: false });
  });

  it("no refunds => neither flag", () => {
    expect(refundPosture(order({ status: "completed", refunds: [] }))).toEqual({
      isFullyRefunded: false,
      hasPartialRefund: false,
    });
  });

  it("post-completion partial refund still flags partial (records + status)", () => {
    // A refund created after completion appears as an order-level record; the
    // order is still `completed`, so it is a partial refund.
    expect(
      refundPosture(order({ status: "completed", refunds: [{ total: "-5.00" }, { total: "-2.50" }] }))
    ).toEqual({ isFullyRefunded: false, hasPartialRefund: true });
  });
});

// ---------------------------------------------------------------------------
// parseWooGmt — GMT field, no tz suffix => UTC
// ---------------------------------------------------------------------------

describe("parseWooGmt", () => {
  it("treats a suffix-less Woo GMT string as UTC", () => {
    expect(parseWooGmt("2026-07-14T10:00:00")?.toISOString()).toBe("2026-07-14T10:00:00.000Z");
  });
  it("respects an explicit Z", () => {
    expect(parseWooGmt("2026-07-14T10:00:00Z")?.toISOString()).toBe("2026-07-14T10:00:00.000Z");
  });
  it("null/empty => null", () => {
    expect(parseWooGmt(null)).toBeNull();
    expect(parseWooGmt("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveObservations — line-item grain, mapping coverage, bundle expansion,
// completed-only units, GMT completedAt, metric naming
// ---------------------------------------------------------------------------

describe("deriveObservations (line-item grain)", () => {
  it("maps a simple line to its internal product; units = qty on a completed order", () => {
    const mappings = new Map([
      ["55::", { productId: 7, isBundle: false, components: [] }],
    ]);
    const rows = deriveObservations(order(), mappings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalOrderId: "100",
      externalItemId: "1",
      productId: 7,
      unitsOnCompletedOrder: 3,
      orderStatus: "completed",
    });
    expect(rows[0].completedAt?.toISOString()).toBe("2026-07-14T10:00:00.000Z");
    expect(rows[0].sourceModifiedAt.toISOString()).toBe("2026-07-14T10:00:00.000Z");
  });

  it("unmapped line => productId null (coverage, NOT zero units silently)", () => {
    const rows = deriveObservations(order(), new Map());
    expect(rows[0].productId).toBeNull();
    expect(rows[0].unitsOnCompletedOrder).toBe(3); // still on a completed order
  });

  it("mapped-but-unlinked (internalProductId null) => productId null", () => {
    const mappings = new Map([
      ["55::", { productId: null, isBundle: false, components: [] }],
    ]);
    expect(deriveObservations(order(), mappings)[0].productId).toBeNull();
  });

  it("bundle line expands into one FROZEN row per component (units = lineQty * compQty)", () => {
    const mappings = new Map([
      [
        "55::",
        {
          productId: null,
          isBundle: true,
          components: [
            { internalProductId: 11, quantity: 2 },
            { internalProductId: 22, quantity: 5 },
          ],
        },
      ],
    ]);
    const rows = deriveObservations(order({ line_items: [{ id: 9, product_id: 55, quantity: 3 }] }), mappings);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.externalItemId, r.productId, r.unitsOnCompletedOrder])).toEqual([
      ["9:c:11", 11, 6],
      ["9:c:22", 22, 15],
    ]);
  });

  it("a non-completed order contributes ZERO units (but is still observed)", () => {
    const mappings = new Map([["55::", { productId: 7, isBundle: false, components: [] }]]);
    const rows = deriveObservations(order({ status: "processing" }), mappings);
    expect(rows[0].unitsOnCompletedOrder).toBe(0);
    expect(rows[0].orderStatus).toBe("processing");
  });

  it("a fully-refunded order contributes ZERO units and flags isFullyRefunded", () => {
    const mappings = new Map([["55::", { productId: 7, isBundle: false, components: [] }]]);
    const rows = deriveObservations(
      order({ status: "refunded", refunds: [{ total: "-30.00" }] }),
      mappings
    );
    expect(rows[0].unitsOnCompletedOrder).toBe(0);
    expect(rows[0].isFullyRefunded).toBe(true);
  });

  it("a partially-refunded completed order keeps FULL units and flags hasPartialRefund", () => {
    const mappings = new Map([["55::", { productId: 7, isBundle: false, components: [] }]]);
    const rows = deriveObservations(
      order({ status: "completed", refunds: [{ total: "-10.00" }] }),
      mappings
    );
    expect(rows[0].unitsOnCompletedOrder).toBe(3); // never netted per-unit
    expect(rows[0].hasPartialRefund).toBe(true);
  });

  it("resolves a variation via the (product, variation) key", () => {
    const mappings = new Map([["55::88", { productId: 42, isBundle: false, components: [] }]]);
    const rows = deriveObservations(
      order({ line_items: [{ id: 1, product_id: 55, variation_id: 88, quantity: 2 }] }),
      mappings
    );
    expect(rows[0].productId).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// resolveMappings — product_links + frozen bundle components
// ---------------------------------------------------------------------------

describe("resolveMappings", () => {
  it("builds a map keyed by (product, variation), freezing bundle components", async () => {
    db.productLink.findMany.mockResolvedValue([
      { id: "l1", externalProductId: "55", externalVariantId: null, internalProductId: 7, isBundle: false },
      { id: "l2", externalProductId: "60", externalVariantId: null, internalProductId: null, isBundle: true },
    ] as never);
    db.bundleComponent.findMany.mockResolvedValue([
      { productLinkId: "l2", internalProductId: 11, quantity: 2 },
    ] as never);

    const map = await resolveMappings(INT, [
      order({ line_items: [
        { id: 1, product_id: 55, quantity: 1 },
        { id: 2, product_id: 60, quantity: 1 },
      ] }),
    ]);

    expect(map.get("55::")).toEqual({ productId: 7, isBundle: false, components: [] });
    expect(map.get("60::")).toEqual({
      productId: null,
      isBundle: true,
      components: [{ internalProductId: 11, quantity: 2 }],
    });
    // Only bundle links trigger a component query.
    expect(db.bundleComponent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productLinkId: { in: ["l2"] } } })
    );
  });

  it("no line items => no queries", async () => {
    const map = await resolveMappings(INT, [order({ line_items: [] })]);
    expect(map.size).toBe(0);
    expect(db.productLink.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// applyObservations — the WATERMARK rule (REV-2 #21)
// ---------------------------------------------------------------------------

describe("applyObservations (watermark rule)", () => {
  const derived = [
    {
      externalOrderId: "100",
      externalItemId: "1",
      productId: 7,
      unitsOnCompletedOrder: 3,
      orderStatus: "completed",
      completedAt: new Date("2026-07-14T10:00:00Z"),
      sourceModifiedAt: new Date("2026-07-14T10:00:00Z"),
      hasPartialRefund: false,
      isFullyRefunded: false,
    },
  ];

  it("applies when there is no existing observation", async () => {
    db.fulfillmentObservation.findUnique.mockResolvedValue(null as never);
    const res = await applyObservations(INT, derived);
    expect(res).toEqual({ applied: 1, skippedStale: 0 });
    expect(db.fulfillmentObservation.upsert).toHaveBeenCalledTimes(1);
  });

  it("applies when the incoming watermark is STRICTLY NEWER than stored", async () => {
    db.fulfillmentObservation.findUnique.mockResolvedValue({
      sourceModifiedAt: new Date("2026-07-14T09:00:00Z"),
    } as never);
    const res = await applyObservations(INT, derived);
    expect(res.applied).toBe(1);
    expect(db.fulfillmentObservation.upsert).toHaveBeenCalledTimes(1);
  });

  it("SKIPS an out-of-order arrival (older watermark) — newer state left intact", async () => {
    db.fulfillmentObservation.findUnique.mockResolvedValue({
      sourceModifiedAt: new Date("2026-07-14T11:00:00Z"),
    } as never);
    const res = await applyObservations(INT, derived);
    expect(res).toEqual({ applied: 0, skippedStale: 1 });
    expect(db.fulfillmentObservation.upsert).not.toHaveBeenCalled();
  });

  it("SKIPS an equal watermark (idempotent re-observation)", async () => {
    db.fulfillmentObservation.findUnique.mockResolvedValue({
      sourceModifiedAt: new Date("2026-07-14T10:00:00Z"),
    } as never);
    const res = await applyObservations(INT, derived);
    expect(res.skippedStale).toBe(1);
    expect(db.fulfillmentObservation.upsert).not.toHaveBeenCalled();
  });

  it("clears any tombstone on apply (a restored order comes back into totals)", async () => {
    db.fulfillmentObservation.findUnique.mockResolvedValue(null as never);
    await applyObservations(INT, derived);
    const call = db.fulfillmentObservation.upsert.mock.calls[0][0] as {
      create: { tombstonedAt: unknown };
      update: { tombstonedAt: unknown };
    };
    expect(call.create.tombstonedAt).toBeNull();
    expect(call.update.tombstonedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Incremental sync — frozen upper watermark, exhaust pages, cursor advance rule
// ---------------------------------------------------------------------------

describe("syncFulfillmentObservations (cursor)", () => {
  const NOW = new Date("2026-07-14T12:00:00Z");

  it("freezes modified_before=now, queries from cursor - 15min overlap", async () => {
    const cursor = new Date("2026-07-14T11:00:00Z");
    db.fulfillmentSyncState.findUnique.mockResolvedValue({ cursorModifiedAt: cursor } as never);
    mockPlatformRead.mockResolvedValue(wooResponse([], { totalPages: 1 }));

    await syncFulfillmentObservations(INT, { now: NOW });

    const q = mockPlatformRead.mock.calls[0][2] as Record<string, string>;
    expect(q.modified_before).toBe(NOW.toISOString());
    expect(q.modified_after).toBe(new Date(cursor.getTime() - 15 * 60 * 1000).toISOString());
    expect(q.dates_are_gmt).toBe("true");
    expect(q.status).toBe("any");
  });

  it("an order modified exactly at the cursor boundary is inside the overlap window", async () => {
    const cursor = new Date("2026-07-14T11:00:00Z");
    db.fulfillmentSyncState.findUnique.mockResolvedValue({ cursorModifiedAt: cursor } as never);
    const boundaryOrder = order({ id: 200, date_modified_gmt: "2026-07-14T11:00:00" });
    mockPlatformRead.mockResolvedValue(wooResponse([boundaryOrder], { totalPages: 1 }));

    const res = await syncFulfillmentObservations(INT, { now: NOW });
    const since = new Date(mockPlatformRead.mock.calls[0][2].modified_after);
    // modified_after is exclusive; the overlap places the boundary strictly after `since`.
    expect(since.getTime()).toBeLessThan(cursor.getTime());
    expect(res.applied).toBe(1);
  });

  it("exhausts ALL pages (X-WP-TotalPages) before advancing the cursor", async () => {
    db.fulfillmentSyncState.findUnique.mockResolvedValue({ cursorModifiedAt: null } as never);
    mockPlatformRead.mockImplementation(async (_id, _path, q) => {
      const page = Number((q as Record<string, string>).page);
      return wooResponse([order({ id: 300 + page })], { totalPages: 3 });
    });

    const res = await syncFulfillmentObservations(INT, { now: NOW });
    expect(res.pages).toBe(3);
    expect(mockPlatformRead).toHaveBeenCalledTimes(3);
    // Cursor advanced to the frozen upper watermark, once, after all pages.
    const advance = db.fulfillmentSyncState.update.mock.calls.find(
      (c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.cursorModifiedAt !== undefined
    );
    expect((advance?.[0] as { data: { cursorModifiedAt: Date } }).data.cursorModifiedAt).toEqual(NOW);
  });

  it("a mid-run page failure retains the cursor (never advances on error)", async () => {
    db.fulfillmentSyncState.findUnique.mockResolvedValue({ cursorModifiedAt: null } as never);
    mockPlatformRead.mockImplementation(async (_id, _path, q) => {
      const page = Number((q as Record<string, string>).page);
      if (page === 1) return wooResponse([order({ id: 1 })], { totalPages: 2 });
      return wooResponse("boom", { status: 500, totalPages: 2 });
    });

    await expect(syncFulfillmentObservations(INT, { now: NOW })).rejects.toThrow();

    const advanced = db.fulfillmentSyncState.update.mock.calls.some(
      (c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.cursorModifiedAt !== undefined
    );
    expect(advanced).toBe(false);
  });

  it("skips when another run holds the lease", async () => {
    db.fulfillmentSyncState.updateMany.mockResolvedValue({ count: 0 } as never); // acquire fails
    const res = await syncFulfillmentObservations(INT, { now: NOW });
    expect(res.skipped).toBe("lock-held");
    expect(mockPlatformRead).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Backfill — resumable, Retry-After-aware, crash-safe (REV-2 #28)
// ---------------------------------------------------------------------------

describe("backfillFulfillmentObservations", () => {
  const NOW = new Date("2026-07-14T12:00:00Z");

  it("resumes at the saved page after a crash, without re-fetching earlier pages", async () => {
    const frozen = new Date("2026-07-14T00:00:00Z");
    db.fulfillmentSyncState.findUnique.mockResolvedValue({
      backfillPage: 2,
      backfillBefore: frozen,
      backfillComplete: false,
    } as never);
    mockPlatformRead.mockImplementation(async (_id, _path, q) => {
      const page = Number((q as Record<string, string>).page);
      return wooResponse([order({ id: 500 + page })], { totalPages: 3 });
    });

    await backfillFulfillmentObservations(INT, { now: NOW, maxPages: 1 });

    // First (and only, maxPages=1) request resumes at the SAVED page 2.
    expect(mockPlatformRead.mock.calls[0][2].page).toBe("2");
    // The frozen `before` bound is reused, not re-frozen.
    expect(mockPlatformRead.mock.calls[0][2].before).toBe(frozen.toISOString());
  });

  it("freezes the `before` bound on first start and paginates completed orders asc", async () => {
    db.fulfillmentSyncState.findUnique.mockResolvedValue(null as never); // fresh
    mockPlatformRead.mockResolvedValue(wooResponse([order()], { totalPages: 1 }));

    await backfillFulfillmentObservations(INT, { now: NOW });

    const q = mockPlatformRead.mock.calls[0][2] as Record<string, string>;
    expect(q.status).toBe("completed");
    expect(q.orderby).toBe("date");
    expect(q.order).toBe("asc");
    expect(q.before).toBe(NOW.toISOString());
    // The frozen bound was persisted.
    const froze = db.fulfillmentSyncState.update.mock.calls.some(
      (c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.backfillBefore !== undefined
    );
    expect(froze).toBe(true);
  });

  it("marks the backfill complete when the last page is exhausted", async () => {
    db.fulfillmentSyncState.findUnique.mockResolvedValue({
      backfillPage: 1,
      backfillBefore: NOW,
      backfillComplete: false,
    } as never);
    mockPlatformRead.mockResolvedValue(wooResponse([order()], { totalPages: 1 }));

    const res = await backfillFulfillmentObservations(INT, { now: NOW });
    expect(res.done).toBe(true);
    const completed = db.fulfillmentSyncState.update.mock.calls.some(
      (c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.backfillComplete === true
    );
    expect(completed).toBe(true);
  });

  it("retries a 429 (Retry-After aware) then succeeds", async () => {
    db.fulfillmentSyncState.findUnique.mockResolvedValue({
      backfillPage: 1,
      backfillBefore: NOW,
      backfillComplete: false,
    } as never);
    let calls = 0;
    mockPlatformRead.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return wooResponse({ code: "rate_limited" }, { status: 429, retryAfter: 0, totalPages: 1 });
      return wooResponse([order()], { totalPages: 1 });
    });

    const res = await backfillFulfillmentObservations(INT, { now: NOW });
    expect(calls).toBe(2);
    expect(res.done).toBe(true);
  });

  it("a non-retryable transport error retains the resume state (no completion)", async () => {
    db.fulfillmentSyncState.findUnique.mockResolvedValue({
      backfillPage: 2,
      backfillBefore: NOW,
      backfillComplete: false,
    } as never);
    mockPlatformRead.mockRejectedValue(new Error("network blip"));

    await expect(backfillFulfillmentObservations(INT, { now: NOW })).rejects.toThrow();
    // backfillComplete was never set true.
    const completed = db.fulfillmentSyncState.update.mock.calls.some(
      (c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.backfillComplete === true
    );
    expect(completed).toBe(false);
  });

  it("skips when the lease is held", async () => {
    db.fulfillmentSyncState.updateMany.mockResolvedValue({ count: 0 } as never);
    const res = await backfillFulfillmentObservations(INT, { now: NOW });
    expect(res.skipped).toBe("lock-held");
  });
});

// ---------------------------------------------------------------------------
// Tombstones (REV-2 #24) — poll trash + seen-set reconciliation
// ---------------------------------------------------------------------------

describe("reconcileFulfillmentTombstones", () => {
  const NOW = new Date("2026-07-14T12:00:00Z");

  it("tombstones an order that vanished from Woo; a live order is untouched", async () => {
    db.fulfillmentObservation.findMany.mockResolvedValue([
      { externalOrderId: "A" },
      { externalOrderId: "B" },
    ] as never);
    mockPlatformRead.mockImplementation(async (_id, _path, q) => {
      const status = (q as Record<string, string>).status;
      if (status === "any") return wooResponse([{ id: "B" }], { totalPages: 1 }); // only B is live
      return wooResponse([], { totalPages: 1 }); // trash empty
    });
    db.fulfillmentObservation.updateMany.mockResolvedValue({ count: 2 } as never);

    const res = await reconcileFulfillmentTombstones(INT, { now: NOW });

    // A (gone) tombstoned; B (live) not.
    expect(db.fulfillmentObservation.updateMany).toHaveBeenCalledWith({
      where: { integrationId: INT, externalOrderId: "A", tombstonedAt: null },
      data: { tombstonedAt: NOW },
    });
    expect(db.fulfillmentObservation.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ externalOrderId: "B" }) })
    );
    expect(res.tombstoned).toBe(2);
  });

  it("polls trash EXPLICITLY and tombstones a trashed order", async () => {
    db.fulfillmentObservation.findMany.mockResolvedValue([{ externalOrderId: "T" }] as never);
    mockPlatformRead.mockImplementation(async (_id, _path, q) => {
      const status = (q as Record<string, string>).status;
      if (status === "any") return wooResponse([], { totalPages: 1 }); // T not in live set
      if (status === "trash") return wooResponse([{ id: "T" }], { totalPages: 1 });
      return wooResponse([], { totalPages: 1 });
    });
    db.fulfillmentObservation.updateMany.mockResolvedValue({ count: 1 } as never);

    await reconcileFulfillmentTombstones(INT, { now: NOW });

    const polledTrash = mockPlatformRead.mock.calls.some(
      (c) => (c[2] as Record<string, string>)?.status === "trash"
    );
    expect(polledTrash).toBe(true);
    expect(db.fulfillmentObservation.updateMany).toHaveBeenCalledWith({
      where: { integrationId: INT, externalOrderId: "T", tombstonedAt: null },
      data: { tombstonedAt: NOW },
    });
  });
});

describe("getUnitsOnCompletedOrders (totals exclude tombstones)", () => {
  it("aggregates units where tombstonedAt is null", async () => {
    db.fulfillmentObservation.aggregate.mockResolvedValue({
      _sum: { unitsOnCompletedOrder: 42 },
    } as never);
    const total = await getUnitsOnCompletedOrders(INT);
    expect(total).toBe(42);
    expect(db.fulfillmentObservation.aggregate).toHaveBeenCalledWith({
      where: { integrationId: INT, tombstonedAt: null },
      _sum: { unitsOnCompletedOrder: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Webhook hint (REV-2 #15) — persist only, GET happens in the poll
// ---------------------------------------------------------------------------

describe("persistFulfillmentHint (HINT ONLY — never a synchronous Woo GET)", () => {
  it("upserts a hint for a WooCommerce order and issues NO platform read", async () => {
    await persistFulfillmentHint(INT, "WOOCOMMERCE", "500");
    expect(db.fulfillmentObservationHint.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { integrationId_externalOrderId: { integrationId: INT, externalOrderId: "500" } },
      })
    );
    expect(mockPlatformRead).not.toHaveBeenCalled();
  });

  it("ignores non-WooCommerce platforms", async () => {
    await persistFulfillmentHint(INT, "SHOPIFY", "500");
    expect(db.fulfillmentObservationHint.upsert).not.toHaveBeenCalled();
  });

  it("ignores a missing order id", async () => {
    await persistFulfillmentHint(INT, "WOOCOMMERCE", null);
    expect(db.fulfillmentObservationHint.upsert).not.toHaveBeenCalled();
  });

  it("is best-effort: a DB failure never throws (webhook delivery must not break)", async () => {
    db.fulfillmentObservationHint.upsert.mockRejectedValue(new Error("db down"));
    await expect(persistFulfillmentHint(INT, "WOOCOMMERCE", "500")).resolves.toBeUndefined();
  });
});

describe("processFulfillmentHints (the poll does the GET of CURRENT state)", () => {
  it("GETs current order state, applies it, and marks the hint processed", async () => {
    db.fulfillmentObservationHint.findMany.mockResolvedValue([
      { id: 1, externalOrderId: "500" },
    ] as never);
    mockPlatformRead.mockResolvedValue(wooResponse(order({ id: 500 })));

    const res = await processFulfillmentHints(INT);

    // The GET is against the order-by-id endpoint — CURRENT state, not payload state.
    expect(mockPlatformRead).toHaveBeenCalledWith(INT, "/wp-json/wc/v3/orders/500");
    expect(res.processed).toBe(1);
    expect(db.fulfillmentObservationHint.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ processedAt: expect.any(Date) }) })
    );
  });

  it("a 404 (deleted order) marks the hint processed without applying", async () => {
    db.fulfillmentObservationHint.findMany.mockResolvedValue([
      { id: 2, externalOrderId: "999" },
    ] as never);
    mockPlatformRead.mockResolvedValue(wooResponse({ code: "not_found" }, { status: 404 }));

    const res = await processFulfillmentHints(INT);
    expect(res.processed).toBe(1);
    expect(db.fulfillmentObservation.upsert).not.toHaveBeenCalled();
  });

  it("a failed GET leaves the hint UNPROCESSED for the next run", async () => {
    db.fulfillmentObservationHint.findMany.mockResolvedValue([
      { id: 3, externalOrderId: "500" },
    ] as never);
    mockPlatformRead.mockRejectedValue(new Error("timeout"));

    const res = await processFulfillmentHints(INT);
    expect(res.failed).toBe(1);
    expect(db.fulfillmentObservationHint.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The fence: this module NEVER opens a network connection itself
// ---------------------------------------------------------------------------

describe("egress boundary", () => {
  it("does not import fetch or any HTTP client — all reads go through platformRead", () => {
    const src = readFileSync(
      path.join(process.cwd(), "lib/external-orders/fulfillment-observations.ts"),
      "utf8"
    );
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/from\s+["'](node-fetch|axios|undici|node:https?|https?)["']/);
    expect(src).toMatch(/from\s+["']@\/lib\/platforms\/egress["']/);
  });
});
