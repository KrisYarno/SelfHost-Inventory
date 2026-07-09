// @jest-environment node
//
// Focused test for the admin settings route's system-setting toggles. Mirrors
// the cron test's mocking approach: requireAdmin + CSRF are stubbed so the test
// targets ONLY the GET read-back and the POST upsert behavior for the two
// boolean SystemSettings (weeklyReportsEnabled + analyticsRebuildEnabled).
jest.mock("@/lib/api-utils", () => ({
  // Real module first: requireCSRF (driven by the mocked validateCSRFToken)
  // and the REAL apiHandler, so the invalid-CSRF test still observes the
  // mapped 403 response.
  ...jest.requireActual("@/lib/api-utils"),
  requireAdmin: jest.fn(() => Promise.resolve()),
}));
jest.mock("@/lib/csrf", () => ({
  validateCSRFToken: jest.fn(() => Promise.resolve(true)),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    location: { findMany: jest.fn(() => Promise.resolve([])) },
    systemSetting: { findUnique: jest.fn(), upsert: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/admin/settings/route";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";

const m = prisma as unknown as {
  location: { findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock; upsert: jest.Mock };
};
const csrfMock = validateCSRFToken as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  csrfMock.mockResolvedValue(true);
});

function getReq(): NextRequest {
  return new NextRequest("http://x/api/admin/settings");
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://x/api/admin/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET returns both flags as booleans derived from SystemSetting values", async () => {
  m.systemSetting.findUnique.mockImplementation(({ where }: any) => {
    if (where.key === "weeklyReportsEnabled") return Promise.resolve({ value: "true" });
    if (where.key === "analyticsRebuildEnabled") return Promise.resolve({ value: "false" });
    return Promise.resolve(null);
  });

  const res = await GET(getReq());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.weeklyReportsEnabled).toBe(true);
  expect(body.analyticsRebuildEnabled).toBe(false);
  // missing setting => false
  m.systemSetting.findUnique.mockResolvedValue(null);
  const res2 = await GET(getReq());
  const body2 = await res2.json();
  expect(body2.analyticsRebuildEnabled).toBe(false);
});

test("POST analyticsRebuildEnabled:true upserts the analyticsRebuildEnabled SystemSetting with String(value)", async () => {
  const res = await POST(postReq({ analyticsRebuildEnabled: true }));
  expect(res.status).toBe(200);
  expect(m.systemSetting.upsert).toHaveBeenCalledWith({
    where: { key: "analyticsRebuildEnabled" },
    update: { value: "true" },
    create: { key: "analyticsRebuildEnabled", value: "true" },
  });
});

test("POST analyticsRebuildEnabled:false upserts value 'false'", async () => {
  await POST(postReq({ analyticsRebuildEnabled: false }));
  expect(m.systemSetting.upsert).toHaveBeenCalledWith({
    where: { key: "analyticsRebuildEnabled" },
    update: { value: "false" },
    create: { key: "analyticsRebuildEnabled", value: "false" },
  });
});

test("POST without analyticsRebuildEnabled does NOT upsert it (only weekly handled)", async () => {
  await POST(postReq({ weeklyReportsEnabled: true }));
  // weekly upsert happened, analytics one did not
  expect(m.systemSetting.upsert).toHaveBeenCalledTimes(1);
  expect(m.systemSetting.upsert).toHaveBeenCalledWith({
    where: { key: "weeklyReportsEnabled" },
    update: { value: "true" },
    create: { key: "weeklyReportsEnabled", value: "true" },
  });
});

test("POST with non-boolean analyticsRebuildEnabled is rejected by the schema (400, no upsert)", async () => {
  // SystemSettingsSchema types both flags as booleans, so a non-boolean now
  // fails validation (400) instead of being silently ignored — either way, no
  // SystemSetting is written.
  const res = await POST(postReq({ analyticsRebuildEnabled: "yes" }));
  expect(res.status).toBe(400);
  expect(m.systemSetting.upsert).not.toHaveBeenCalled();
});

test("POST with an empty body validates and no-ops (200, no upsert)", async () => {
  const res = await POST(postReq({}));
  expect(res.status).toBe(200);
  expect(m.systemSetting.upsert).not.toHaveBeenCalled();
});

test("POST with invalid CSRF => 403, no upsert", async () => {
  csrfMock.mockResolvedValue(false);
  const res = await POST(postReq({ analyticsRebuildEnabled: true }));
  expect(res.status).toBe(403);
  expect(m.systemSetting.upsert).not.toHaveBeenCalled();
});
