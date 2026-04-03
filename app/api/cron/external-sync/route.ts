import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { syncIntegrationOrders } from "@/lib/external-orders/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const token = process.env.INTERNAL_SYNC_TOKEN;
  if (!token) return false;
  return request.headers.get("x-internal-sync-token") === token;
}

export async function POST(request: NextRequest) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const lookbackDays =
      typeof body.lookbackDays === "number" ? body.lookbackDays : undefined;
    const maxOrders = typeof body.maxOrders === "number" ? body.maxOrders : undefined;

    const integrations = await prisma.integration.findMany({
      where: { isActive: true },
      select: { id: true, name: true, platform: true },
    });

    if (integrations.length === 0) {
      return NextResponse.json({ results: [] });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const integration of integrations) {
      try {
        const result = await syncIntegrationOrders(integration.id, {
          lookbackDays,
          maxOrders,
        });
        results.push({
          ...result,
          name: integration.name,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        results.push({
          integrationId: integration.id,
          name: integration.name,
          platform: integration.platform,
          error: message,
        });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error running scheduled external sync:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
