import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
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
 *
 * P2-B1.5b adds `summary`: the TOTAL shape of the batch (row/product counts, net
 * units, types, actors, orders) from aggregates only — the drawer's header line
 * must describe the whole batch, not the section page the drawer happens to show.
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

/**
 * P2-B1.5b — what the WHOLE batch did, built from AGGREGATES and never from rows.
 * "A batch is bounded" is false: a mass-update stamps ONE batchId on an operation
 * with no cap on its changes, which is exactly why this route pages its two
 * sections. So the summary is TOTAL over the batch while the sections are a page.
 */
interface BatchSummary {
  rowCount: number;
  productCount: number;
  netUnits: number;
  logTypes: string[];
  actors: string[];
  orders: Array<{ id: string; orderNumber: string }>;
}

/** MySQL hands COUNT back as BigInt, which NextResponse.json cannot serialize. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
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

    const [
      eventRows,
      eventsTotal,
      ledgerRows,
      ledgerTotal,
      typeGroups,
      productCountRows,
      userGroups,
      orderGroups,
    ] = await Promise.all([
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
      // The summary aggregates — each index-served on batchId
      // (idx_inventory_logs_batch), each bounded by CARDINALITY rather than by the
      // batch's row count, and none of them paged (they describe the TOTAL).
      prisma.inventory_logs.groupBy({
        by: ["logType"],
        where: { batchId },
        _count: { _all: true },
        _sum: { delta: true },
      }),
      // COUNT(DISTINCT productId) as a raw scalar: groupBy(['productId']) would
      // materialize one group per product, and a mass-update batch writes roughly
      // one row per product — the one aggregate NOT bounded by cardinality.
      prisma.$queryRaw<Array<{ n: unknown }>>(
        Prisma.sql`SELECT COUNT(DISTINCT productId) AS n FROM inventory_logs WHERE batchId = ${batchId}`
      ),
      prisma.inventory_logs.groupBy({ by: ["userId"], where: { batchId } }),
      prisma.inventory_logs.groupBy({
        by: ["orderRecordId"],
        where: { batchId, orderRecordId: { not: null } },
      }),
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

    // logTypes: most-used first, then by name so the line is stable. netUnits sums
    // from 0 — an empty groupBy is [], and a group with no rows cannot exist.
    const logTypes = typeGroups
      .slice()
      .sort((a, b) => {
        const byCount = b._count._all - a._count._all;
        if (byCount !== 0) return byCount;
        const an = String(a.logType);
        const bn = String(b.logType);
        return an < bn ? -1 : an > bn ? 1 : 0;
      })
      .map((g) => String(g.logType));
    const netUnits = typeGroups.reduce((sum, g) => sum + (g._sum.delta ?? 0), 0);
    const productCount = toNumber(productCountRows[0]?.n);

    // The two name lookups DEPEND on the aggregates, so they run after the
    // Promise.all — each skipped entirely when its id set is empty.
    const userIds = userGroups.map((g) => g.userId).filter((id): id is number => id != null);
    const userRows =
      userIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true },
          })
        : [];
    const usernameById = new Map<number, string>();
    userRows.forEach((u) => usernameById.set(u.id, u.username));
    const actorNames = new Set<string>();
    userGroups.forEach((g) => {
      // A machine-actor row (null userId) reads "System", as the row list does; so
      // does a group whose user row is gone — there is no name left to print.
      actorNames.add((g.userId != null ? usernameById.get(g.userId) : undefined) ?? "System");
    });
    // PLAIN .sort() — code-unit order, deliberately (never localeCompare, whose
    // result depends on the server's locale).
    const actors = Array.from(actorNames).sort();

    const orderIds = orderGroups
      .map((g) => g.orderRecordId)
      .filter((id): id is string => id != null);
    const orderRows =
      orderIds.length > 0
        ? await prisma.externalOrder.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, orderNumber: true },
          })
        : [];
    // A stamped id the read did not return (a deleted order) is OMITTED — never a
    // null entry. orderNumber is not PII under this lane's rule (order ids and
    // numbers, never customer data).
    const orders = orderRows
      .map((o) => ({ id: o.id, orderNumber: o.orderNumber }))
      .sort((a, b) => (a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0));

    // An events-only batch answers the TOTAL zero block: a genuinely-empty movement
    // set is the truth here, not an unpopulated figure.
    const summary: BatchSummary = {
      rowCount: ledgerTotal,
      productCount,
      netUnits,
      logTypes,
      actors,
      orders,
    };

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
      summary,
    });
  }
);
