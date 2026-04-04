import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
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
});

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

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
});
