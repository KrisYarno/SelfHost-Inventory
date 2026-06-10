import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getCurrentInventoryLevelsFast } from "@/lib/inventory-fast";
import type { CurrentInventoryResponse } from "@/types/inventory";

export const dynamic = "force-dynamic";

// SHOW contract: current-stock views intentionally include provisional
// (PENDING_REVIEW) products -- pending stock is real stock. Do NOT add an
// approvalStatus filter here. See __tests__/integration/read-path-isolation.test.ts.
export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const locationId = searchParams.get("locationId");

  const inventory = await getCurrentInventoryLevelsFast(
    locationId ? parseInt(locationId) : undefined
  );

  const response: CurrentInventoryResponse = {
    inventory,
    asOf: new Date(),
  };

  return NextResponse.json(response);
});
