import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireApproved } from "@/lib/api-utils";
import { getLabelSuggestions } from "@/lib/scratchpad/queries";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();
  const q = request.nextUrl.searchParams.get("q") ?? undefined;
  const labels = await getLabelSuggestions(q);
  return NextResponse.json({ labels });
});
