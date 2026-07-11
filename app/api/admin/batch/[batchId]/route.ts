import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { z } from "zod";
import { actionMeta, type ActionMeta } from "@/lib/change-tracking/taxonomy";
import { extractChanges, type ChangePair } from "@/lib/change-tracking/extract-changes";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/batch/[batchId] (Lane 3 R-L8) — the admin batch drill-down.
 *
 * Returns a batch's audit events and inventory movements, EACH independently
 * paginated (mass-update batches exceed the 100-row cap the generic list GETs
 * enforce). Queries `auditLog` / `inventory_logs` directly with a strict field
 * ALLOWLIST — never ip/userAgent/email/raw details. `changes` is normalized
 * through `extractChanges` so the drawer's renderers only ever see the canonical
 * `{ field: { from, to } }` shape. Admin-only, so no R-L5 company redaction is
 * needed (an admin sees everything).
 */

// batchIds are v4 uuids (lib/change-tracking newBatchId()); garbage -> 400.
const batchIdSchema = z.string().uuid();

const paramsSchema = z.object({
  eventsLimit: z.coerce.number().int().min(1).max(100).default(50),
  eventsOffset: z.coerce.number().int().min(0).default(0),
  ledgerLimit: z.coerce.number().int().min(1).max(100).default(50),
  ledgerOffset: z.coerce.number().int().min(0).default(0),
});

interface BatchEventItem {
  id: number;
  createdAt: string;
  actionType: string;
  meta: ActionMeta;
  actorKind: string;
  actorName: string | null;
  action: string;
  changes: Record<string, ChangePair> | null;
  entityType: string;
  entityId: string | null;
  affectedCount: number;
}

interface BatchLedgerItem {
  id: number;
  changeTime: string;
  delta: number;
  logType: string;
  reasonCode: string | null;
  unitCostCents: number | null;
  productName: string | null;
  locationName: string | null;
  transferId: string | null;
  userName: string | null;
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: { params: { batchId: string } }) => {
    await requireAdmin();

    const idResult = batchIdSchema.safeParse(params.batchId);
    if (!idResult.success) {
      return NextResponse.json({ error: "Invalid batchId" }, { status: 400 });
    }
    const batchId = idResult.data;

    const { searchParams } = new URL(request.url);
    const paramResult = paramsSchema.safeParse(Object.fromEntries(searchParams.entries()));
    if (!paramResult.success) {
      return NextResponse.json(
        { error: "Invalid pagination parameters", details: paramResult.error.errors },
        { status: 400 }
      );
    }
    const p = paramResult.data;

    const [eventRows, eventsTotal, ledgerRows, ledgerTotal] = await Promise.all([
      prisma.auditLog.findMany({
        where: { batchId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: p.eventsLimit,
        skip: p.eventsOffset,
        select: {
          id: true,
          createdAt: true,
          actionType: true,
          actorKind: true,
          action: true,
          details: true,
          entityType: true,
          entityId: true,
          affectedCount: true,
          user: { select: { username: true } },
        },
      }),
      prisma.auditLog.count({ where: { batchId } }),
      prisma.inventory_logs.findMany({
        where: { batchId },
        orderBy: [{ changeTime: "asc" }, { id: "asc" }],
        take: p.ledgerLimit,
        skip: p.ledgerOffset,
        select: {
          id: true,
          changeTime: true,
          delta: true,
          logType: true,
          reasonCode: true,
          unitCostCents: true,
          transferId: true,
          products: { select: { name: true } },
          locations: { select: { name: true } },
          users: { select: { username: true } },
        },
      }),
      prisma.inventory_logs.count({ where: { batchId } }),
    ]);

    const events: BatchEventItem[] = eventRows.map((e) => ({
      id: e.id,
      createdAt: e.createdAt.toISOString(),
      actionType: e.actionType,
      meta: actionMeta(e.actionType),
      actorKind: e.actorKind,
      actorName: e.user?.username ?? null,
      action: e.action,
      changes: extractChanges(e.details),
      entityType: e.entityType,
      entityId: e.entityId,
      affectedCount: e.affectedCount,
    }));

    const ledger: BatchLedgerItem[] = ledgerRows.map((r) => ({
      id: r.id,
      changeTime: r.changeTime.toISOString(),
      delta: r.delta,
      logType: String(r.logType),
      reasonCode: r.reasonCode ?? null,
      unitCostCents: r.unitCostCents ?? null,
      productName: r.products?.name ?? null,
      locationName: r.locations?.name ?? null,
      transferId: r.transferId ?? null,
      userName: r.users?.username ?? null,
    }));

    return NextResponse.json({
      events: {
        items: events,
        total: eventsTotal,
        limit: p.eventsLimit,
        offset: p.eventsOffset,
      },
      ledgerRows: {
        items: ledger,
        total: ledgerTotal,
        limit: p.ledgerLimit,
        offset: p.ledgerOffset,
      },
    });
  }
);
