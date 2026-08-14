// @jest-environment node
//
// W2-1 (contract pack REV-11 T7) — the 0b-2 order resolver, EXTRACTED.
//
// The function moved out of app/api/inventory/deduct-simple/route.ts so the
// adjust surface's chip can reuse the exact same membership-validated lookup.
// One home, one decision: the moment two routes each grow their own version of
// "prove the caller may reference this order", one of them is wrong.
//
// The extraction is BEHAVIOUR-PRESERVING and pinned as such here:
//   - both failure modes (no such order / a company you are not in) collapse
//     into ONE 400 VALIDATION_ERROR — never a 404, never a 403, so the route
//     cannot become an order-id existence oracle;
//   - the membership decision itself is DELEGATED to requireCompanyMembership
//     and never re-implemented;
//   - a non-AppError (a real DB fault) propagates untouched.
//
// deduct-simple's own route-level 0b-2 pins live in
// __tests__/integration/api/change-tracking-ledger-semantics.test.ts and are
// deliberately left alone: they are the no-change proof for this extraction.
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireCompanyMembership: jest.fn(),
}));
// `mockDeep` is hoist-safe by name (jest allows out-of-scope bindings prefixed
// `mock`), so the factory needs no require() — the lint profile forbids one.
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));

import { mockDeep, type DeepMockProxy } from "jest-mock-extended";
import prisma from "@/lib/prisma";
import { requireCompanyMembership } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { resolveSelectedExternalOrderId } from "@/lib/orders/resolve-selected-order";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const ORDER_CUID = "cmdq7f3k80001s6h4p2n9wxyz";
const USER = { id: 7, isAdmin: false };

beforeEach(() => {
  jest.clearAllMocks();
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
});

describe("resolveSelectedExternalOrderId", () => {
  it("returns the id when the order resolves and the caller is a member", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: "company-abc" } as any);

    await expect(resolveSelectedExternalOrderId(ORDER_CUID, USER)).resolves.toBe(ORDER_CUID);

    expect(db.externalOrder.findUnique).toHaveBeenCalledWith({
      where: { id: ORDER_CUID },
      select: { companyId: true },
    });
    // The ONE membership predicate, called with the RESOLVED company.
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, "company-abc", false);
  });

  it("rejects an id that resolves to nothing with 400 VALIDATION_ERROR", async () => {
    db.externalOrder.findUnique.mockResolvedValue(null as any);

    await expect(resolveSelectedExternalOrderId("nope", USER)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(requireCompanyMembership).not.toHaveBeenCalled();
  });

  it("rejects a foreign company's order with the IDENTICAL 400 (no existence oracle)", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: "company-other" } as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError("Resource not found", "NOT_FOUND", 404)
    );

    const foreign = resolveSelectedExternalOrderId(ORDER_CUID, USER);
    await expect(foreign).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
  });

  it("lets a non-AppError fault propagate untouched (a DB outage is not a bad payload)", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: "company-abc" } as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(new TypeError("connection lost"));

    await expect(resolveSelectedExternalOrderId(ORDER_CUID, USER)).rejects.toBeInstanceOf(TypeError);
  });

  it("passes the caller's admin flag through rather than deciding admin-ness itself", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: "company-abc" } as any);

    await resolveSelectedExternalOrderId(ORDER_CUID, { id: 9, isAdmin: true });

    expect(requireCompanyMembership).toHaveBeenCalledWith(9, "company-abc", true);
  });
});
