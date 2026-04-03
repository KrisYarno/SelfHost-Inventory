import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();

    // Get all locations with counts
    const locations = await prisma.location.findMany({
      include: {
        _count: {
          select: {
            product_locations: true,
            inventory_logs: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json({
      locations,
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}
