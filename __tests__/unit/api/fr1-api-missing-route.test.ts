/**
 * @jest-environment node
 */

/**
 * Facelift FR1-5 (plan 2026-11-18-facelift-f1, REV 6; GR-5 = OCR-5) — an
 * unknown API path answers JSON.
 *
 * Before: the (app) catch-all (`app/(app)/[...missing]/page.tsx`, F1-4) also
 * caught `/api/no-such`, so a client calling a mistyped or retired API path got
 * the shell's HTML not-found page — `res.json()` threw instead of reading an
 * error. Now `app/api/[...missing]/route.ts` answers 404 with
 * `{ "error": "Not found" }` for GET, POST, PUT, PATCH and DELETE, and outranks
 * the (app) catch-all for every `/api/...` path (retiring REV 3's accepted
 * "in-shell 404 for `/api/...`").
 */

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import * as route from "@/app/api/[...missing]/route";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

describe("FR1-5 — app/api/[...missing]/route.ts", () => {
  it.each(METHODS)("%s answers 404 with { error: \"Not found\" } as JSON", async (method) => {
    const handler = route[method] as (req: NextRequest) => Response | Promise<Response>;
    expect(typeof handler).toBe("function");
    const res = await handler(
      new NextRequest("http://x/api/no-such/path", {
        method,
        ...(method === "GET" ? {} : { body: JSON.stringify({ any: "thing" }) }),
      })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("is the route every unmatched /api path lands on — ahead of the (app) catch-all; real API routes still win", () => {
    expect(fs.existsSync(path.join(process.cwd(), "app/api/[...missing]/route.ts"))).toBe(true);
    const { re } = getRouteRegex("/api/[...missing]");
    expect(re.test("/api/no-such")).toBe(true);
    expect(re.test("/api/inventory/no-such/deeper")).toBe(true);
    expect(re.test("/no-such-page")).toBe(false);

    // Next tries routes in this order: static and dynamic API routes first, then
    // the API catch-all, and only then the (app) catch-all.
    const sorted = getSortedRoutes(["/[...missing]", "/api/[...missing]", "/api/locations", "/api/inventory/[id]"]);
    expect(sorted.indexOf("/api/locations")).toBeLessThan(sorted.indexOf("/api/[...missing]"));
    expect(sorted.indexOf("/api/inventory/[id]")).toBeLessThan(sorted.indexOf("/api/[...missing]"));
    expect(sorted.indexOf("/api/[...missing]")).toBeLessThan(sorted.indexOf("/[...missing]"));
  });
});
