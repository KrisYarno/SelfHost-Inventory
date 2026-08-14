// @jest-environment node
//
// A6 regression: the mass-update endpoint must log a TRUTHFUL inventory delta
// (the server-recomputed `newQuantity - currentQuantity`), never the
// client-supplied `delta`. The stock-snapshot backfill reconciles
// `current - SUM(delta)`, so a stale/wrong client delta would permanently
// poison that math. This test drives a change with a deliberately wrong client
// delta and asserts the logged delta is the server-computed value.
jest.mock("@/lib/api-utils", () => ({
  // Real module first so requireCSRF exists (it calls the mocked
  // validateCSRFToken below, which beforeEach resolves to true).
  ...jest.requireActual("@/lib/api-utils"),
  apiHandler: (fn: any) => fn,
  requireAdmin: jest.fn(),
}));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn() }));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
// The single bulk-update summary is recorded post-batch via `recordIngestion`
// (P-B1: best-effort ingestion tier — stock already committed per-batch, so a
// summary-write failure must not 500 a succeeded operation). Its end-to-end
// R-D14 rows behavior is covered by
// __tests__/integration/api/change-tracking-inventory.test.ts. Stub it here so
// the delta-truthfulness assertions stay focused; the recording-tier assertions
// live in their own tests below.
jest.mock("@/lib/change-tracking", () => ({
  recordIngestion: jest.fn(async () => true),
  newBatchId: jest.fn(() => "batch-test"),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { $transaction: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/inventory/mass-update/route";
import { requireAdmin } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { recordIngestion } from "@/lib/change-tracking";
import prisma from "@/lib/prisma";

const db = prisma as unknown as { $transaction: jest.Mock };

// Build a tx mock. `currentQuantity` is what product_locations.findUnique
// returns from inside the transaction (the locked row).
function makeTx(currentQuantity: number | null) {
  return {
    product: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 1, name: "Widget", deletedAt: null }),
      // T8: the loc-1 `products.quantity` mirror write. Call-shape suites only
      // need it to exist; the mirror's VALUE is pinned by the state suite below.
      update: jest.fn().mockResolvedValue({}),
    },
    location: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, name: "Warehouse" }),
    },
    product_locations: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          currentQuantity === null ? null : { quantity: currentQuantity }
        ),
      upsert: jest.fn().mockResolvedValue({}),
    },
    inventory_logs: {
      create: jest.fn().mockResolvedValue({ id: 999 }),
    },
  };
}

function postWith(body: unknown) {
  return new NextRequest("http://x/api/admin/inventory/mass-update", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({
    user: { id: 7, isAdmin: true, isApproved: true },
  });
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
});

test("logs the server-recomputed delta (newQuantity - in-tx current), NOT the client delta", async () => {
  const tx = makeTx(10); // current quantity in DB is 10
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  // Client lies: says delta is 100, but newQuantity 4 against current 10 => -6.
  const res = await POST(
    postWith({ changes: [{ productId: 1, locationId: 1, newQuantity: 4, delta: 100 }] })
  );

  expect(res.status).toBe(200);
  expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
  const logged = tx.inventory_logs.create.mock.calls[0][0].data;
  expect(logged.delta).toBe(-6); // 4 - 10, the truthful delta
  expect(logged.delta).not.toBe(100); // never the client-supplied value

  // The absolute quantity still gets written as before.
  expect(tx.product_locations.upsert).toHaveBeenCalledTimes(1);
  const upsertArg = tx.product_locations.upsert.mock.calls[0][0];
  expect(upsertArg.update.quantity).toBe(4);
  expect(upsertArg.create.quantity).toBe(4);
});

test("when the row does not exist, current=0 so logged delta equals newQuantity", async () => {
  const tx = makeTx(null); // no existing product_locations row
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  const res = await POST(
    postWith({ changes: [{ productId: 1, locationId: 1, newQuantity: 4, delta: 999 }] })
  );

  expect(res.status).toBe(200);
  const logged = tx.inventory_logs.create.mock.calls[0][0].data;
  expect(logged.delta).toBe(4); // 4 - 0
});

test("empty changes array is rejected by the envelope schema before any DB work", async () => {
  // This suite stubs apiHandler as a passthrough, so the ZodError surfaces
  // directly (in production apiHandler maps it to a 400). Either way the schema
  // short-circuits before touching the database.
  await expect(POST(postWith({ changes: [] }))).rejects.toThrow();
  expect(db.$transaction).not.toHaveBeenCalled();
});

test("negative newQuantity is NOT a blanket 400: it becomes a per-row structured failure", async () => {
  // The schema deliberately leaves newQuantity unconstrained so the handler can
  // report a negative quantity as a per-item VALIDATION_ERROR (preserving the
  // partial-update / recovery UX) rather than rejecting the whole batch at parse.
  const res = await POST(
    postWith({ changes: [{ productId: 1, locationId: 1, newQuantity: -5, delta: 0 }] })
  );
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.failures).toHaveLength(1);
  expect(body.failures[0].reason).toBe("VALIDATION_ERROR");
  expect(db.$transaction).not.toHaveBeenCalled();
});

test("no-op based on the REAL delta: when newQuantity equals current, skip log + upsert", async () => {
  const tx = makeTx(4); // current already 4
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  // Client claims a non-zero delta, but the real change is zero.
  const res = await POST(
    postWith({ changes: [{ productId: 1, locationId: 1, newQuantity: 4, delta: 50 }] })
  );

  expect(res.status).toBe(200);
  expect(tx.inventory_logs.create).not.toHaveBeenCalled();
  expect(tx.product_locations.upsert).not.toHaveBeenCalled();
  const body = await res.json();
  expect(body.successful).toBe(1); // still counts as a successful (no-op) change
});

// ---------------------------------------------------------------------------
// P-B1: the post-batch summary is recorded through the best-effort ingestion
// tier (`recordIngestion`), NOT a recordChange-in-its-own-tx. Stock already
// committed per-batch above, so a summary-write failure must never 500 a
// succeeded operation. These pin the tier switch + the R-D14 payload parity.
// ---------------------------------------------------------------------------

test("post-batch summary is recorded via recordIngestion (not a summary tx) with the R-D14 payload", async () => {
  const tx = makeTx(10); // current 10 -> newQuantity 4 => real delta -6 (changed)
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  const res = await POST(
    postWith({ changes: [{ productId: 1, locationId: 1, newQuantity: 4, delta: 100 }] })
  );
  expect(res.status).toBe(200);

  // Exactly one $transaction ran — the stock BATCH. The summary is NOT wrapped
  // in its own transaction anymore (that was the recordChange-in-tx path).
  expect(db.$transaction).toHaveBeenCalledTimes(1);

  expect(recordIngestion).toHaveBeenCalledTimes(1);
  const [event, opts] = (recordIngestion as jest.Mock).mock.calls[0];
  expect(event.actor).toEqual({ userId: 7 }); // USER actor via ingestion (P-B1 exception)
  expect(event.actionType).toBe("INVENTORY_BULK_UPDATE");
  expect(event.entityType).toBe("INVENTORY");
  expect(event.affectedCount).toBe(1);
  expect(event.batchId).toBe("batch-test");
  // R-D14 per-row from/to, server-truthful (current 10 -> 4, client delta ignored).
  expect(event.details.rows).toEqual([
    { entityId: "1", changes: { quantity: { from: 10, to: 4 } } },
  ]);
  expect(opts).toEqual({});
});

test("a summary ingestion failure does NOT fail the response (P-B1: 200 with result body)", async () => {
  const tx = makeTx(10);
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  // recordIngestion swallows its own errors and reports failure by returning
  // false; the route must ignore that and still return the operation result.
  (recordIngestion as jest.Mock).mockResolvedValueOnce(false);

  const res = await POST(
    postWith({ changes: [{ productId: 1, locationId: 1, newQuantity: 4, delta: 100 }] })
  );

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.successful).toBe(1);
  expect(body.failed).toBe(0);
});

// ---------------------------------------------------------------------------
// Phase C phantom-summary fix (codex): processedChanges/successCount are folded
// into the running totals only AFTER a batch's $transaction resolves, so a batch
// that throws mid-way (all-or-nothing rollback) contributes ZERO rows to the
// summary. Pre-fix, the first change's in-tx push survived the rollback and
// inflated the summary; now it is discarded with the rolled-back writes.
// ---------------------------------------------------------------------------
test("phantom-summary fix: a batch that throws mid-way contributes ZERO rows to the summary", async () => {
  // One batch, two changes. Change 1 succeeds (and pushes a log INSIDE the tx);
  // change 2's product is missing, so the batch throws and rolls back.
  const tx = {
    product: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({ id: 1, name: "Widget", deletedAt: null })
        .mockResolvedValueOnce(null), // second product missing -> throw -> rollback
      update: jest.fn().mockResolvedValue({}), // T8 loc-1 mirror write
    },
    location: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, name: "Warehouse" }),
    },
    product_locations: {
      findUnique: jest.fn().mockResolvedValue({ quantity: 10 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    inventory_logs: {
      create: jest.fn().mockResolvedValue({ id: 999 }),
    },
  };
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  const res = await POST(
    postWith({
      changes: [
        { productId: 1, locationId: 1, newQuantity: 4, delta: 0 },
        { productId: 2, locationId: 1, newQuantity: 7, delta: 0 },
      ],
    })
  );

  // All-or-nothing (default allowPartial=false): the whole batch rolled back, so
  // there are zero successes and the summary event is NEVER recorded.
  expect(res.status).toBe(500);
  expect(recordIngestion).not.toHaveBeenCalled();

  // Change 1 DID write a log inside the tx — proving the rollback (not a skipped
  // write) is what keeps the phantom row out of the summary.
  expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// T8 (contract pack 2026-08-13-fulllane-contracts §"T8 — Mass-update
// ride-along") — the upsert maintains BOTH the row's `version` AND the loc-1
// `products.quantity` mirror, in place, keeping absolute-set + batched-tx
// semantics (mass-update deliberately does NOT adopt applyStockDelta).
//
// These are STATE assertions, not call-shape ones, on purpose. mass-update
// writes an ABSOLUTE quantity while the house core `applyStockDelta` writes a
// DELTA, so "was upsert called with the right argument" cannot answer the
// question the bug is about: does `products.quantity` END UP EQUAL to the
// location-1 row? That inequality is the +939-unit phantom drift class — every
// weekly COUNT entered through mass-import moved product_locations and left the
// legacy mirror (which legacy readers still consume) behind, and skipped the
// `version` bump the registered out-of-band drift detector reads.
//
// This repo has no test DB (see __tests__/unit/lib/inventory.applyStockDelta.test.ts),
// so the store below is a small in-memory Prisma stand-in modelling exactly the
// semantics these pins depend on: scalar-vs-`{increment}` writes, and the
// prisma/schema.prisma DEFAULTS on create — `quantity` 0 and **`version` 0**,
// so a create that omits `version` lands at 0, NOT at 1.
// ---------------------------------------------------------------------------

type PlRow = {
  productId: number;
  locationId: number;
  quantity: number;
  version: number;
};

/** Prisma write-value semantics: `{ increment: n }` adds, anything else sets. */
function applyWrite(row: Record<string, any>, data: Record<string, any>) {
  for (const [field, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      row[field] = (row[field] ?? 0) + value.increment;
    } else {
      row[field] = value;
    }
  }
}

const plKey = (productId: number, locationId: number) => `${productId}:${locationId}`;

/**
 * A stateful stand-in for the batch TransactionClient. Every POST driven
 * against the same store sees the previous POST's committed state, which is
 * what makes the "two sequential mass-updates" pin a real sequence.
 */
function makeStore(seed: {
  products: { id: number; name: string; quantity: number }[];
  productLocations?: Array<Partial<PlRow> & { productId: number; locationId: number }>;
}) {
  const products = new Map(
    seed.products.map((p) => [p.id, { deletedAt: null, ...p } as Record<string, any>])
  );
  const productLocations = new Map<string, PlRow>(
    (seed.productLocations ?? []).map((r) => [
      plKey(r.productId, r.locationId),
      { quantity: 0, version: 0, ...r } as PlRow,
    ])
  );
  const logs: any[] = [];

  const tx = {
    product: {
      findUnique: async ({ where }: any) => products.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const row = products.get(where.id);
        if (!row) throw new Error(`no product ${where.id}`);
        applyWrite(row, data);
        return row;
      },
    },
    location: {
      findUnique: async ({ where }: any) => ({ id: where.id, name: `Location ${where.id}` }),
    },
    product_locations: {
      findUnique: async ({ where }: any) => {
        const { productId, locationId } = where.productId_locationId;
        return productLocations.get(plKey(productId, locationId)) ?? null;
      },
      upsert: async ({ where, update, create }: any) => {
        const { productId, locationId } = where.productId_locationId;
        const existing = productLocations.get(plKey(productId, locationId));
        if (existing) {
          applyWrite(existing, update);
          return existing;
        }
        // Schema defaults fill what `create` omits — see the note above.
        const row = { quantity: 0, version: 0, ...create } as PlRow;
        productLocations.set(plKey(productId, locationId), row);
        return row;
      },
    },
    inventory_logs: {
      create: async ({ data }: any) => {
        logs.push(data);
        return { id: logs.length };
      },
    },
  };

  return {
    tx,
    logs,
    product: (id: number) => products.get(id)!,
    productLocation: (productId: number, locationId: number) =>
      productLocations.get(plKey(productId, locationId)),
  };
}

type Store = ReturnType<typeof makeStore>;

/** Drive ONE mass-update POST against a store's live state. */
async function massUpdate(
  store: Store,
  changes: Array<{ productId: number; locationId: number; newQuantity: number }>
) {
  db.$transaction.mockImplementation(async (cb: any) => cb(store.tx));
  const res = await POST(
    postWith({ changes: changes.map((c) => ({ ...c, delta: 0 })) })
  );
  expect(res.status).toBe(200);
  return res;
}

describe("T8 — mass-update maintains product_locations.version", () => {
  it("PIN 1: two sequential mass-updates on one loc-1 row => version +2, quantity = the LATER value", async () => {
    const store = makeStore({
      products: [{ id: 1, name: "Widget", quantity: 10 }],
      productLocations: [{ productId: 1, locationId: 1, quantity: 10, version: 5 }],
    });

    await massUpdate(store, [{ productId: 1, locationId: 1, newQuantity: 4 }]);
    await massUpdate(store, [{ productId: 1, locationId: 1, newQuantity: 7 }]);

    const row = store.productLocation(1, 1)!;
    expect(row.version).toBe(7); // 5 + 2 — one bump per real change
    expect(row.quantity).toBe(7); // absolute-set semantics: the later value wins
    expect(store.product(1).quantity).toBe(7); // and the mirror followed it
  });

  it("PIN 5: a first-ever (product, location) row is CREATED at version 1", async () => {
    // The schema default is 0; applyStockDelta's create writes `version: 1`
    // explicitly, and the pack says mass-update must too.
    const store = makeStore({ products: [{ id: 1, name: "Widget", quantity: 0 }] });

    await massUpdate(store, [{ productId: 1, locationId: 1, newQuantity: 4 }]);

    const row = store.productLocation(1, 1)!;
    expect(row.version).toBe(1);
    expect(row.quantity).toBe(4);
    expect(store.product(1).quantity).toBe(4); // the create path mirrors too
  });
});

describe("T8 — mass-update maintains the loc-1 products.quantity mirror", () => {
  it("PIN 2 (mirror-drift): post-write products.quantity == location-1 product_locations.quantity", async () => {
    // Seeded ALREADY DRIFTED (+939), the exact production shape: past mass
    // updates moved the location row and never touched the mirror. The write is
    // ABSOLUTE, so the next real change heals the drift instead of carrying it.
    const store = makeStore({
      products: [{ id: 1, name: "Widget", quantity: 949 }],
      productLocations: [{ productId: 1, locationId: 1, quantity: 10, version: 3 }],
    });

    await massUpdate(store, [{ productId: 1, locationId: 1, newQuantity: 42 }]);

    const row = store.productLocation(1, 1)!;
    expect(row.quantity).toBe(42);
    expect(store.product(1).quantity).toBe(42);
    expect(store.product(1).quantity).toBe(row.quantity); // the invariant itself
  });

  it("PIN 3: a NON-loc-1 update bumps its own row's version and leaves the mirror untouched", async () => {
    const store = makeStore({
      products: [{ id: 1, name: "Widget", quantity: 10 }],
      productLocations: [
        { productId: 1, locationId: 1, quantity: 10, version: 3 },
        { productId: 1, locationId: 2, quantity: 10, version: 3 },
      ],
    });

    await massUpdate(store, [{ productId: 1, locationId: 2, newQuantity: 4 }]);

    expect(store.productLocation(1, 2)!.version).toBe(4);
    expect(store.productLocation(1, 2)!.quantity).toBe(4);
    // The mirror is location-1's, and location 1 did not move (house rule,
    // verified against applyStockDelta's `if (locationId === 1)` guard).
    expect(store.product(1).quantity).toBe(10);
    expect(store.productLocation(1, 1)!.version).toBe(3);
  });

  it("PIN 4: a serverDelta === 0 row writes NEITHER the version NOR the mirror", async () => {
    // Seeded drifted again, which makes the skip's scope explicit: a no-change
    // row is a no-write row (no false 'this row changed' signal for the
    // out-of-band detector), so it does NOT heal a pre-existing mirror drift
    // either — the next REAL change does. Deliberate; see the route comment.
    const store = makeStore({
      products: [{ id: 1, name: "Widget", quantity: 949 }],
      productLocations: [{ productId: 1, locationId: 1, quantity: 4, version: 5 }],
    });

    await massUpdate(store, [{ productId: 1, locationId: 1, newQuantity: 4 }]);

    const row = store.productLocation(1, 1)!;
    expect(row.version).toBe(5); // untouched
    expect(row.quantity).toBe(4);
    expect(store.product(1).quantity).toBe(949); // untouched, still drifted
    expect(store.logs).toHaveLength(0); // and no ledger row, as before
  });
});
