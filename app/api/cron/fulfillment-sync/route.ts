import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler } from "@/lib/api-utils";
import { bearerAuthorized } from "@/lib/security/secret-compare";
import {
  runFulfillmentSync,
  backfillFulfillmentObservations,
  reconcileFulfillmentTombstones,
} from "@/lib/external-orders/fulfillment-observations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cron/fulfillment-sync — Lane 6 (L-WOO).
 *
 * The READ-ONLY WooCommerce fulfillment poll. Every read is a GET through egress
 * (READ credential, origin-pinned); this route issues no writes to any platform.
 *
 * Modes (query `?mode=`):
 *   incremental (default) — drain webhook hints, then the incremental poll.
 *   backfill              — one bounded, resumable backfill step (?maxPages=N).
 *   reconcile             — poll trash + seen-set reconciliation → tombstones.
 *
 * Authorized by CRON_SECRET (bearer), mirroring the stock-sync / stock-check crons.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const authHeader = request.headers.get("authorization");
  if (!bearerAuthorized(authHeader, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const mode = (searchParams.get("mode") ?? "incremental").toLowerCase();
  const maxPagesParam = searchParams.get("maxPages");
  const maxPages = maxPagesParam ? Math.max(1, parseInt(maxPagesParam, 10) || 1) : undefined;

  const startTime = Date.now();

  // Fulfillment observation is WooCommerce-only (Shopify writes are stubs and
  // Shopify has native per-item fulfillment; it is out of scope here).
  const integrations = await prisma.integration.findMany({
    where: { isActive: true, platform: "WOOCOMMERCE" },
    select: { id: true, name: true, platform: true },
  });

  const results: Array<Record<string, unknown>> = [];
  for (const integration of integrations) {
    try {
      if (mode === "backfill") {
        results.push({
          name: integration.name,
          ...(await backfillFulfillmentObservations(integration.id, { maxPages })),
        });
      } else if (mode === "reconcile") {
        results.push({
          name: integration.name,
          ...(await reconcileFulfillmentTombstones(integration.id)),
        });
      } else {
        results.push({
          name: integration.name,
          ...(await runFulfillmentSync(integration.id)),
        });
      }
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

  return NextResponse.json({
    success: true,
    mode,
    integrations: integrations.length,
    duration: Date.now() - startTime,
    results,
  });
});
