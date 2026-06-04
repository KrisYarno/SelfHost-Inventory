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
  const analyticsRebuildSetting = await prisma.systemSetting.findUnique({
    where: { key: "analyticsRebuildEnabled" },
  });

  return NextResponse.json({
    locations,
    weeklyReportsEnabled: weeklyReportsSetting?.value === "true",
    analyticsRebuildEnabled: analyticsRebuildSetting?.value === "true",
  });
});

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const body = await request.json();
  const { weeklyReportsEnabled, analyticsRebuildEnabled } = body;

  if (typeof weeklyReportsEnabled === "boolean") {
    await prisma.systemSetting.upsert({
      where: { key: "weeklyReportsEnabled" },
      update: { value: String(weeklyReportsEnabled) },
      create: { key: "weeklyReportsEnabled", value: String(weeklyReportsEnabled) },
    });
  }

  if (typeof analyticsRebuildEnabled === "boolean") {
    await prisma.systemSetting.upsert({
      where: { key: "analyticsRebuildEnabled" },
      update: { value: String(analyticsRebuildEnabled) },
      create: { key: "analyticsRebuildEnabled", value: String(analyticsRebuildEnabled) },
    });
  }

  return NextResponse.json({ success: true });
});
