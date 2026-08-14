// @jest-environment node
//
// REFERENCE-RESOLUTION ROUND — the LIVE slice, pinned AT THE ROUTE.
//
// The prod backfill run proved the 0b-2 premise unmet: `selectedExternalOrderId`
// has never once been written (0 of 1,897 events), because packers do not pick
// an order in the workbench — they TYPE the Woo order number into the free-text
// field. All 10 distinct prod references resolve exactly against
// `external_orders.orderNumber`. Post-W2 the pattern continues: the workbench's
// intent chip only renders when a WC order is selected, so the free-text flow
// still sends no chip at all.
//
// So deduct-simple resolves the reference ITSELF, under three conditions, and
// the pins below are those three conditions plus the two ways it must decline:
//
//   (a) no structured id came        — the stronger evidence always wins;
//   (b) no explicit NON-order intent — an operator who said `other` is answered,
//                                      not overruled. An ABSENT chip is not that
//                                      answer: it is the free-text flow, which
//                                      never showed one;
//   (c) the trimmed reference equals EXACTLY ONE order number.
//
// Anything else keeps today's behaviour EXACTLY: the free text is accrued into
// the audit event and no column is stamped, which is what W3's matcher inherits.
// A membership failure is in that group — the deduction is legal and commits;
// only the attribution is withheld.
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
// `mockDeep` is hoist-safe by name (the w2-intent-chip idiom), so the factory
// needs no require() — the lint profile forbids one.
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved, requireCompanyMembership, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { POST as DEDUCT } from "@/app/api/inventory/deduct-simple/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const ORDER_A = "cmdq7f3k80001s6h4p2n9wxyz";
const ORDER_B = "cmdq7f3k80099s6h4p2n9zzzz";
const COMPANY_ID = "company-abc";
const REF = "12345";

type LedgerRowData = {
  logType: string;
  reasonCode: string | null;
  orderRecordId: string | null;
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
    id: 1,
    productId: 5,
    delta: -3,
    products: { name: "Widget" },
  } as any);
  tx.product.findUnique.mockResolvedValue({ id: 5, name: "Widget" } as any);
  tx.product.update.mockResolvedValue({} as any);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  return tx;
}

/** Drive one manual deduction through the REAL route; hand back what it wrote. */
async function deductRow(body: Record<string, unknown>) {
  const tx = makeTx();
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
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

const candidate = (id: string, orderNumber: string, companyId = COMPANY_ID) => ({
  id,
  orderNumber,
  companyId,
});

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
  db.product_locations.findUnique.mockResolvedValue({ quantity: 100, version: 1 } as any);
  db.product.findUnique.mockResolvedValue({ name: "Widget" } as any);
});

// ---------------------------------------------------------------------------
// PIN 1 — a unique match attributes, and says how
// ---------------------------------------------------------------------------

describe("PIN 1 — a unique-matching reference stamps the ledger row", () => {
  it("stamps the resolved order with NO chip at all (the free-text flow)", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, REF)] as any);

    const { row, details } = await deductRow({ orderReference: REF });

    expect(row.logType).toBe("SALE");
    expect(row.orderRecordId).toBe(ORDER_A);
    // The audit event says WHICH evidence attributed it. Without this an
    // operator reading a stamped row cannot tell a picked order from a resolved
    // one, and the two carry different confidence.
    expect(details.orderAttributionSource).toBe("reference-resolved");
    // The free text is still accrued, exactly as before.
    expect(details.orderReference).toBe(REF);
    expect("selectedExternalOrderId" in details).toBe(false);
    // Membership was proven against the RESOLVED order's company.
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, COMPANY_ID, false);
  });

  it("stamps it under an explicit `order` intent too", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, REF)] as any);

    const { row, details } = await deductRow({ orderReference: REF, intent: "order" });

    expect(row.orderRecordId).toBe(ORDER_A);
    expect(details.orderAttributionSource).toBe("reference-resolved");
    expect(details.intent).toBe("order");
  });

  it("looks the reference up by its TRIMMED value", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, REF)] as any);

    await deductRow({ orderReference: `  ${REF}  ` });

    expect(db.externalOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderNumber: REF } })
    );
  });

  it("stamps the ORDER ID, never the typed string", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, REF)] as any);

    const { row } = await deductRow({ orderReference: REF });

    expect(row.orderRecordId).not.toBe(REF);
    expect(row.orderRecordId).toBe(ORDER_A);
  });
});

// ---------------------------------------------------------------------------
// PIN 2 — a stated non-order intent is an answer, not a gap
// ---------------------------------------------------------------------------

describe("PIN 2 — an explicit non-order intent blocks the resolution entirely", () => {
  it("`other` + a unique match stamps NOTHING, and never even looks", async () => {
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, REF)] as any);

    const { row, details } = await deductRow({ orderReference: REF, intent: "other" });

    expect(row.orderRecordId ?? null).toBeNull();
    expect("orderAttributionSource" in details).toBe(false);
    // Not merely unstamped: the lookup is not performed. The operator's answer
    // settles the question before any evidence is gathered.
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
    // Their words are still accrued.
    expect(details.orderReference).toBe(REF);
    expect(details.intent).toBe("other");
  });

  it("`damage-loss` is still refused by the schema, reference or not", async () => {
    const tx = makeTx();
    (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(tx));

    await expect(
      DEDUCT(
        post("http://x/api/inventory/deduct-simple", {
          locationId: 2,
          items: [{ productId: 5, quantity: 3 }],
          orderReference: REF,
          intent: "damage-loss",
        })
      )
    ).rejects.toThrow();

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PIN 3 — ambiguity keeps today's behaviour exactly
// ---------------------------------------------------------------------------

describe("PIN 3 — an ambiguous or unmatched reference is accrued, not attributed", () => {
  it("two orders sharing the number: no stamp, the accrual unchanged", async () => {
    db.externalOrder.findMany.mockResolvedValue([
      candidate(ORDER_A, REF),
      candidate(ORDER_B, REF, "company-other"),
    ] as any);

    const { row, details } = await deductRow({ orderReference: REF });

    expect(row.orderRecordId ?? null).toBeNull();
    expect("orderAttributionSource" in details).toBe(false);
    expect(details.orderReference).toBe(REF);
    // Never a membership probe on an order we could not identify.
    expect(requireCompanyMembership).not.toHaveBeenCalled();
  });

  it("a reference matching nothing: no stamp, the deduction still commits", async () => {
    db.externalOrder.findMany.mockResolvedValue([] as any);

    const { row, details } = await deductRow({ orderReference: "99999" });

    expect(row.orderRecordId ?? null).toBeNull();
    expect(details.orderReference).toBe("99999");
  });

  it("free text that is not an order number never reaches the database", async () => {
    const { row, details } = await deductRow({ orderReference: "walk-in 88" });

    expect(row.orderRecordId ?? null).toBeNull();
    expect(details.orderReference).toBe("walk-in 88");
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PIN 4 — a membership failure withholds the STAMP, never the deduction
// ---------------------------------------------------------------------------

describe("PIN 4 — a resolved order in another company does not fail the request", () => {
  it("commits the deduction, stamps nothing, and names no source", async () => {
    db.externalOrder.findMany.mockResolvedValue([
      candidate(ORDER_B, REF, "company-other"),
    ] as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError("Resource not found", "NOT_FOUND", 404)
    );

    const { row, details } = await deductRow({ orderReference: REF });

    // The stock movement is real and legal — it has always been legal. The 400
    // the sibling resolver throws is for a CLIENT-SUPPLIED ID; this is a packer
    // typing a number, and refusing their deduction to protect a column would
    // trade a working warehouse for an attribution.
    expect(row.orderRecordId ?? null).toBeNull();
    expect("orderAttributionSource" in details).toBe(false);
    expect(details.orderReference).toBe(REF);
  });

  it("says nothing about the order it declined to attribute", async () => {
    db.externalOrder.findMany.mockResolvedValue([
      candidate(ORDER_B, REF, "company-other"),
    ] as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError("Resource not found", "NOT_FOUND", 404)
    );

    const { details } = await deductRow({ orderReference: REF });

    // No id, no company, no outcome token: a foreign order's existence is not
    // reported into an audit row an approved user of another company can read.
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain(ORDER_B);
    expect(serialized).not.toContain("company-other");
  });
});

// ---------------------------------------------------------------------------
// The structured path still wins, and still behaves exactly as W2-1 left it
// ---------------------------------------------------------------------------

describe("the structured id outranks the reference", () => {
  it("stamps the SELECTED id and never resolves the reference", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row, details } = await deductRow({
      orderReference: REF,
      selectedExternalOrderId: ORDER_A,
      intent: "order",
    });

    expect(row.orderRecordId).toBe(ORDER_A);
    expect(details.orderAttributionSource).toBe("selected");
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });

  it("a forged id still aborts the whole request — the reference is no fallback", async () => {
    db.externalOrder.findUnique.mockResolvedValue(null as any);
    db.externalOrder.findMany.mockResolvedValue([candidate(ORDER_A, REF)] as any);

    await expect(
      DEDUCT(
        post("http://x/api/inventory/deduct-simple", {
          locationId: 2,
          items: [{ productId: 5, quantity: 3 }],
          orderReference: REF,
          selectedExternalOrderId: "not-a-real-order-id",
          intent: "order",
        })
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("a deduction with no reference at all is untouched by any of this", async () => {
    const { row, details } = await deductRow({});

    expect(row.orderRecordId ?? null).toBeNull();
    expect("orderAttributionSource" in details).toBe(false);
    expect("orderReference" in details).toBe(false);
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });
});
