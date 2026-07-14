/**
 * Reorder report CSV export (Lane reorder-points, Task 4; codex #14).
 *
 * Hands procurement a supplier-ready worklist. Includes BOTH suggested rows (with every
 * input as a basis column) AND the excluded products (state + reason), so the export is
 * a truthful, complete picture — never a filtered-to-look-clean subset. Uses the shared
 * `rowsToCSV` (formula-injection-neutralized, Lane 5) and records a DATA_EXPORT change
 * event before streaming (GET routes are invisible to the coverage gate; the record +
 * its test are the enforcement). Null cost / unavailable rows export as blank cells
 * (truthful) — never a fabricated $0.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { rowsToCSV } from "@/lib/csv";
import { getReorderReport } from "@/lib/reports/reorder";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireApproved();

  // includeOkay so the export is the full picture (worklist + approaching + excluded).
  const report = await getReorderReport({ includeOkay: true });

  // Record the export BEFORE streaming (record-before-stream: a rejecting record must
  // 500 with no CSV body).
  await prisma.$transaction(async (tx) => {
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "DATA_EXPORT",
      entityType: "SYSTEM",
      entityId: null,
      action: "Exported reorder report CSV",
      details: {
        export: "reorder-report",
        coverage: report.coverage,
        assumptions: report.assumptions,
      },
    });
  });

  const headers = [
    "Product",
    "State",
    "Reason",
    "Urgency",
    "Current Stock",
    "Avg Daily Demand",
    "Days Covered",
    "Lead Time Days",
    "Lead Time Source",
    "Buffer Days",
    "Reorder Point",
    "Target Level",
    "Suggested Order Qty",
    "Min Order Qty",
    "Cost Price",
    "Order Value",
  ];
  const rows: unknown[][] = [headers];

  for (const r of report.rows) {
    if (r.status === "unavailable") {
      // Excluded product: state + reason filled, every number left blank (truthful).
      rows.push([
        r.productName,
        "unavailable",
        r.reason,
        "",
        r.currentStock,
        "", "", "", "", "", "", "", "", "", "", "",
      ]);
    } else {
      rows.push([
        r.productName,
        "suggested",
        "",
        r.urgency,
        r.currentStock,
        r.avgDailyDemand,
        r.daysCovered,
        r.leadTimeDays,
        r.leadTimeSource,
        r.bufferDays,
        r.reorderPoint,
        r.targetLevel,
        r.grossReplenishmentNeed,
        r.minOrderQuantity,
        // null cost / order value => blank cell, never $0.
        r.costPrice ?? "",
        r.orderValue ?? "",
      ]);
    }
  }

  const csv = rowsToCSV(rows);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="reorder-report-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
});
