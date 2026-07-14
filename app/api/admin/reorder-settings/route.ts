/**
 * Global reorder settings admin API (Lane reorder-points, Task 4).
 *
 * GET  — the singleton global_reorder_settings row (seeded on first read).
 * PUT  — update the allowlisted global reorder defaults (codex #13) with an audit diff.
 *
 * These are the shop-wide defaults a product inherits when it has no per-product
 * override: lead time (always positive), the flat buffer days, the order-up-to
 * multiple, and the min-evidence gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange, type ChangeDiff } from "@/lib/change-tracking";
import { GlobalReorderSettingsSchema } from "@/lib/validation/admin";
import { getGlobalReorderSettings } from "@/lib/reorder-config";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  const settings = await getGlobalReorderSettings();
  return NextResponse.json({
    defaultLeadTimeDays: settings.defaultLeadTimeDays,
    defaultSafetyStockDays: settings.defaultSafetyStockDays,
    defaultTargetCoverageMultiple: settings.defaultTargetCoverageMultiple,
    minEvidenceEvents: settings.minEvidenceEvents,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  await requireCSRF(request);

  const body = GlobalReorderSettingsSchema.parse(await request.json());
  const existing = await getGlobalReorderSettings();

  const fields = [
    "defaultLeadTimeDays",
    "defaultSafetyStockDays",
    "defaultTargetCoverageMultiple",
    "minEvidenceEvents",
  ] as const;

  const data: Record<string, number> = {};
  const changes: ChangeDiff = {};
  for (const field of fields) {
    const to = body[field];
    if (to === undefined) continue;
    data[field] = to;
    const from = existing[field] as number;
    if (from !== to) changes[field] = { from, to };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.globalReorderSettings.update({
      where: { id: 1 },
      data: { ...data, updatedBy: user.id },
    });
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "SETTINGS_UPDATE",
      entityType: "SYSTEM",
      entityId: null,
      action: "Updated global reorder settings",
      changes,
      details: { settings: "global-reorder" },
    });
    return row;
  });

  return NextResponse.json({
    defaultLeadTimeDays: updated.defaultLeadTimeDays,
    defaultSafetyStockDays: updated.defaultSafetyStockDays,
    defaultTargetCoverageMultiple: updated.defaultTargetCoverageMultiple,
    minEvidenceEvents: updated.minEvidenceEvents,
  });
});
