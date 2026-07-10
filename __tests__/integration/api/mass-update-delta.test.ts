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
