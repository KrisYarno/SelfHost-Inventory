import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireApproved } from "@/lib/api-utils";
import { enforceRateLimit, applyRateLimitHeaders } from "@/lib/rateLimit";
import { validateCSRFToken } from "@/lib/csrf";
import { PatchScratchpadRowSchema, DeleteScratchpadRowSchema } from "@/lib/validation/scratchpad";
import { updateScratchpadRow, deleteScratchpadRow } from "@/lib/scratchpad/mutations";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  const { user } = await requireApproved();
  const headers = enforceRateLimit(request, "scratchpad:PATCH", { identifier: user.id });
  if (!(await validateCSRFToken(request)))
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  const { expectedVersion, ...patch } = PatchScratchpadRowSchema.parse(await request.json());
  const row = await updateScratchpadRow(Number(params.id), expectedVersion, patch, { id: user.id });
  if (!row) return applyRateLimitHeaders(NextResponse.json({ deleted: true }), headers); // racey delete
  await auditService.log({
    userId: user.id, actionType: "SCRATCHPAD_UPDATE", entityType: "SCRATCHPAD",
    entityId: row.id, action: `Updated scratchpad row ${row.id}`,
  });
  return applyRateLimitHeaders(NextResponse.json(row), headers);
});

export const DELETE = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  const { user } = await requireApproved();
  const headers = enforceRateLimit(request, "scratchpad:DELETE", { identifier: user.id });
  if (!(await validateCSRFToken(request)))
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  const { expectedVersion } = DeleteScratchpadRowSchema.parse(await request.json());
  await deleteScratchpadRow(Number(params.id), expectedVersion);
  await auditService.log({
    userId: user.id, actionType: "SCRATCHPAD_DELETE", entityType: "SCRATCHPAD",
    entityId: Number(params.id), action: `Deleted scratchpad row ${params.id}`,
  });
  return applyRateLimitHeaders(NextResponse.json({ deleted: true }), headers);
});
