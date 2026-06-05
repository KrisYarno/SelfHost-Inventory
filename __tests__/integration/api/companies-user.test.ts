// @jest-environment node
//
// Covers GET /api/companies/user, focusing on the ADDITIVE ?membershipsOnly=1 flag (ER-D3):
//   - default (no flag): admin with ZERO memberships gets the admin-sees-all list (UNCHANGED).
//   - ?membershipsOnly=1: that same admin gets ONLY their actual memberships (empty here),
//     so the analytics company-scope picker equals the rollup source.
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    userCompany: { findMany: jest.fn() },
    company: { findMany: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/companies/user/route";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  userCompany: { findMany: jest.Mock };
  company: { findMany: jest.Mock };
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("default (no flag): non-admin returns only their member companies", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  m.company.findMany.mockResolvedValue([{ id: "c1", name: "Acme", slug: "acme" }]);

  const res = await GET(new NextRequest("http://x/api/companies/user"));
  const body = await res.json();

  expect(body.companies).toEqual([{ id: "c1", name: "Acme", slug: "acme" }]);
  // Scoped to the caller's memberships, never the admin-sees-all branch.
  expect(m.company.findMany).toHaveBeenCalledTimes(1);
  expect(m.company.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["c1"] } });
});

test("default (no flag): zero-membership ADMIN gets the admin-sees-all list (UNCHANGED)", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 9, isAdmin: true } });
  m.userCompany.findMany.mockResolvedValue([]); // no memberships
  // 2nd findMany (admin-sees-all) returns every company.
  m.company.findMany.mockResolvedValue([
    { id: "c1", name: "Acme", slug: "acme" },
    { id: "c2", name: "Globex", slug: "globex" },
  ]);

  const res = await GET(new NextRequest("http://x/api/companies/user"));
  const body = await res.json();

  // Admin convenience kicks in: all companies returned.
  expect(body.companies).toHaveLength(2);
  // The admin-sees-all call has no id filter (selects every company).
  const lastCall = m.company.findMany.mock.calls.at(-1)![0];
  expect(lastCall.where).toBeUndefined();
});

test("?membershipsOnly=1: zero-membership ADMIN gets ONLY memberships (skips admin-sees-all)", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 9, isAdmin: true } });
  m.userCompany.findMany.mockResolvedValue([]); // no memberships
  m.company.findMany.mockResolvedValue([]);

  const res = await GET(new NextRequest("http://x/api/companies/user?membershipsOnly=1"));
  const body = await res.json();

  // The picker source equals the rollup source: an admin with no memberships sees an empty list.
  expect(body.companies).toEqual([]);
  // The admin-sees-all branch must NOT run: no unfiltered company.findMany call.
  for (const call of m.company.findMany.mock.calls) {
    expect(call[0]?.where).toBeDefined();
  }
});

test("?membershipsOnly=1: admin WITH memberships still returns just those memberships", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 9, isAdmin: true } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c2" }]);
  m.company.findMany.mockResolvedValue([{ id: "c2", name: "Globex", slug: "globex" }]);

  const res = await GET(new NextRequest("http://x/api/companies/user?membershipsOnly=1"));
  const body = await res.json();

  expect(body.companies).toEqual([{ id: "c2", name: "Globex", slug: "globex" }]);
  expect(m.company.findMany).toHaveBeenCalledTimes(1);
  expect(m.company.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["c2"] } });
});
