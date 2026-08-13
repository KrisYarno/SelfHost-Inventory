import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import { getAuditLogs } from "@/lib/change-tracking";
import type { AuditActionType, EntityType } from "@/lib/change-tracking";
import prisma from "@/lib/prisma";
import { z } from "zod";
import { ALL_ACTION_TYPES, expandActionGroup } from "@/lib/change-tracking/taxonomy";

// Reader-tolerant, writer-exhaustive validation (Lane 3 R-L7): garbage
// actionType/entityType/actionGroup is a clean 400 (was silently-empty before —
// the route cast unvalidated strings straight into the where clause). The
// grouped filter (ACTION_GROUPS) expands server-side to an actionType-IN set.
const ACTION_TYPE_SET = new Set<string>(ALL_ACTION_TYPES);

// EntityType is a compile-time union in lib/change-tracking with no runtime list;
// mirror it here for validation (garbage -> 400).
const ENTITY_TYPES: readonly EntityType[] = [
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

// Input validation schema
const auditLogQuerySchema = z.object({
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
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  // Parse query parameters
  const { searchParams } = new URL(request.url);
  const queryParams = Object.fromEntries(searchParams.entries());

  // Validate query parameters
  const validationResult = auditLogQuerySchema.safeParse(queryParams);
  if (!validationResult.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: validationResult.error.errors },
      { status: 400 }
    );
  }

  const { actionGroup, ...filters } = validationResult.data;

  // actionGroup expands to an `actionType IN (members)` filter (R-L7) that
  // getAuditLogs' scalar `actionType` signature cannot express, so this ONE
  // case queries prisma directly with the SAME row shape (include/order/paging)
  // as getAuditLogs. Every other filter combination routes through the shared
  // read helper unchanged. A specific `actionType` (when both are sent) wins,
  // since it is strictly narrower than its group.
  if (actionGroup && !filters.actionType) {
    const members = expandActionGroup(actionGroup)!;
    const where: {
      userId?: number;
      actionType?: { in: AuditActionType[] };
      entityType?: string;
      entityId?: string;
      batchId?: string;
      createdAt?: { gte?: Date; lte?: Date };
    } = { actionType: { in: members } };
    if (filters.userId) where.userId = filters.userId;
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.batchId) where.batchId = filters.batchId;
    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = new Date(filters.startDate);
      if (filters.endDate) where.createdAt.lte = new Date(filters.endDate);
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, username: true, email: true } } },
        orderBy: { createdAt: "desc" },
        take: filters.limit,
        skip: filters.offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return NextResponse.json({ logs, total, limit: filters.limit, offset: filters.offset });
  }

  // Convert date strings to Date objects and cast the validated types.
  const processedFilters = {
    ...filters,
    actionType: filters.actionType as AuditActionType | undefined,
    entityType: filters.entityType as EntityType | undefined,
    startDate: filters.startDate ? new Date(filters.startDate) : undefined,
    endDate: filters.endDate ? new Date(filters.endDate) : undefined,
  };

  // Retrieve audit logs
  const result = await getAuditLogs(processedFilters);

  return NextResponse.json({
    logs: result.logs,
    total: result.total,
    limit: filters.limit,
    offset: filters.offset,
  });
});
