import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireApproved();

    const searchParams = request.nextUrl.searchParams;
    const page = Number(searchParams.get("page") ?? "1") || 1;
    const pageSize = Number(searchParams.get("pageSize") ?? "20") || 20;

    const limit = Math.max(1, Math.min(pageSize, 50));
    const offset = (Math.max(page, 1) - 1) * limit;

    const { logs, total } = await auditService.getAuditLogs({
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
      };
    });

    return NextResponse.json({
      transfers,
      total,
      page,
      pageSize: limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Error fetching transfer logs:", error);
    return NextResponse.json({ error: "Failed to fetch transfer logs" }, { status: 500 });
  }
}
