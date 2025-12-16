import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/companies/user
 * Get all companies associated with the current user
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch user's companies
    const userCompanies = await prisma.userCompany.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            slug: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: {
        company: {
          name: "asc",
        },
      },
    });

    const companies = userCompanies.map((uc) => uc.company);

    return NextResponse.json({ companies });
  } catch (error) {
    console.error("Error fetching user companies:", error);
    return NextResponse.json(
      { error: "Failed to fetch user companies" },
      { status: 500 }
    );
  }
}
