// @jest-environment node
//
// Lane 5 (L-POLISH) source/behavior gates:
//   - U4: no page under app/(app) declares its own <main> — the app shell owns
//     the single page <main>. This is a SOURCE-SCAN (the render-count shell test
//     would pass vacuously since page files aren't mounted inside it here).
//   - U9: the revenue-caveat note is a single shared constant, and BOTH analytics
//     routes' responses carry that exact constant.

import fs from "fs";
import path from "path";

// --- U9 route execution: mock the data layer so the handlers just build JSON ---
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireApproved: jest.fn(async () => ({ user: { id: 1, isAdmin: true } })),
}));
jest.mock("@/lib/analytics/queries", () => ({
  getSales: jest.fn(async () => []),
  getStockSeries: jest.fn(async () => []),
}));
jest.mock("@/lib/analytics/company-scope", () => ({
  resolveCallerCompanyIds: jest.fn(async () => []),
  serializeSalesRows: jest.fn((rows: unknown) => rows),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findUnique: jest.fn(async () => ({ name: "P", baseName: null, variant: null })) },
    product_locations: { aggregate: jest.fn(async () => ({ _sum: { quantity: 0 } })) },
  },
}));

import { NextRequest } from "next/server";
import { GET as salesGET } from "@/app/api/analytics/sales/route";
import { GET as productGET } from "@/app/api/analytics/product/[id]/route";
import { REVENUE_CAVEAT_NOTE } from "@/lib/analytics/constants";

// U4 fence: ONLY these two pages are in scope (spec U4 = /workbench + /analytics).
// Other app/(app) pages that also nest <main> are a pre-existing landmark issue
// out of L-POLISH's fence — SEAMS-reported, not fixed here.
const U4_PAGES = [
  path.join(process.cwd(), "app", "(app)", "workbench", "page.tsx"),
  path.join(process.cwd(), "app", "(app)", "analytics", "page.tsx"),
];

// A real opening <main> JSX tag (element or self-close) — not "mainClass" and
// not the literal inside a comment (the source carries none after the fix).
const OPEN_MAIN = /<main[\s/>]/;

describe("U4: the two fenced pages use <section>, never a nested <main>", () => {
  test.each(U4_PAGES.map((f) => [path.relative(process.cwd(), f), f]))(
    "%s replaced its page-level <main> with a labelled <section>",
    (_rel, file) => {
      const src = fs.readFileSync(file as string, "utf8");
      expect(src).not.toMatch(OPEN_MAIN);
      expect(src).toMatch(/<section aria-label=/);
    },
  );
});

describe("U9: both analytics responses carry the shared revenue-caveat constant", () => {
  test("the constant is a non-empty string", () => {
    expect(typeof REVENUE_CAVEAT_NOTE).toBe("string");
    expect(REVENUE_CAVEAT_NOTE.length).toBeGreaterThan(0);
  });

  test("GET /api/analytics/sales returns note === REVENUE_CAVEAT_NOTE", async () => {
    const res = await salesGET(new NextRequest("http://x/api/analytics/sales"));
    const body = await res.json();
    expect(body.note).toBe(REVENUE_CAVEAT_NOTE);
  });

  test("GET /api/analytics/product/[id] returns sales.note === REVENUE_CAVEAT_NOTE", async () => {
    const res = await productGET(new NextRequest("http://x/api/analytics/product/5"), {
      params: { id: "5" },
    });
    const body = await res.json();
    expect(body.sales.note).toBe(REVENUE_CAVEAT_NOTE);
  });

  test("neither route still inlines the literal (DRY — one source of truth)", () => {
    const salesSrc = fs.readFileSync(
      path.join(process.cwd(), "app", "api", "analytics", "sales", "route.ts"),
      "utf8",
    );
    const productSrc = fs.readFileSync(
      path.join(process.cwd(), "app", "api", "analytics", "product", "[id]", "route.ts"),
      "utf8",
    );
    for (const src of [salesSrc, productSrc]) {
      expect(src).toContain("REVENUE_CAVEAT_NOTE");
      expect(src).not.toContain("bundle revenue is not represented");
    }
  });
});
