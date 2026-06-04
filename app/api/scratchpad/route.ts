import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireApproved } from "@/lib/api-utils";
import { enforceRateLimit, applyRateLimitHeaders } from "@/lib/rateLimit";
import { validateCSRFToken } from "@/lib/csrf";
import { CreateScratchpadRowSchema } from "@/lib/validation/scratchpad";
import { createScratchpadRow } from "@/lib/scratchpad/mutations";
import { getScratchpadBoard } from "@/lib/scratchpad/queries";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireApproved();
  const board = await getScratchpadBoard();
  return NextResponse.json({ board });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();
  const headers = enforceRateLimit(request, "scratchpad:POST", { identifier: user.id });
  if (!(await validateCSRFToken(request)))
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  const body = CreateScratchpadRowSchema.parse(await request.json());
  const row = await createScratchpadRow(body, { id: user.id });
  await auditService.log({
    userId: user.id, actionType: "SCRATCHPAD_CREATE", entityType: "SCRATCHPAD",
    entityId: row.id, action: `Created scratchpad row '${row.label}' on product ${row.productId}`,
  });
  return applyRateLimitHeaders(NextResponse.json(row, { status: 201 }), headers);
});
