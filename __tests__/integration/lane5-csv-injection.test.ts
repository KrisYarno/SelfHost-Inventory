/**
 * @jest-environment node
 *
 * Lane 5 S7 — CSV formula-injection neutralization, end to end through a real
 * server export route. A product whose name is a spreadsheet formula (=cmd())
 * must leave the route with a leading ' so Excel/Sheets treat it as text.
 */

jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(async () => ({ user: { id: 1, isAdmin: true } })),
}));

jest.mock("@/lib/change-tracking", () => ({
  recordChange: jest.fn(async () => undefined),
}));

jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: (resp: any) => resp,
}));

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn() },
    location: { findMany: jest.fn() },
    $transaction: jest.fn(async (cb: any) => cb({})),
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { GET as EXPORT_GET } from "@/app/api/inventory/export/route";

const db = prisma as unknown as {
  product: { findMany: jest.Mock };
  location: { findMany: jest.Mock };
};

describe("inventory export route neutralizes formula-injection product names", () => {
  it("prefixes a =cmd() product name with ' before streaming the CSV", async () => {
    db.location.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([
      {
        name: "=cmd()",
        baseName: "BPC",
        variant: "5mg",
        product_locations: [],
      },
    ]);

    const res = await EXPORT_GET(
      new NextRequest("http://x/api/inventory/export", { method: "GET" })
    );
    expect(res.status).toBe(200);
    const csv = await res.text();

    // Neutralized: the cell is prefixed with ' inside its RFC-4180 quotes.
    expect(csv).toContain("\"'=cmd()\"");
    // A raw quoted formula ("=cmd) must NOT appear anywhere.
    expect(csv.includes('"=cmd')).toBe(false);
  });
});
