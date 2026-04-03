import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";
import { stockChecker } from "@/lib/stock-checker";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  try {
    await requireApproved();

    const { combinedBreaches } = await stockChecker.checkMinimums();

    return NextResponse.json({
      breaches: combinedBreaches,
    });
  } catch (error) {
    console.error("Error fetching minimum report", error);
    return NextResponse.json({ error: "Failed to load minimum report" }, { status: 500 });
  }
}
