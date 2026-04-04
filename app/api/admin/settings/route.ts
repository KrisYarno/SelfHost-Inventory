import { NextRequest, NextResponse } from "next/server";
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

    // Get system-level settings
    const weeklyReportsSetting = await prisma.systemSetting.findUnique({
      where: { key: "weeklyReportsEnabled" },
    });

    return NextResponse.json({
      locations,
      weeklyReportsEnabled: weeklyReportsSetting?.value === "true",
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();

    const body = await request.json();
    const { weeklyReportsEnabled } = body;

    if (typeof weeklyReportsEnabled === "boolean") {
      await prisma.systemSetting.upsert({
        where: { key: "weeklyReportsEnabled" },
        update: { value: String(weeklyReportsEnabled) },
        create: { key: "weeklyReportsEnabled", value: String(weeklyReportsEnabled) },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating settings:", error);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
