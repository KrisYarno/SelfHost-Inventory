/**
 * @jest-environment node
 *
 * The middleware's per-IP limit for the ORDER SEARCH (reconciliation Part 2,
 * FR-R2 (1), QA-1).
 *
 * The order number field asks the search up to once per digit at phone typing
 * speed, and every bench device behind one office IP shares the middleware's
 * per-IP, per-pathname bucket. At the default 30/min a few typed removals a
 * minute were answered 429. So the exact pathname
 * `/api/reconciliation/orders/search` gets 240/min; a deeper path under it keeps
 * 30 (an exact match, never a prefix), as does every path not overridden below.
 *
 * The route's own per-user 60/min is a separate bucket and is unchanged; it is
 * pinned at the route (`reconciliation-attribution-routes.test.ts`, "is
 * rate-limited PER USER at 60" and "the 61st search inside the window is a 429").
 *
 * P2-B3-2 (Kris 2026-11-16): the STOCKTAKE paths — the adjust route's save and the
 * list reads every successful save refreshes on the dialog's two host pages
 * (`/api/inventory/variants` 480 — an infinite list refreshes every loaded page;
 * whichever of `/api/inventory/logs` / `/api/inventory/transfers` backs the tab
 * on screen, and `/api/products/optimized`, 120; the save 120), plus the token
 * fetch a tagless tab makes per dialog open (`/api/csrf` 240) — by the same
 * exact-match rule. The "every other path keeps
 * 30" examples use `/api/locations`, which is in no list.
 *
 * The REAL limiter runs (its in-process store); each test uses its own IP so no
 * bucket bleeds into another. `getToken` answers an approved member, so a request
 * that passes the limiter reaches `NextResponse.next()`.
 */

jest.mock("next-auth/jwt", () => ({
  getToken: jest.fn(async () => ({ isApproved: true, isAdmin: false })),
}));

import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const SEARCH = "/api/reconciliation/orders/search";

let ipSequence = 0;
/** A documentation-range address no other test in this file uses. */
const freshIp = () => `203.0.113.${++ipSequence}`;

function request(pathname: string, ip: string) {
  return middleware(
    new NextRequest(`http://localhost${pathname}?q=2010`, { headers: { "x-forwarded-for": ip } }),
  );
}

/** Send `count` requests from `ip` to `pathname`; the statuses, in order. */
async function send(pathname: string, ip: string, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    statuses.push((await request(pathname, ip)).status);
  }
  return statuses;
}

describe("the middleware's per-IP limit (FR-R2 (1))", () => {
  it("the 31st search from one IP inside the window passes", async () => {
    const statuses = await send(SEARCH, freshIp(), 31);
    expect(statuses.filter((status) => status === 429)).toEqual([]);
  });

  it("the 240th search passes and the 241st is a 429 carrying the 240 limit", async () => {
    const ip = freshIp();
    const statuses = await send(SEARCH, ip, 240);
    expect(statuses.filter((status) => status === 429)).toEqual([]);

    const limited = await request(SEARCH, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe("240");
  });

  it.each([
    ["another /api path", "/api/locations"],
    ["a deeper path under the search (exact match, not a prefix)", `${SEARCH}/x`],
    ["a path that only starts with the search's spelling", `${SEARCH}x`],
  ])("%s still answers 429 at the 31st request", async (_label, pathname) => {
    const ip = freshIp();
    const statuses = await send(pathname, ip, 30);
    expect(statuses.filter((status) => status === 429)).toEqual([]);

    const limited = await request(pathname, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe("30");
  });

  it("the search's bucket is its own: 240 searches leave another path's 30 untouched", async () => {
    const ip = freshIp();
    await send(SEARCH, ip, 240);
    const other = await send("/api/locations", ip, 30);
    expect(other.filter((status) => status === 429)).toEqual([]);
  });
});

describe("the middleware's per-IP limits for the STOCKTAKE paths (P2-B3-2, Kris 2026-11-16)", () => {
  it.each([
    ["/api/inventory/adjust", 120],
    ["/api/inventory/variants", 480],
    ["/api/inventory/logs", 120],
    ["/api/inventory/transfers", 120],
    ["/api/products/optimized", 120],
    ["/api/csrf", 240],
  ])("%s: the %ith request from one IP passes and the next is a 429 carrying that limit", async (pathname, limit) => {
    const ip = freshIp();
    const statuses = await send(pathname, ip, limit);
    expect(statuses.filter((status) => status === 429)).toEqual([]);

    const limited = await request(pathname, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe(String(limit));
  });

  it.each([
    ["a deeper path under the adjust route (exact match, not a prefix)", "/api/inventory/adjust/x"],
    ["the list the workbench reads, which this dialog never refreshes", "/api/products"],
    ["the stock read the workbench uses", "/api/inventory/current-fast"],
    ["a product's own path under /api/products", "/api/products/7"],
  ])("%s still answers 429 at the 31st request", async (_label, pathname) => {
    const ip = freshIp();
    const statuses = await send(pathname, ip, 30);
    expect(statuses.filter((status) => status === 429)).toEqual([]);

    const limited = await request(pathname, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe("30");
  });

  it("each override is its own bucket: 120 saves leave the activity list's 120 untouched", async () => {
    const ip = freshIp();
    await send("/api/inventory/adjust", ip, 120);
    const reads = await send("/api/inventory/logs", ip, 120);
    expect(reads.filter((status) => status === 429)).toEqual([]);
  });

  it("the bucket is per PATH, not per method: a POST and GETs on one override share its budget", async () => {
    const ip = freshIp();
    await send("/api/inventory/adjust", ip, 119);
    const post = await middleware(
      new NextRequest("http://localhost/api/inventory/adjust", { method: "POST", headers: { "x-forwarded-for": ip } }),
    );
    expect(post.status).not.toBe(429);
    const over = await request("/api/inventory/adjust", ip);
    expect(over.status).toBe(429);
  });
});
