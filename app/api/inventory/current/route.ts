import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getCurrentInventoryLevelsOptimized } from "@/lib/inventory-optimized";
import type { CurrentInventoryResponse } from "@/types/inventory";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const locationId = searchParams.get("locationId");

  const inventory = await getCurrentInventoryLevelsOptimized(
    locationId ? parseInt(locationId) : undefined
  );

  const response: CurrentInventoryResponse = {
    inventory,
    asOf: new Date(),
  };

  return NextResponse.json(response);
});
