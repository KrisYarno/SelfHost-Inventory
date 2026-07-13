import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler } from "@/lib/api-utils";
import { headerTokenAuthorized } from "@/lib/security/secret-compare";
import { syncIntegrationOrders } from "@/lib/external-orders/sync";
import { SyncOrdersSchema } from "@/lib/validation/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const provided = request.headers.get("x-internal-sync-token");
  return headerTokenAuthorized(provided, process.env.INTERNAL_SYNC_TOKEN);
}

export const POST = apiHandler(async (request: NextRequest) => {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { lookbackDays, maxOrders } = SyncOrdersSchema.parse(
    await request.json().catch(() => ({}))
  );

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
});
