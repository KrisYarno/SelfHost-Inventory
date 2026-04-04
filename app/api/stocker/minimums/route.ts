import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { stockChecker } from "@/lib/stock-checker";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
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
});
