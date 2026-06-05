import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/companies/user
 * Get all companies associated with the current user.
 *
 * Optional query param `?membershipsOnly=1` (ADDITIVE; default off): when set, returns ONLY
 * the caller's actual memberships and SKIPS the admin-sees-all convenience branch. This lets
 * the analytics company-scope picker (ER-D3) equal the rollup source: the omit-companyId
 * "all my companies" total is a memberships-only sum, so a zero-membership admin must see an
 * empty list and pick companies explicitly. The default (flag absent) behavior is UNCHANGED,
 * so the orders page (which also uses this route via useUserCompanies) is unaffected.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const membershipsOnly = request.nextUrl.searchParams.get("membershipsOnly") === "1";

  // Fetch user's company IDs
  const userCompanies = await prisma.userCompany.findMany({
    where: {
      userId: user.id,
    },
    select: { companyId: true },
  });

  const companyIds = userCompanies.map((uc) => uc.companyId);

  const baseSelect = {
    id: true,
    name: true,
    slug: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  let companies =
    companyIds.length > 0
      ? await prisma.company.findMany({
          where: { id: { in: companyIds } },
          select: baseSelect,
          orderBy: { name: "asc" },
        })
      : [];

  // Admin convenience: if the user has no company memberships, return all companies so they can recover.
  // Suppressed when membershipsOnly is set (ER-D3): the analytics picker must equal the rollup source.
  if (!membershipsOnly && companies.length === 0 && user.isAdmin) {
    companies = await prisma.company.findMany({
      select: baseSelect,
      orderBy: { name: "asc" },
    });
  }

  return NextResponse.json({ companies });
});
