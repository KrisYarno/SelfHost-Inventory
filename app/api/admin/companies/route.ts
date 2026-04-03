import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/companies
 * List all companies (admin only)
 */
export async function GET(_request: NextRequest) {
  try {
    await requireAdmin();

    // Fetch all companies with user and integration counts
    const companies = await prisma.company.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            users: true,
            integrations: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json({ companies });
  } catch (error) {
    console.error("Error fetching companies:", error);
    return NextResponse.json(
      { error: "Failed to fetch companies" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/companies
 * Create new company
 */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAdmin();

    const body = await request.json();
    const { name, slug } = body;

    // Validate input
    if (!name || !slug) {
      return NextResponse.json(
        { error: "Name and slug are required" },
        { status: 400 }
      );
    }

    // Validate slug format (alphanumeric and hyphens only)
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return NextResponse.json(
        { error: "Slug must contain only lowercase letters, numbers, and hyphens" },
        { status: 400 }
      );
    }

    // Check if slug already exists
    const existing = await prisma.company.findUnique({
      where: { slug },
    });

    if (existing) {
      return NextResponse.json(
        { error: "A company with this slug already exists" },
        { status: 409 }
      );
    }

    // Create company
    const company = await prisma.company.create({
      data: { name, slug },
    });

    // Ensure the creating admin is associated with the new company (prevents lockout if they delete their previous/default company).
    await prisma.userCompany.create({
      data: {
        userId: user.id,
        companyId: company.id,
      },
    });

    return NextResponse.json({ company }, { status: 201 });
  } catch (error) {
    console.error("Error creating company:", error);
    return NextResponse.json(
      { error: "Failed to create company" },
      { status: 500 }
    );
  }
}
