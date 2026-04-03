import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { syncIntegrationOrders } from "@/lib/external-orders/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAdmin();

    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const lookbackDays =
      typeof body.lookbackDays === "number" ? body.lookbackDays : undefined;
    const maxOrders = typeof body.maxOrders === "number" ? body.maxOrders : undefined;

    const result = await syncIntegrationOrders(params.id, { lookbackDays, maxOrders });
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error syncing integration orders:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
