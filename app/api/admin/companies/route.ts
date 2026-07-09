import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { CompanyInputSchema } from "@/lib/validation/companies";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/companies
 * List all companies (admin only)
 */
export const GET = apiHandler(async (_request: NextRequest) => {
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
});

/**
 * POST /api/admin/companies
 * Create new company
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  const { name, slug } = CompanyInputSchema.parse(body);

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

  // Ensure the creating admin is associated with the new company
  await prisma.userCompany.create({
    data: {
      userId: user.id,
      companyId: company.id,
    },
  });

  return NextResponse.json({ company }, { status: 201 });
});
