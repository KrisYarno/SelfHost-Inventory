// @jest-environment node
jest.mock("@/lib/api-utils", () => ({ requireCompanyMembership: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { userCompany: { findMany: jest.fn() } },
}));

import {
  resolveCallerCompanyIds,
  serializeSalesRows,
} from "@/lib/analytics/company-scope";
import { requireCompanyMembership } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

const m = prisma as unknown as { userCompany: { findMany: jest.Mock } };

beforeEach(() => jest.clearAllMocks());

describe("resolveCallerCompanyIds", () => {
  test("explicit companyId (member) => membership-checked, scopes to that one company", async () => {
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    const ids = await resolveCallerCompanyIds({ id: 1, isAdmin: false }, "c1");
    expect(requireCompanyMembership).toHaveBeenCalledWith(1, "c1", false);
    expect(ids).toEqual(["c1"]);
    // must NOT enumerate memberships on the explicit path
    expect(m.userCompany.findMany).not.toHaveBeenCalled();
  });

  test("explicit companyId (non-member) => throws, never enumerates memberships", async () => {
    const notFound: any = new Error("Resource not found");
    notFound.statusCode = 404;
    (requireCompanyMembership as jest.Mock).mockRejectedValue(notFound);
    await expect(
      resolveCallerCompanyIds({ id: 1, isAdmin: false }, "other")
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(m.userCompany.findMany).not.toHaveBeenCalled();
  });

  test("no companyId => sums the caller's OWN memberships (ER-D3)", async () => {
    m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }, { companyId: "c2" }]);
    const ids = await resolveCallerCompanyIds({ id: 7, isAdmin: false }, null);
    expect(m.userCompany.findMany).toHaveBeenCalledWith({
      where: { userId: 7 },
      select: { companyId: true },
    });
    expect(ids).toEqual(["c1", "c2"]);
    expect(requireCompanyMembership).not.toHaveBeenCalled();
  });

  test("no companyId + zero memberships => [] (hard isolation)", async () => {
    m.userCompany.findMany.mockResolvedValue([]);
    const ids = await resolveCallerCompanyIds({ id: 1, isAdmin: false }, null);
    expect(ids).toEqual([]);
  });
});

describe("serializeSalesRows", () => {
  test("Decimal revenue sum => string; other fields untouched", () => {
    const decimal = { toString: () => "123.45" };
    const out = serializeSalesRows([
      { productId: 7, _sum: { orderedQty: 3, fulfilledQty: 2, revenue: decimal, orderCount: 1 } },
    ]) as any[];
    expect(out[0]._sum.revenue).toBe("123.45");
    expect(out[0]._sum.orderedQty).toBe(3);
    expect(out[0].productId).toBe(7);
  });

  test("rows without a revenue sum pass through unchanged", () => {
    const row = { dayKey: "2026-07-08", _sum: { orderedQty: 5, revenue: null } };
    const out = serializeSalesRows([row]) as any[];
    expect(out[0]).toEqual(row);
  });

  test("rows without _sum at all pass through unchanged", () => {
    const row = { integrationId: "i1" };
    const out = serializeSalesRows([row]) as any[];
    expect(out[0]).toBe(row);
  });
});
