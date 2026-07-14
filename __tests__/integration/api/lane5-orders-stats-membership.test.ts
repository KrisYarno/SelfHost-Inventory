/**
 * @jest-environment node
 *
 * Lane 5 S6 — orders/external/stats membership guard returns the anti-enumeration
 * 404 (was a manual 403). Uses the REAL apiHandler + REAL requireCompanyMembership
 * so the AppError→HTTP mapping is exercised end to end; only requireApproved and
 * prisma are stubbed.
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    userCompany: { findFirst: jest.fn(), findMany: jest.fn() },
    externalOrder: { groupBy: jest.fn() },
  },
}));

jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { ...actual, requireApproved: jest.fn() };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved } from "@/lib/api-utils";
import { GET as STATS_GET } from "@/app/api/orders/external/stats/route";

const db = prisma as unknown as {
  userCompany: { findFirst: jest.Mock; findMany: jest.Mock };
  externalOrder: { groupBy: jest.Mock };
};

function req(companyId?: string) {
  const url = companyId
    ? `http://x/api/orders/external/stats?companyId=${companyId}`
    : "http://x/api/orders/external/stats";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.externalOrder.groupBy.mockResolvedValue([]);
});

describe("S6 stats membership guard", () => {
  it("non-member requesting a specific company → 404 (not 403), no groupBy", async () => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 5, isAdmin: false } });
    db.userCompany.findFirst.mockResolvedValue(null); // not a member

    const res = await STATS_GET(req("other-co"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
    expect(db.externalOrder.groupBy).not.toHaveBeenCalled();
  });

  it("member requesting their company → 200", async () => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 5, isAdmin: false } });
    db.userCompany.findFirst.mockResolvedValue({ userId: 5 });

    const res = await STATS_GET(req("my-co"));
    expect(res.status).toBe(200);
  });

  it("admin bypasses the membership lookup entirely → 200", async () => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: true } });

    const res = await STATS_GET(req("any-co"));
    expect(res.status).toBe(200);
    expect(db.userCompany.findFirst).not.toHaveBeenCalled();
  });
});
