import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler, requireApproved, requireCSRF } from "@/lib/api-utils";
import { enforceRateLimit, applyRateLimitHeaders } from "@/lib/rateLimit";
import { CreateScratchpadRowSchema } from "@/lib/validation/scratchpad";
import { createScratchpadRow } from "@/lib/scratchpad/mutations";
import { getScratchpadBoard } from "@/lib/scratchpad/queries";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireApproved();
  const board = await getScratchpadBoard();
  return NextResponse.json({ board });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();
  const headers = enforceRateLimit(request, "scratchpad:POST", { identifier: user.id });
  await requireCSRF(request);
  const body = CreateScratchpadRowSchema.parse(await request.json());
  // Create + record in one transaction (tx threaded into the mutation).
  const row = await prisma.$transaction(async (tx) => {
    const created = await createScratchpadRow(body, { id: user.id }, tx);
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "SCRATCHPAD_CREATE",
      entityType: "SCRATCHPAD",
      entityId: created.id,
      action: `Created scratchpad row '${created.label}' on product ${created.productId}`,
    });
    return created;
  });
  return applyRateLimitHeaders(NextResponse.json(row, { status: 201 }), headers);
});
