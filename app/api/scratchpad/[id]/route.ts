import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler, requireApproved, requireCSRF } from "@/lib/api-utils";
import { enforceRateLimit, applyRateLimitHeaders } from "@/lib/rateLimit";
import { PatchScratchpadRowSchema, DeleteScratchpadRowSchema } from "@/lib/validation/scratchpad";
import { updateScratchpadRow, deleteScratchpadRow } from "@/lib/scratchpad/mutations";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  const { user } = await requireApproved();
  const headers = enforceRateLimit(request, "scratchpad:PATCH", { identifier: user.id });
  await requireCSRF(request);
  const { expectedVersion, ...patch } = PatchScratchpadRowSchema.parse(await request.json());
  // CAS write + SCRATCHPAD_UPDATE event share one tx: a stale-version 409
  // (OptimisticLockError) aborts before recordChange, so it records nothing; a
  // racey-delete (row === null) records nothing and maps to 200 { deleted: true }.
  const row = await prisma.$transaction(async (tx) => {
    const updated = await updateScratchpadRow(Number(params.id), expectedVersion, patch, { id: user.id }, tx);
    if (updated) {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "SCRATCHPAD_UPDATE",
        entityType: "SCRATCHPAD",
        entityId: updated.id,
        action: `Updated scratchpad row ${updated.id}`,
      });
    }
    return updated;
  });
  if (!row) return applyRateLimitHeaders(NextResponse.json({ deleted: true }), headers); // racey delete
  return applyRateLimitHeaders(NextResponse.json(row), headers);
});

export const DELETE = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  const { user } = await requireApproved();
  const headers = enforceRateLimit(request, "scratchpad:DELETE", { identifier: user.id });
  await requireCSRF(request);
  const { expectedVersion } = DeleteScratchpadRowSchema.parse(await request.json());
  // CAS delete + SCRATCHPAD_DELETE event share one tx: a stale-version 409 (or
  // 404) throws before recordChange, so it records nothing.
  await prisma.$transaction(async (tx) => {
    await deleteScratchpadRow(Number(params.id), expectedVersion, tx);
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "SCRATCHPAD_DELETE",
      entityType: "SCRATCHPAD",
      entityId: Number(params.id),
      action: `Deleted scratchpad row ${params.id}`,
    });
  });
  return applyRateLimitHeaders(NextResponse.json({ deleted: true }), headers);
});
