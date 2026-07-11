import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange, type ChangeDiff } from "@/lib/change-tracking";
import { SystemSettingsSchema } from "@/lib/validation/admin";
import { getLowStockDefault } from "@/lib/stock-threshold";

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
  // Resolved default (fallback 10 when unset) — the matrix header input edits it.
  const lowStockDefaultThreshold = await getLowStockDefault();

  return NextResponse.json({
    locations,
    weeklyReportsEnabled: weeklyReportsSetting?.value === "true",
    analyticsRebuildEnabled: analyticsRebuildSetting?.value === "true",
    lowStockDefaultThreshold,
  });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  const { weeklyReportsEnabled, analyticsRebuildEnabled, lowStockDefaultThreshold } =
    SystemSettingsSchema.parse(body);

  // Only the keys actually present in the request are touched (ER-B9).
  const provided: Array<{ key: string; to: string }> = [];
  if (weeklyReportsEnabled !== undefined) {
    provided.push({ key: "weeklyReportsEnabled", to: String(weeklyReportsEnabled) });
  }
  if (analyticsRebuildEnabled !== undefined) {
    provided.push({ key: "analyticsRebuildEnabled", to: String(analyticsRebuildEnabled) });
  }
  if (lowStockDefaultThreshold !== undefined) {
    provided.push({ key: "lowStockDefaultThreshold", to: String(lowStockDefaultThreshold) });
  }

  // Nothing provided => nothing to write and no change to record (ER-B9).
  if (provided.length === 0) {
    return NextResponse.json({ success: true });
  }

  // D4: both upserts + the SETTINGS_UPDATE record land in ONE transaction, so a
  // partial commit can never leave one flag written without the audit row. The
  // from-values are FETCHED inside the tx (today's route wrote blindly).
  await prisma.$transaction(async (tx) => {
    const keys = provided.map((p) => p.key);
    const current = await tx.systemSetting.findMany({ where: { key: { in: keys } } });
    const fromByKey = new Map(current.map((s) => [s.key, s.value]));

    const changes: ChangeDiff = {};
    for (const { key, to } of provided) {
      const from = fromByKey.get(key) ?? null;
      await tx.systemSetting.upsert({
        where: { key },
        update: { value: to },
        create: { key, value: to },
      });
      // Drop no-op flags (from === to); only real changes reach the event (ER-B9).
      if (from !== to) {
        changes[key] = { from, to };
      }
    }

    // No effective change across the provided flags => no event (ER-B9).
    if (Object.keys(changes).length > 0) {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "SETTINGS_UPDATE",
        entityType: "SETTINGS",
        entityId: null,
        action: "Updated system settings",
        changes,
      });
    }
  });

  return NextResponse.json({ success: true });
});
