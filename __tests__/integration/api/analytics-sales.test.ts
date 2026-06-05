// @jest-environment node
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireCompanyMembership: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/analytics/queries", () => ({ getSales: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { userCompany: { findMany: jest.fn() } },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/analytics/sales/route";
import { requireApproved, requireCompanyMembership } from "@/lib/api-utils";
import { getSales } from "@/lib/analytics/queries";
import prisma from "@/lib/prisma";

const m = prisma as unknown as { userCompany: { findMany: jest.Mock } };
const getSalesMock = getSales as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test("no companyId => sums across ALL the caller's companies (ownership view)", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }, { companyId: "c2" }]);
  getSalesMock.mockResolvedValue([]);

  const res = await GET(new NextRequest("http://x/api/analytics/sales"));

  expect(res.status).toBe(200);
  // scoped to the caller's OWN memberships, never all companies system-wide
  expect(m.userCompany.findMany).toHaveBeenCalledWith({
    where: { userId: 1 },
    select: { companyId: true },
  });
  expect(getSalesMock).toHaveBeenCalledWith(
    expect.objectContaining({ companyIds: ["c1", "c2"] })
  );
  // membership check is NOT used on the ownership path
  expect(requireCompanyMembership).not.toHaveBeenCalled();
});

test("explicit companyId the caller belongs to => scopes to that one company only", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  getSalesMock.mockResolvedValue([]);

  const res = await GET(new NextRequest("http://x/api/analytics/sales?companyId=c1"));

  expect(res.status).toBe(200);
  expect(requireCompanyMembership).toHaveBeenCalledWith(1, "c1", false);
  expect(getSalesMock).toHaveBeenCalledWith(
    expect.objectContaining({ companyIds: ["c1"] })
  );
  // must NOT fall back to enumerating the caller's memberships
  expect(m.userCompany.findMany).not.toHaveBeenCalled();
});

test("explicit companyId the caller does NOT belong to => 404 propagated, getSales NOT called (hard isolation)", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  const notFound: any = new Error("Resource not found");
  notFound.code = "NOT_FOUND";
  notFound.statusCode = 404;
  (requireCompanyMembership as jest.Mock).mockRejectedValue(notFound);

  // apiHandler is mocked as identity here, so the AppError propagates out of GET.
  // In production apiHandler maps AppError -> errorResponse(message, 404, code).
  await expect(
    GET(new NextRequest("http://x/api/analytics/sales?companyId=other"))
  ).rejects.toMatchObject({ statusCode: 404 });

  // the headline guarantee: a non-member must NEVER reach the data layer
  expect(getSalesMock).not.toHaveBeenCalled();
});

test("caller with zero companies => empty series, no leak, never an error", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([]);
  // getSales contract: empty companyIds -> [] (hard isolation). Mirror it.
  getSalesMock.mockResolvedValue([]);

  const res = await GET(new NextRequest("http://x/api/analytics/sales"));

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.series).toEqual([]);
  // never leak: companyIds passed must be the empty set (or getSales not called at all)
  if (getSalesMock.mock.calls.length > 0) {
    expect(getSalesMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyIds: [] })
    );
  }
});

test("groupBy=company is passed through to getSales", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  getSalesMock.mockResolvedValue([]);

  const res = await GET(
    new NextRequest("http://x/api/analytics/sales?groupBy=company")
  );

  expect(res.status).toBe(200);
  expect(getSalesMock).toHaveBeenCalledWith(
    expect.objectContaining({ groupBy: "company" })
  );
  const body = await res.json();
  expect(body.groupBy).toBe("company");
});

test("groupBy=bogus is rejected: defaults to 'product', getSales gets 'product', no 500", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  getSalesMock.mockResolvedValue([]);

  const res = await GET(
    new NextRequest("http://x/api/analytics/sales?groupBy=bogus")
  );

  expect(res.status).toBe(200);
  // an invalid groupBy must NOT reach getSales (it would 500 in prisma.groupBy({by:undefined}))
  expect(getSalesMock).toHaveBeenCalledWith(
    expect.objectContaining({ groupBy: "product" })
  );
  const body = await res.json();
  expect(body.groupBy).toBe("product");
});

test("missing groupBy defaults to 'product'", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  getSalesMock.mockResolvedValue([]);

  const res = await GET(new NextRequest("http://x/api/analytics/sales"));

  expect(res.status).toBe(200);
  expect(getSalesMock).toHaveBeenCalledWith(
    expect.objectContaining({ groupBy: "product" })
  );
});

test("serializes the Decimal revenue sum cleanly (no raw Prisma Decimal object)", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  // Simulate a Prisma Decimal: an object whose toString() yields the value.
  const decimal = { toString: () => "123.45" };
  getSalesMock.mockResolvedValue([
    {
      productId: 7,
      _sum: { orderedQty: 3, fulfilledQty: 2, revenue: decimal, orderCount: 1 },
    },
  ]);

  const res = await GET(new NextRequest("http://x/api/analytics/sales"));
  const body = await res.json();

  expect(res.status).toBe(200);
  expect(body.series[0]._sum.revenue).toBe("123.45");
  // other sums are untouched
  expect(body.series[0]._sum.orderedQty).toBe(3);
  expect(body.series[0].productId).toBe(7);
});
