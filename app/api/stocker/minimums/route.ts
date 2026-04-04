import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { stockChecker } from "@/lib/stock-checker";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireApproved();

    const searchParams = request.nextUrl.searchParams;
    const locationId =
      parseInt(searchParams.get("locationId") || "", 10) || user.defaultLocationId || 1;

    const location = await prisma.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }

    const { items } = await stockChecker.checkLocationMinimums(locationId);

    return NextResponse.json({
      location,
      items,
    });
  } catch (error) {
    console.error("Error fetching stocker minimums", error);
    return NextResponse.json({ error: "Failed to load stocker minimums" }, { status: 500 });
  }
}
