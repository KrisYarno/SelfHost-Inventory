// @jest-environment node
//
// Phase 0b-1 (spec 2026-08-12 REV-2 §"Phase 0b" / OC-9): mass-update's ledger
// rows self-label as COUNT events — `logType: COUNT` + `reasonCode: 'COUNT'`.
// Before this change every mass-count row was an anonymous ADJUSTMENT with a
// NULL reason, indistinguishable from receiving or from a hand adjustment.
//
// The stamp is one line in the route; the reason this file exists is the
// DOWNSTREAM CONSEQUENCE. The same row is read by three classifiers that each
// treat COUNT differently, so the classification of every future mass count
// moves the day this deploys. Each consequence is pinned here against the row
// the route ACTUALLY writes, not against a hand-written fixture — a fixture
// would keep passing if the route ever stopped stamping.
//
// The three readings, before -> after (see the report/register):
//   outbound mix (lib/reports/outbound-mix)  adjustmentUnclassified -> countOut
//   get_shrinkage (lib/analytics/queries)    coverage.unclassifiedOutboundUnits
//                                            -> OUT OF DOMAIN entirely
//   reorderDemand (lib/reports/metrics-contract)  included -> STILL included
//
// NOTE on get_shrinkage: the spec text predicted the negative count rows would
// start landing in `byReason.COUNT` as CLASSIFIED loss. They do not, because
// getShrinkageSummary narrows its domain to `logType IN (ADJUSTMENT, CORRECTION)`
// BEFORE the reason is ever classified — so a COUNT-logType row is not in the
// shrinkage read at all. The pin below records the real behavior.
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  apiHandler: (fn: any) => fn,
  requireAdmin: jest.fn(),
}));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn() }));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/change-tracking", () => ({
  recordIngestion: jest.fn(async () => true),
  newBatchId: jest.fn(() => "batch-test"),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { $transaction: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/inventory/mass-update/route";
import { requireAdmin } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import prisma from "@/lib/prisma";
import { outboundBucketOf } from "@/lib/reports/outbound-mix";
import { isReorderDemandRow, shrinkageReasonOf } from "@/lib/reports/metrics-contract";

const db = prisma as unknown as { $transaction: jest.Mock };

/**
 * getShrinkageSummary's `domain` (lib/analytics/queries.ts) — the logTypes the
 * shrinkage read looks at AT ALL. Copied here deliberately: this file's job is
 * to pin that the row mass-update writes falls OUTSIDE it, and importing
 * queries.ts would drag the whole analytics module graph into a route test.
 * lane3-operations-queries.test.ts pins the constant against the real query.
 */
const SHRINKAGE_DOMAIN_LOGTYPES = ["ADJUSTMENT", "CORRECTION"];

function makeTx(currentQuantity: number | null) {
  return {
    product: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, name: "Widget", deletedAt: null }),
    },
    location: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, name: "Warehouse" }),
    },
    product_locations: {
      findUnique: jest
        .fn()
        .mockResolvedValue(currentQuantity === null ? null : { quantity: currentQuantity }),
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

/** Drive one change through the route and hand back the ledger row it wrote. */
async function loggedRow(current: number, newQuantity: number) {
  const tx = makeTx(current);
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));
  const res = await POST(
    postWith({ changes: [{ productId: 1, locationId: 1, newQuantity, delta: 0 }] })
  );
  expect(res.status).toBe(200);
  expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
  return tx.inventory_logs.create.mock.calls[0][0].data as {
    delta: number;
    logType: string;
    reasonCode: string | null;
    batchId: string;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({
    user: { id: 7, isAdmin: true, isApproved: true },
  });
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// 0b-1 — the stamp itself
// ---------------------------------------------------------------------------

describe("0b-1 — mass-update stamps COUNT on every ledger row it writes", () => {
  it("stamps logType COUNT + reasonCode COUNT on a DOWNWARD correction", async () => {
    const row = await loggedRow(10, 4);
    expect(row.delta).toBe(-6);
    expect(row.logType).toBe("COUNT");
    expect(row.reasonCode).toBe("COUNT");
  });

  it("stamps the same COUNT pair on an UPWARD correction (a count that raises stock is still a count)", async () => {
    const row = await loggedRow(4, 10);
    expect(row.delta).toBe(6);
    expect(row.logType).toBe("COUNT");
    expect(row.reasonCode).toBe("COUNT");
  });

  it("keeps the operation-wide batchId join (P-C1) — the stamp adds fields, it replaces nothing", async () => {
    const row = await loggedRow(10, 4);
    expect(row.batchId).toBe("batch-test");
  });
});

// ---------------------------------------------------------------------------
// The consequences, pinned against the row the route actually writes
// ---------------------------------------------------------------------------

describe("0b-1 consequence — the outbound mix reclassifies mass-count depletion", () => {
  it("a negative mass-count row is countOut, NOT adjustmentUnclassified", async () => {
    const row = await loggedRow(10, 4);
    // BEFORE 0b-1 this row was {logType: ADJUSTMENT, reasonCode: null} and the
    // classifier's ADJUSTMENT branch, finding no classified reason, called it
    // `adjustmentUnclassified`. outboundMix30's composition moves accordingly.
    expect(outboundBucketOf(row)).toBe("countOut");
    expect(outboundBucketOf(row)).not.toBe("adjustmentUnclassified");
  });

  it("logType COUNT decides the bucket BEFORE the reason is consulted (countOut, never classifiedLoss)", async () => {
    const row = await loggedRow(10, 4);
    // `shrinkageReasonOf('COUNT')` IS a classified loss reason, so this is the
    // one place the two rules could have disagreed. The logType switch wins:
    // an explicit count event is a count, not a loss of unknown cause.
    expect(shrinkageReasonOf(row.reasonCode)).toBe("COUNT");
    expect(outboundBucketOf(row)).toBe("countOut");
  });
});

describe("0b-1 consequence — get_shrinkage stops seeing mass-count rows at all", () => {
  it("the stamped row falls OUTSIDE the ADJUSTMENT/CORRECTION shrinkage domain", async () => {
    const row = await loggedRow(10, 4);
    // BEFORE: logType ADJUSTMENT put the row IN the domain with a null reason,
    // so its units were reported as `coverage.unclassifiedOutboundUnits`.
    // AFTER: the row is not in the domain, so it contributes to NEITHER
    // byReason.COUNT NOR the unclassified-outbound coverage figure. The
    // unclassified-outbound number visibly DROPS on the next mass count.
    expect(SHRINKAGE_DOMAIN_LOGTYPES).not.toContain(row.logType);
  });
});

describe("0b-1 register note — reorderDemand is UNCHANGED by the stamp", () => {
  it("the stamped row still satisfies the locked reorder-demand predicate", async () => {
    const row = await loggedRow(10, 4);
    // delta < 0 AND logType != TRANSFER AND reasonCode != 'CORRECTION'.
    // It matched as a reason-less ADJUSTMENT and it matches as COUNT/'COUNT'.
    // No behavior change today — but the rows are now EXCLUDABLE, and whether
    // to exclude them is a future adjudication, NOT part of 0b.
    expect(isReorderDemandRow(row)).toBe(true);
  });
});
