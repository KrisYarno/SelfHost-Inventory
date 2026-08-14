// @jest-environment node
//
// W2-1 (contract pack REV-11 T7) — THE INTENT CHIP'S MAPPING TABLE, pinned AT
// THE ROUTE.
//
//   | value       | reasonCode | orderRecordId          | surfaces          |
//   | order       | none       | via extracted resolver | adjust + workbench |
//   | damage-loss | DAMAGE     | none                   | ADJUST ONLY       |
//   | other       | none       | none                   | both; NEVER CORRECTION |
//
// Every pin here drives the REAL route against a deep-mocked Prisma and reads
// the payload the route actually handed `inventory_logs.create`. The pack is
// explicit that the mapping is pinned at the ROUTE LEVEL, not at the mapper: a
// pure-function test would keep passing if a route stopped calling the mapper,
// and `other -> CORRECTION` is precisely the mistake that would silently remove
// rows from the LOCKED reorder-demand predicate.
//
// The two downstream consequences are pinned against the SAME row the route
// wrote (the mass-update-count-stamp.test.ts idiom), never against a fixture:
//   - a damage-loss row is INSIDE getShrinkageSummary's domain and classifies
//     as DAMAGE (the shrinkage-jump the disclosure warns about);
//   - an `other` row is NOT a CORRECTION and therefore STAYS in reorder demand.
import { mockDeep, type DeepMockProxy } from "jest-mock-extended";
import { Prisma } from "@prisma/client";

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireCompanyMembership: jest.fn(),
  requireCSRF: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
// `mockDeep` is referenced directly rather than re-required inside the factory:
// jest's hoist plugin allows out-of-scope bindings whose names begin with
// `mock`, so this keeps the file free of the require() the lint profile forbids.
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved, requireCompanyMembership, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { SimpleDeductSchema } from "@/lib/validation/workbench";
import { AdjustWithIntentSchema } from "@/lib/validation/inventory";
import { isReorderDemandRow, shrinkageReasonOf } from "@/lib/reports/metrics-contract";
import { POST as ADJUST } from "@/app/api/inventory/adjust/route";
import { POST as DEDUCT } from "@/app/api/inventory/deduct-simple/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const ORDER_CUID = "cmdq7f3k80001s6h4p2n9wxyz";
const COMPANY_ID = "company-abc";

/**
 * getShrinkageSummary's `domain` (lib/analytics/queries.ts): the logTypes the
 * shrinkage read looks at AT ALL, plus its `delta < 0`. Copied deliberately —
 * importing queries.ts would drag the analytics module graph into a route test,
 * and lane3-operations-queries.test.ts already pins the constant against the
 * real query.
 */
const SHRINKAGE_DOMAIN_LOGTYPES = ["ADJUSTMENT", "CORRECTION"];

type LedgerRowData = {
  delta: number;
  logType: string;
  reasonCode: string | null;
  orderRecordId: string | null;
  batchId: string | null;
};

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

function makeTx() {
  const tx = mockDeep<Prisma.TransactionClient>();
  tx.product_locations.findUnique.mockResolvedValue({ version: 1, quantity: 100 } as any);
  tx.product_locations.upsert.mockResolvedValue({ version: 2 } as any);
  tx.inventory_logs.create.mockResolvedValue({
    id: 555,
    productId: 5,
    locationId: 2,
    delta: -3,
    products: { name: "Widget" },
  } as any);
  tx.product.findUnique.mockResolvedValue({ id: 5, name: "Widget" } as any);
  tx.product.update.mockResolvedValue({} as any);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  return tx;
}

function driveTxWith(tx: ReturnType<typeof makeTx>) {
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
  // Stock floor for the adjust route's pre-transaction availability check.
  db.product_locations.findUnique.mockResolvedValue({ quantity: 100, version: 1 } as any);
  db.product.findUnique.mockResolvedValue({ name: "Widget" } as any);
});

// ---------------------------------------------------------------------------
// The adjust surface — all THREE chip values live here
// ---------------------------------------------------------------------------

/** Drive one adjustment through the REAL route; hand back what it wrote. */
async function adjustRow(body: Record<string, unknown>) {
  const tx = makeTx();
  driveTxWith(tx);
  const res = await ADJUST(
    post("http://x/api/inventory/adjust", {
      productId: 5,
      locationId: 2,
      delta: -3,
      reason: "operator words",
      ...body,
    })
  );
  expect(res.status).toBe(200);
  expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
  return {
    row: tx.inventory_logs.create.mock.calls[0][0].data as unknown as LedgerRowData,
    details: tx.auditLog.create.mock.calls[0][0].data.details as Record<string, unknown>,
  };
}

describe("adjust route — T7 mapping table, row by row", () => {
  it("order -> NO reasonCode, orderRecordId from the extracted resolver", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row, details } = await adjustRow({
      intent: "order",
      selectedExternalOrderId: ORDER_CUID,
    });

    expect(row.reasonCode ?? null).toBeNull();
    expect(row.orderRecordId).toBe(ORDER_CUID);
    // Membership is proven against the RESOLVED order's company, never a claim.
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, COMPANY_ID, false);
    expect(details.intent).toBe("order");
  });

  it("damage-loss -> reasonCode DAMAGE and NO orderRecordId", async () => {
    const { row } = await adjustRow({ intent: "damage-loss" });

    expect(row.reasonCode).toBe("DAMAGE");
    expect(row.orderRecordId ?? null).toBeNull();
  });

  it("other -> nothing at all, and above all NEVER CORRECTION", async () => {
    const { row } = await adjustRow({ intent: "other" });

    expect(row.reasonCode ?? null).toBeNull();
    expect(row.orderRecordId ?? null).toBeNull();
    // The LOCKED reorder-demand predicate excludes reasonCode === 'CORRECTION'.
    // Mapping `other` there would silently delete this depletion from demand.
    expect(row.reasonCode).not.toBe("CORRECTION");
  });

  it("still VALIDATES an id sent with a non-order intent, then declines to stamp it", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row } = await adjustRow({
      intent: "other",
      selectedExternalOrderId: ORDER_CUID,
    });

    // Checked (so a forgery cannot ride through unexamined)...
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, COMPANY_ID, false);
    // ...and not stamped, because `other` attributes nothing.
    expect(row.orderRecordId ?? null).toBeNull();
  });

  it("an order intent with NO id resolves nothing and stamps nothing (never invented)", async () => {
    const { row, details } = await adjustRow({ intent: "order" });

    expect(row.orderRecordId ?? null).toBeNull();
    expect(db.externalOrder.findUnique).not.toHaveBeenCalled();
    // The operator's statement is still accrued — never a silent drop.
    expect(details.intent).toBe("order");
  });
});

describe("adjust route — the chip NEVER blocks (design friction ceiling)", () => {
  it("submits legally with no chip interaction at all, landing as other/nothing", async () => {
    const { row, details } = await adjustRow({});

    expect(row.reasonCode ?? null).toBeNull();
    expect(row.orderRecordId ?? null).toBeNull();
    // Truthful-data north star: an untapped chip is an ABSENT key, not a null
    // one — a null would read as a recorded classification that never happened.
    expect("intent" in details).toBe(false);
  });
});

describe("adjust route — the old reason vocabulary no longer arrives", () => {
  it.each(["COUNT", "DAMAGE", "THEFT", "EXPIRY", "CORRECTION"])(
    "REFUSES a legacy reasonCode %s with 400 VALIDATION_ERROR and writes nothing",
    async (reasonCode) => {
      const tx = makeTx();
      driveTxWith(tx);

      await expect(
        ADJUST(
          post("http://x/api/inventory/adjust", {
            productId: 5,
            locationId: 2,
            delta: -3,
            reason: "operator words",
            reasonCode,
          })
        )
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

      // Refused BEFORE any write opens — zod's default strip would have
      // swallowed the field silently, which is the double-entry path the pack
      // closes at the ROUTE, not at the mapper.
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );
});

describe("adjust route — forged order ids abort the whole request (0b-2 posture)", () => {
  it("REJECTS an id that resolves to no order with 400 and commits nothing", async () => {
    db.externalOrder.findUnique.mockResolvedValue(null as any);

    await expect(
      adjustRow({ intent: "order", selectedExternalOrderId: "not-a-real-order-id" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    expect(requireCompanyMembership).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("REJECTS a foreign company's order id with the SAME 400", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: "company-other" } as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError("Resource not found", "NOT_FOUND", 404)
    );

    await expect(
      adjustRow({ intent: "order", selectedExternalOrderId: ORDER_CUID })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Downstream consequences, read off the row the ROUTE wrote
// ---------------------------------------------------------------------------

describe("chip consequences — the same row, read by the classifiers that matter", () => {
  it("a chip-DAMAGE row is INSIDE getShrinkageSummary's domain and classifies as DAMAGE", async () => {
    const { row } = await adjustRow({ intent: "damage-loss" });

    // The domain narrows on logType and delta BEFORE any reason is classified.
    expect(SHRINKAGE_DOMAIN_LOGTYPES).toContain(row.logType);
    expect(row.delta).toBeLessThan(0);
    // ...and inside the domain the shared rule buckets it as loss.
    expect(shrinkageReasonOf(row.reasonCode)).toBe("DAMAGE");
  });

  it("an `other` row STAYS in the LOCKED reorder-demand predicate", async () => {
    const { row } = await adjustRow({ intent: "other" });

    expect(
      isReorderDemandRow({
        delta: row.delta,
        logType: row.logType,
        reasonCode: row.reasonCode,
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The workbench manual leg — TWO values only (PLG1-1)
// ---------------------------------------------------------------------------

/** Drive one manual deduction through the REAL route; hand back what it wrote. */
async function deductRow(body: Record<string, unknown>) {
  const tx = makeTx();
  tx.inventory_logs.create.mockResolvedValue({
    id: 1,
    productId: 5,
    delta: -3,
    products: { name: "Widget" },
  } as any);
  driveTxWith(tx);
  const res = await DEDUCT(
    post("http://x/api/inventory/deduct-simple", {
      locationId: 2,
      items: [{ productId: 5, quantity: 3 }],
      ...body,
    })
  );
  expect(res.status).toBe(200);
  expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
  return {
    row: tx.inventory_logs.create.mock.calls[0][0].data as unknown as LedgerRowData,
    details: tx.auditLog.create.mock.calls[0][0].data.details as Record<string, unknown>,
  };
}

describe("deduct-simple — the workbench offers NO damage-loss (PLG1-1)", () => {
  it("the schema itself refuses the value", () => {
    const base = { locationId: 2, items: [{ productId: 5, quantity: 3 }] };
    expect(SimpleDeductSchema.safeParse({ ...base, intent: "damage-loss" }).success).toBe(false);
    expect(SimpleDeductSchema.safeParse({ ...base, intent: "order" }).success).toBe(true);
    expect(SimpleDeductSchema.safeParse({ ...base, intent: "other" }).success).toBe(true);
  });

  it("the ROUTE refuses it too, and writes nothing", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    await expect(
      DEDUCT(
        post("http://x/api/inventory/deduct-simple", {
          locationId: 2,
          items: [{ productId: 5, quantity: 3 }],
          intent: "damage-loss",
        })
      )
    ).rejects.toThrow();

    // The manual leg books SALE rows; a SALE+DAMAGE row would be invisible to
    // getShrinkageSummary (its domain is ADJUSTMENT/CORRECTION only), so the
    // loss would be recorded and then never counted. Refuse, don't half-record.
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("deduct-simple — T7 mapping on the manual leg", () => {
  it("order + a validated id -> orderRecordId stamped on the SALE row", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row, details } = await deductRow({
      intent: "order",
      selectedExternalOrderId: ORDER_CUID,
    });

    expect(row.logType).toBe("SALE");
    expect(row.orderRecordId).toBe(ORDER_CUID);
    expect(row.reasonCode ?? null).toBeNull();
    // 0b-2's audit accrual is UNCHANGED and rides alongside the new column.
    expect(details.selectedExternalOrderId).toBe(ORDER_CUID);
    expect(details.intent).toBe("order");
  });

  it("other -> nothing stamped, even when an order id is present", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row, details } = await deductRow({
      intent: "other",
      selectedExternalOrderId: ORDER_CUID,
    });

    expect(row.orderRecordId ?? null).toBeNull();
    expect(row.reasonCode ?? null).toBeNull();
    // The id was still RESOLVED and membership-checked, and 0b-2's accrual is
    // untouched — the chip decides the LEDGER stamp, not the audit trail.
    expect(details.selectedExternalOrderId).toBe(ORDER_CUID);
  });

  it("an absent key -> legal submit, other/nothing, key ABSENT in the accrual", async () => {
    const { row, details } = await deductRow({});

    expect(row.orderRecordId ?? null).toBeNull();
    expect(row.reasonCode ?? null).toBeNull();
    expect("intent" in details).toBe(false);
  });

  // W2-2 RIDER (pack REV-12): the pin above is a WIRE contract, not a statement
  // about the workbench. Since the rider, that surface PRE-SELECTS `order`
  // whenever a WC order is selected, so it no longer produces a key-absent body
  // in that case (pinned in __tests__/unit/components/workbench-intent-chip.test.tsx).
  // The route's own reading of an absent key is unchanged and still exercised —
  // by a non-WC workbench cart and by any other client of this endpoint — which
  // is exactly why the pin stays.
  it("the ROUTE's default is untouched by the surface's default", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    // The shape the workbench now sends: an explicit `order` alongside the id.
    const stated = await deductRow({ intent: "order", selectedExternalOrderId: ORDER_CUID });
    expect(stated.row.orderRecordId).toBe(ORDER_CUID);

    // The shape it sends with no order in play: nothing stated, nothing stamped.
    const unstated = await deductRow({});
    expect(unstated.row.orderRecordId ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Schema shape (the adjust surface's chip carrier)
// ---------------------------------------------------------------------------

describe("AdjustWithIntentSchema — the chip is optional and closed-vocabulary", () => {
  const base = { productId: 5, locationId: 2, delta: -3 };

  it("accepts every payload that predates the chip", () => {
    expect(AdjustWithIntentSchema.safeParse(base).success).toBe(true);
  });

  it("accepts exactly the three chip values", () => {
    for (const intent of ["order", "damage-loss", "other"]) {
      expect(AdjustWithIntentSchema.safeParse({ ...base, intent }).success).toBe(true);
    }
    expect(AdjustWithIntentSchema.safeParse({ ...base, intent: "recount" }).success).toBe(false);
    expect(AdjustWithIntentSchema.safeParse({ ...base, intent: "receiving" }).success).toBe(false);
    // NEVER a CORRECTION alias — the value does not exist in the vocabulary.
    expect(AdjustWithIntentSchema.safeParse({ ...base, intent: "CORRECTION" }).success).toBe(false);
  });

  it("bounds the order id to external_orders.id's native VarChar(191)", () => {
    expect(
      AdjustWithIntentSchema.safeParse({ ...base, selectedExternalOrderId: "x".repeat(192) }).success
    ).toBe(false);
    expect(
      AdjustWithIntentSchema.safeParse({ ...base, selectedExternalOrderId: "x".repeat(191) }).success
    ).toBe(true);
    expect(
      AdjustWithIntentSchema.safeParse({ ...base, selectedExternalOrderId: "" }).success
    ).toBe(false);
  });
});
