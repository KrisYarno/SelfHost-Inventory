import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getAuditLogs } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const page = Number(searchParams.get("page") ?? "1") || 1;
  const pageSize = Number(searchParams.get("pageSize") ?? "20") || 20;

  const limit = Math.max(1, Math.min(pageSize, 50));
  const offset = (Math.max(page, 1) - 1) * limit;

  const { logs, total } = await getAuditLogs({
    actionType: "INVENTORY_TRANSFER",
    entityType: "INVENTORY",
    limit,
    offset,
  });

  const transfers = logs.map((log: any) => {
    const details = (log.details ?? {}) as any;
    return {
      id: log.id,
      createdAt: log.createdAt,
      productName: details.productName ?? log.action,
      quantity: details.quantity ?? null,
      fromLocationName: details.fromLocationName ?? "",
      toLocationName: details.toLocationName ?? "",
      userName: log.user?.username ?? log.user?.email ?? "Unknown user",
      batchId: log.batchId,
      // Phase C (P-C7): the precise leg-pair key, surfaced from the event details.
      transferId: details.transferId ?? null,
    };
  });

  return NextResponse.json({
    transfers,
    total,
    page,
    pageSize: limit,
    totalPages: Math.ceil(total / limit),
  });
});
