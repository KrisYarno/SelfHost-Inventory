// @jest-environment node
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    analyticsRebuildState: { findUnique: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/analytics/rebuild-state/route";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  analyticsRebuildState: { findUnique: jest.Mock };
};

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
});

test("requireApproved gates the route", async () => {
  m.analyticsRebuildState.findUnique.mockResolvedValue(null);
  await GET(new NextRequest("http://localhost/api/analytics/rebuild-state"));
  expect(requireApproved).toHaveBeenCalled();
});

test("reads the GLOBAL 'sales' rebuild row and returns { unattributed, lastRunAt }", async () => {
  const lastRunAt = new Date("2026-06-05T00:00:00.000Z");
  m.analyticsRebuildState.findUnique.mockResolvedValue({ unattributed: 7, lastRunAt });
  const res = await GET(new NextRequest("http://localhost/api/analytics/rebuild-state"));
  const body = await res.json();
  expect(m.analyticsRebuildState.findUnique).toHaveBeenCalledWith({
    where: { job: "sales" },
    select: { unattributed: true, lastRunAt: true },
  });
  expect(body.unattributed).toBe(7);
  expect(body.lastRunAt).toBe(lastRunAt.toISOString());
});

test("no rebuild row yet => defaults to { unattributed: 0, lastRunAt: null } (pre-backfill safe)", async () => {
  m.analyticsRebuildState.findUnique.mockResolvedValue(null);
  const res = await GET(new NextRequest("http://localhost/api/analytics/rebuild-state"));
  const body = await res.json();
  expect(body).toEqual({ unattributed: 0, lastRunAt: null });
});
