import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getCurrentInventoryLevelsOptimized } from "@/lib/inventory-optimized";
import type { CurrentInventoryResponse } from "@/types/inventory";

export const dynamic = "force-dynamic";

// Add caching headers for CDN/browser caching
const CACHE_DURATION = 60; // 1 minute

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const locationId = searchParams.get("locationId");

  // Use the optimized function
  const inventory = await getCurrentInventoryLevelsOptimized(
    locationId ? parseInt(locationId) : undefined
  );

  const response: CurrentInventoryResponse = {
    inventory,
    asOf: new Date(),
  };

  // Create response with cache headers
  const jsonResponse = NextResponse.json(response);

  // Set cache headers for better performance
  jsonResponse.headers.set(
    "Cache-Control",
    `private, max-age=${CACHE_DURATION}, stale-while-revalidate=${CACHE_DURATION * 2}`
  );

  // Add ETag for cache validation
  const etag = `"${Date.now()}-${locationId || "all"}"`;
  jsonResponse.headers.set("ETag", etag);

  return jsonResponse;
});
