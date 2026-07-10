import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { Prisma, inventory_logs_logType } from "@prisma/client";
import { z } from "zod";

export const dynamic = "force-dynamic";

// Query-string validation: bad values surface as 400 via apiHandler's ZodError map.
const LogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  productId: z.coerce.number().int().optional(),
  locationId: z.coerce.number().int().optional(),
  userId: z.coerce.number().int().optional(),
  logType: z.nativeEnum(inventory_logs_logType).optional(),
  batchId: z.string().uuid().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const query = LogsQuerySchema.parse(
    Object.fromEntries(request.nextUrl.searchParams)
  );

  // Pagination
  const { page, pageSize } = query;
  const skip = (page - 1) * pageSize;

  // Build where clause
  const where: Prisma.inventory_logsWhereInput = {};

  if (query.productId) where.productId = query.productId;
  if (query.locationId) where.locationId = query.locationId;
  if (query.userId) where.userId = query.userId;
  if (query.logType) where.logType = query.logType;
  // Phase C (P-C1) join consumer: filter a ledger row set by its operation batchId.
  if (query.batchId) where.batchId = query.batchId;

  if (query.startDate || query.endDate) {
    where.changeTime = {};
    if (query.startDate) where.changeTime.gte = query.startDate;
    if (query.endDate) where.changeTime.lte = query.endDate;
  }

  // Run count and data queries in parallel
  const [total, logs] = await Promise.all([
    prisma.inventory_logs.count({ where }),
    prisma.inventory_logs.findMany({
      where,
      include: {
        users: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
        products: {
          select: {
            id: true,
            name: true,
            baseName: true,
            variant: true,
          },
        },
        locations: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        changeTime: "desc",
      },
      skip,
      take: pageSize,
    }),
  ]);

  const response = {
    logs,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };

  return NextResponse.json(response);
});
