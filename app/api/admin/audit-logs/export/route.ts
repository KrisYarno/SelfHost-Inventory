import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import type { AuditActionType } from "@/lib/change-tracking";
import { rowsToCSV } from "@/lib/csv";
import { extractChanges } from "@/lib/change-tracking/extract-changes";
import { ALL_ACTION_TYPES, expandActionGroup } from "@/lib/change-tracking/taxonomy";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/audit-logs/export (Lane 3 R-L8) — server-side audit CSV.
 *
 * Replaces the client-side "fetch limit=1000 then build CSV" path, which 400s
 * in prod today (the list GET caps limit at 100). Mirrors
 * app/api/admin/logs/export: validates filters -> records a DATA_EXPORT event
 * BEFORE streaming (a rejecting record 500s with no CSV body) -> streams the
 * full filtered result with NO pagination cap. CSV adds batchId + a
 * JSON-stringified canonical `changes` column (via extractChanges).
 */

const ACTION_TYPE_SET = new Set<string>(ALL_ACTION_TYPES);
const ENTITY_TYPES = [
  "USER",
  "PRODUCT",
  "INVENTORY",
  "LOCATION",
  "SETTINGS",
  "SYSTEM",
  "STAGING",
  "SHIPMENT",
  "SCRATCHPAD",
  "COMPANY",
  "INTEGRATION",
  "MAPPING",
  "ORDER",
  "ACCOUNT",
];
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

const exportQuerySchema = z.object({
  userId: z.coerce.number().optional(),
  actionType: z
    .string()
    .trim()
    .min(1)
    .refine((v) => ACTION_TYPE_SET.has(v), { message: "Unknown actionType" })
    .optional(),
  entityType: z
    .string()
    .trim()
    .min(1)
    .refine((v) => ENTITY_TYPE_SET.has(v), { message: "Unknown entityType" })
    .optional(),
  actionGroup: z
    .string()
    .trim()
    .min(1)
    .refine((v) => expandActionGroup(v) !== null, { message: "Unknown actionGroup" })
    .optional(),
  entityId: z.string().trim().min(1).optional(),
  batchId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const { searchParams } = new URL(request.url);
  // Validate BEFORE the export record is written: garbage input is a clean 400
  // with no DATA_EXPORT side effect (mirrors the ledger export route).
  const validation = exportQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!validation.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: validation.error.errors },
      { status: 400 }
    );
  }
  const f = validation.data;

  const where: {
    userId?: number;
    actionType?: AuditActionType | { in: AuditActionType[] };
    entityType?: string;
    entityId?: string;
    batchId?: string;
    createdAt?: { gte?: Date; lte?: Date };
  } = {};
  if (f.userId) where.userId = f.userId;
  if (f.actionType) {
    where.actionType = f.actionType as AuditActionType;
  } else if (f.actionGroup) {
    where.actionType = { in: expandActionGroup(f.actionGroup)! };
  }
  if (f.entityType) where.entityType = f.entityType;
  if (f.entityId) where.entityId = f.entityId;
  if (f.batchId) where.batchId = f.batchId;
  if (f.startDate || f.endDate) {
    where.createdAt = {};
    if (f.startDate) where.createdAt.gte = new Date(f.startDate);
    if (f.endDate) where.createdAt.lte = new Date(f.endDate);
  }

  const logs = await prisma.auditLog.findMany({
    where,
    include: { user: { select: { username: true, email: true } } },
    orderBy: { createdAt: "desc" },
  });

  // Record the export BEFORE streaming (record-before-stream ordering, ER-B6).
  await prisma.$transaction(async (tx) => {
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "DATA_EXPORT",
      entityType: "SYSTEM",
      entityId: null,
      action: "Exported audit logs CSV",
      details: {
        export: "audit-logs",
        filters: {
          userId: f.userId,
          actionType: f.actionType,
          actionGroup: f.actionGroup,
          entityType: f.entityType,
          entityId: f.entityId,
          batchId: f.batchId,
          startDate: f.startDate,
          endDate: f.endDate,
        },
        rowCount: logs.length,
      },
    });
  });

  const headers = [
    "Timestamp",
    "User",
    "Action Type",
    "Entity Type",
    "Entity ID",
    "Action",
    "Affected Count",
    "Batch ID",
    "Changes",
    "IP Address",
  ];
  const rows: unknown[][] = [headers];

  logs.forEach((log) => {
    const changes = extractChanges(log.details);
    rows.push([
      log.createdAt.toISOString(),
      // Machine-actor rows (nullable userId) have no owning user — render "System".
      log.user?.email ?? "System",
      log.actionType,
      log.entityType,
      log.entityId ?? "",
      log.action,
      log.affectedCount.toString(),
      log.batchId ?? "",
      changes ? JSON.stringify(changes) : "",
      log.ipAddress ?? "",
    ]);
  });

  const csvContent = rowsToCSV(rows, { alwaysQuote: true });

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="audit-logs-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
});
