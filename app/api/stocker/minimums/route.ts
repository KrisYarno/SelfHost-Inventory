import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.user?.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const locationId =
      parseInt(searchParams.get("locationId") || "", 10) || session.user.defaultLocationId || 1;

    const location = await prisma.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }

    const rows = await prisma.product_locations.findMany({
      where: { locationId },
      include: {
        products: true,
      },
    });

    const items = rows
      .filter((row) => (row.minQuantity ?? 0) > 0 && row.quantity < row.minQuantity!)
      .map((row) => ({
        productId: row.productId,
        productName: row.products.name,
        locationId: row.locationId,
        locationName: location.name,
        currentQuantity: row.quantity,
        minQuantity: row.minQuantity ?? 0,
        shortage: Math.max((row.minQuantity ?? 0) - row.quantity, 0),
      }))
      .sort((a, b) => b.shortage - a.shortage);

    return NextResponse.json({
      location,
      items,
    });
  } catch (error) {
    console.error("Error fetching stocker minimums", error);
    return NextResponse.json({ error: "Failed to load stocker minimums" }, { status: 500 });
  }
}
