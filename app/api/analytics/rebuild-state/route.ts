import { NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GLOBAL latest-rebuild metadata for the single hub "N orders unattributed" note.
// NOT per-product, NOT date/company-scoped. The "sales" row is the one written by the
// sales-fact rebuild job (lib/analytics/rebuild-sales.ts). requireApproved-gated, read-only.
export const GET = apiHandler(async () => {
  await requireApproved();
  const state = await prisma.analyticsRebuildState.findUnique({
    where: { job: "sales" },
    select: { unattributed: true, lastRunAt: true },
  });
  return NextResponse.json({
    unattributed: state?.unattributed ?? 0,
    lastRunAt: state?.lastRunAt ?? null,
  });
});
