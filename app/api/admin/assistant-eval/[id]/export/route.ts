/**
 * app/api/admin/assistant-eval/[id]/export/route.ts — the per-row JSON download
 * (spec C9, Kris's call; contract pack T10, seam S15; G2-12 byte fidelity).
 *
 * Why it exists: a reported conversation should land in the docs-repo corpus by
 * saving a file, not by copy-pasting a transcript out of a web page. So the bytes
 * this route emits ARE the stored row under the T10 canonical serialization — the
 * whole row including its discriminating columns, never `report` alone, in a fixed
 * field order. `__tests__/integration/api/assistant-eval.test.ts` compares them
 * against a DTO built from a freshly re-read row; 3.3 repeats that at the HTTP layer.
 *
 * D9 — DELIBERATE, RECORDED DIVERGENCE: this GET writes NO `DATA_EXPORT`
 * change-tracking row and takes NO entry in the coverage registry's GET side-effect
 * table. The four registered DATA_EXPORT GETs export BUSINESS state (inventory,
 * logs, audit rows); this exports an assistant evaluation artefact — feature state,
 * the same class the eval/report POSTs are exempt under. Recording it would put an
 * audit row of a different kind into a table whose semantics are business change.
 * (Registered in the plan's §7 privacy section.)
 *
 * Both sources export identically: an admin-curated eval run and a user-initiated
 * report are the same row shape, and the source column travels with the file.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler, requireAdmin } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { serializeEvalExport, toEvalExportDto } from "@/lib/assistant/eval-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

export const GET = apiHandler(async (_request: NextRequest, { params }: RouteParams) => {
  await requireAdmin();

  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError("`id` must be a report id", "VALIDATION_ERROR", 400);
  }

  const row = await prisma.assistantEvalReport.findUnique({ where: { id } });
  if (!row) throw new AppError("Report not found", "NOT_FOUND", 404);

  const body = serializeEvalExport(toEvalExportDto(row));

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="assistant-eval-${id}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
