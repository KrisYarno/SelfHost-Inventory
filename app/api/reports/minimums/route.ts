import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { stockChecker } from "@/lib/stock-checker";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (_request: NextRequest) => {
  await requireApproved();

  const { combinedBreaches } = await stockChecker.checkMinimums();

  return NextResponse.json({
    breaches: combinedBreaches,
  });
});
