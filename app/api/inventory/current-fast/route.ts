import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import {
  getCurrentInventoryLevelsFast,
  getCurrentInventoryLevelsPaginated,
} from "@/lib/inventory-fast";
import type { CurrentInventoryResponse } from "@/types/inventory";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const locationId = searchParams.get("locationId");
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "50");
  const paginate = searchParams.get("paginate") === "true";

  if (paginate) {
    const result = await getCurrentInventoryLevelsPaginated(
      locationId ? parseInt(locationId) : undefined,
      page,
      pageSize
    );

    return NextResponse.json({
      ...result,
      asOf: new Date(),
    });
  } else {
    const inventory = await getCurrentInventoryLevelsFast(
      locationId ? parseInt(locationId) : undefined
    );

    const response: CurrentInventoryResponse = {
      inventory,
      asOf: new Date(),
    };

    return NextResponse.json(response);
  }
});
