import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/companies/user
 * Get all companies associated with the current user
 */
export async function GET() {
  try {
    const { user } = await requireApproved();

    // Fetch user's company IDs (avoid including required relations which can error if referential integrity is broken)
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
    if (companies.length === 0 && user.isAdmin) {
      companies = await prisma.company.findMany({
        select: baseSelect,
        orderBy: { name: "asc" },
      });
    }

    return NextResponse.json({ companies });
  } catch (error) {
    console.error("Error fetching user companies:", error);
    return NextResponse.json(
      { error: "Failed to fetch user companies" },
      { status: 500 }
    );
  }
}
