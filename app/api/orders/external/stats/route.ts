import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCompanyMembership } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const companyId = searchParams.get("companyId");
  const platform = searchParams.get("platform");

  // Amendment 9: Verify company membership
  let companyIds: string[];

  if (companyId) {
    // If companyId provided, verify user belongs to that company. S6: anti-enumeration
    // 404 (not 403) so the response doesn't leak whether the company exists.
    await requireCompanyMembership(user.id, companyId, user.isAdmin);
    companyIds = [companyId];
  } else {
    // Scope to user's companies
    const userCompanies = await prisma.userCompany.findMany({
      where: { userId: user.id },
      select: { companyId: true },
    });
    companyIds = userCompanies.map((uc: { companyId: string }) => uc.companyId);

    if (companyIds.length === 0) {
      return NextResponse.json({
        total: 0,
        pending: 0,
        processing: 0,
        fulfilled: 0,
        cancelled: 0,
      });
    }
  }

  // Build where clause
  const where: any = {
    companyId: { in: companyIds },
  };

  if (platform) {
    where.integration = { platform };
  }

  // Get counts grouped by internalStatus
  const groups = await prisma.externalOrder.groupBy({
    by: ["internalStatus"],
    where,
    _count: { _all: true },
  });

  // Build response matching useOrderStats expected shape
  const counts: Record<string, number> = {
    pending: 0,
    processing: 0,
    fulfilled: 0,
    cancelled: 0,
  };

  let total = 0;
  for (const group of groups) {
    const status = group.internalStatus;
    const count = group._count._all;
    if (status in counts) {
      counts[status] = count;
    }
    total += count;
  }

  return NextResponse.json({
    total,
    pending: counts.pending,
    processing: counts.processing,
    fulfilled: counts.fulfilled,
    cancelled: counts.cancelled,
  });
});
