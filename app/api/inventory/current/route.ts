import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";
import { getCurrentInventoryLevelsOptimized } from "@/lib/inventory-optimized";
import type { CurrentInventoryResponse } from "@/types/inventory";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
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
  } catch (error) {
    console.error("Error fetching current inventory:", error);
    return NextResponse.json(
      { error: "Failed to fetch current inventory levels" },
      { status: 500 }
    );
  }
}
